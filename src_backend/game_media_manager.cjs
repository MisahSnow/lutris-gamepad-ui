const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { app } = require("electron");

const { getRunExclusive, logInfo, logWarn } = require("./utils.cjs");

const STEAM_SEARCH_URL = "https://store.steampowered.com/api/storesearch/";
const STEAM_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const FETCH_TIMEOUT_MS = 6000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MISS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const lookupExclusive = getRunExclusive();
const inflightLookups = new Map();

function normalizeGameTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replaceAll(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replaceAll("&", " and ")
    .replaceAll(/[’']/g, "")
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function getCacheKey(title, steamAppId) {
  if (steamAppId) {
    return `steam-${steamAppId}`;
  }

  return `title-${createHash("sha256")
    .update(normalizeGameTitle(title))
    .digest("hex")
    .slice(0, 24)}`;
}

function getCachePaths(cacheKey) {
  const cacheDirectory = path.join(app.getPath("userData"), "hero-images");
  return {
    cacheDirectory,
    imagePath: path.join(cacheDirectory, `${cacheKey}.jpg`),
    missPath: path.join(cacheDirectory, `${cacheKey}.miss`),
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isFreshMiss(missPath) {
  try {
    const stats = await fs.stat(missPath);
    return Date.now() - stats.mtimeMs < MISS_CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: { Accept: "application/json, image/jpeg" },
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Steam request failed with status ${response.status}`);
  }
  return await response.json();
}

async function searchSteamAppId(title) {
  const normalizedTitle = normalizeGameTitle(title);
  if (!normalizedTitle) {
    return null;
  }

  const searchUrl = new URL(STEAM_SEARCH_URL);
  searchUrl.searchParams.set("term", title.slice(0, 160));
  searchUrl.searchParams.set("l", "english");
  searchUrl.searchParams.set("cc", "US");

  const result = await fetchJson(searchUrl);
  const matches = (result.items || []).filter(
    (item) =>
      item.type === "app" &&
      Number.isInteger(item.id) &&
      normalizeGameTitle(item.name) === normalizedTitle,
  );

  return matches.length === 1 ? matches[0].id : null;
}

function getSteamScreenshotUrl(details, expectedTitle, hasTrustedAppId) {
  if (!details || details.type !== "game") {
    return null;
  }

  if (
    !hasTrustedAppId &&
    normalizeGameTitle(details.name) !== normalizeGameTitle(expectedTitle)
  ) {
    return null;
  }

  const screenshotUrl = details.screenshots?.find(
    (screenshot) => typeof screenshot.path_full === "string",
  )?.path_full;

  if (!screenshotUrl) {
    return null;
  }

  const parsedUrl = new URL(screenshotUrl);
  const isSteamCdn =
    parsedUrl.protocol === "https:" &&
    (parsedUrl.hostname === "steamstatic.com" ||
      parsedUrl.hostname.endsWith(".steamstatic.com"));

  return isSteamCdn ? parsedUrl : null;
}

async function resolveSteamScreenshot(title, trustedSteamAppId) {
  const steamAppId = trustedSteamAppId || (await searchSteamAppId(title));
  if (!steamAppId) {
    return null;
  }

  const detailsUrl = new URL(STEAM_DETAILS_URL);
  detailsUrl.searchParams.set("appids", String(steamAppId));
  detailsUrl.searchParams.set("l", "english");
  detailsUrl.searchParams.set("cc", "US");

  const result = await fetchJson(detailsUrl);
  const appResult = result[String(steamAppId)];
  if (!appResult?.success) {
    return null;
  }

  const screenshotUrl = getSteamScreenshotUrl(
    appResult.data,
    title,
    !!trustedSteamAppId,
  );

  return screenshotUrl ? { screenshotUrl, steamAppId } : null;
}

async function downloadScreenshot(screenshotUrl, destinationPath) {
  const response = await fetchWithTimeout(screenshotUrl);
  if (!response.ok) {
    throw new Error(
      `Steam image request failed with status ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/jpeg")) {
    throw new Error(`Steam returned unsupported media type: ${contentType}`);
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());
  if (imageBuffer.length === 0 || imageBuffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Steam image size is invalid: ${imageBuffer.length}`);
  }

  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, imageBuffer, { mode: 0o600 });
  await fs.rename(temporaryPath, destinationPath);
}

async function lookupAndCacheHeroImage(title, trustedSteamAppId, cachePaths) {
  const match = await resolveSteamScreenshot(title, trustedSteamAppId);
  if (!match) {
    await fs.writeFile(cachePaths.missPath, new Date().toISOString(), {
      mode: 0o600,
    });
    return null;
  }

  await downloadScreenshot(match.screenshotUrl, cachePaths.imagePath);
  await fs.rm(cachePaths.missPath, { force: true });
  logInfo(
    "cached Steam hero screenshot for",
    title,
    "using app",
    match.steamAppId,
  );
  return cachePaths.imagePath;
}

async function getHeroImageForGame({ title, steamAppId = null }) {
  const normalizedTitle = normalizeGameTitle(title);
  if (!normalizedTitle) {
    return null;
  }

  const trustedSteamAppId = Number.isInteger(steamAppId) ? steamAppId : null;
  const cacheKey = getCacheKey(title, trustedSteamAppId);
  const cachePaths = getCachePaths(cacheKey);

  if (await pathExists(cachePaths.imagePath)) {
    return cachePaths.imagePath;
  }
  if (await isFreshMiss(cachePaths.missPath)) {
    return null;
  }
  if (inflightLookups.has(cacheKey)) {
    return await inflightLookups.get(cacheKey);
  }

  const lookupPromise = lookupExclusive(async () => {
    await fs.mkdir(cachePaths.cacheDirectory, { recursive: true, mode: 0o700 });

    if (await pathExists(cachePaths.imagePath)) {
      return cachePaths.imagePath;
    }

    try {
      return await lookupAndCacheHeroImage(
        title,
        trustedSteamAppId,
        cachePaths,
      );
    } catch (error) {
      logWarn("unable to fetch Steam hero screenshot for", title, error);
      return null;
    }
  }).finally(() => inflightLookups.delete(cacheKey));

  inflightLookups.set(cacheKey, lookupPromise);
  return await lookupPromise;
}

module.exports = { getHeroImageForGame };
