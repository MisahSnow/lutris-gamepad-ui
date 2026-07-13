const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getMainWindow, addWhitelistedFile } = require("./state.cjs");
const { execFilePromise, logInfo } = require("./utils.cjs");

const HYPRLAND_ADDRESS_REGEX = /^0x[\da-f]+$/i;
const HYPRLAND_STATE_WAIT_TIMEOUT_MS = 1200;
const HYPRLAND_STATE_WAIT_INTERVAL_MS = 100;
const ICON_EXTENSIONS = [".png", ".svg", ".xpm", ".webp", ".ico"];
const ICON_CONTEXT_DIRECTORIES = [
  "apps",
  "devices",
  "places",
  "categories",
  "mimetypes",
  "status",
];
const ICON_SIZE_DIRECTORIES = [
  "512x512",
  "256x256",
  "128x128",
  "96x96",
  "64x64",
  "48x48",
  "32x32",
  "24x24",
  "22x22",
  "16x16",
  "scalable",
  "symbolic",
];
const GENERIC_IDENTIFIER_PARTS = new Set([
  "app",
  "application",
  "bin",
  "default",
  "desktop",
  "do",
  "not",
  "run",
  "directly",
  "linux",
  "usr",
]);

let desktopEntriesCache = null;
const iconPathCache = new Map();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getXdgDataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
}

function getXdgDataDirectories() {
  const configuredDirectories =
    process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share";

  return uniqueStrings([
    getXdgDataHome(),
    ...configuredDirectories.split(":").filter(Boolean),
    path.join(os.homedir(), ".local/share/flatpak/exports/share"),
    "/var/lib/flatpak/exports/share",
  ]);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeIdentifier(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  let basename = path.basename(value);
  const extension = path.extname(basename).toLowerCase();

  if (basename.endsWith(".desktop")) {
    basename = basename.slice(0, -".desktop".length);
  } else if (ICON_EXTENSIONS.includes(extension)) {
    basename = basename.slice(0, -extension.length);
  }

  return basename
    .toLowerCase()
    .replaceAll(/[^a-z\d]+/g, "");
}

function splitIdentifierParts(value) {
  if (!value || typeof value !== "string") {
    return [];
  }

  return value
    .toLowerCase()
    .split(/[^a-z\d]+/g)
    .filter((part) => part.length > 2 && !GENERIC_IDENTIFIER_PARTS.has(part));
}

function stripDesktopFieldCodes(value) {
  return value.replaceAll(/%[a-zA-Z]/g, "").trim();
}

function splitCommand(command) {
  const result = [];
  const regex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match;

  while ((match = regex.exec(command))) {
    result.push(match[1] || match[2] || match[3]);
  }

  return result;
}

function getExecutableToken(command) {
  const tokens = splitCommand(stripDesktopFieldCodes(command));

  for (const token of tokens) {
    if (token === "env" || /^[A-Z_][A-Z\d_]*=/i.test(token)) {
      continue;
    }

    return token;
  }

  return null;
}

function getExecutableBasename(command) {
  const executable = getExecutableToken(command);
  return executable ? path.basename(executable) : null;
}

function parseDesktopEntry(filePath) {
  let text;

  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const fields = {};
  let currentSection = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    if (currentSection !== "Desktop Entry") {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    if (key.includes("[")) {
      continue;
    }

    fields[key] = line.slice(separatorIndex + 1);
  }

  if (!fields.Name && !fields.Exec && !fields.Icon && !fields.StartupWMClass) {
    return null;
  }

  const id = path.basename(filePath, ".desktop");
  const execBasename = fields.Exec ? getExecutableBasename(fields.Exec) : null;

  return {
    filePath,
    id,
    name: fields.Name || null,
    exec: fields.Exec || null,
    execBasename,
    icon: fields.Icon || null,
    startupWMClass: fields.StartupWMClass || null,
  };
}

function collectDesktopEntryFiles(directory, result = []) {
  let entries;

  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      collectDesktopEntryFiles(entryPath, result);
    } else if (entry.isFile() && entry.name.endsWith(".desktop")) {
      result.push(entryPath);
    }
  }

  return result;
}

function getDesktopEntries() {
  if (desktopEntriesCache) {
    return desktopEntriesCache;
  }

  desktopEntriesCache = getXdgDataDirectories()
    .flatMap((directory) =>
      collectDesktopEntryFiles(path.join(directory, "applications")),
    )
    .map((filePath) => parseDesktopEntry(filePath))
    .filter(Boolean);

  return desktopEntriesCache;
}

function getCommandMatchTokens(cmdline) {
  const result = [];

  for (const token of cmdline) {
    const tokenParts = [token, path.basename(token)];

    if (path.isAbsolute(token)) {
      tokenParts.push(path.basename(path.dirname(token)));
    }

    result.push(...tokenParts);
  }

  return uniqueStrings(result);
}

function getDesktopEntryScore(entry, metadata) {
  const classTokens = uniqueStrings([
    metadata.windowClass,
    metadata.initialClass,
  ]).map((token) => normalizeIdentifier(token));
  const commandTokens = getCommandMatchTokens(metadata.cmdline).map((token) =>
    normalizeIdentifier(token),
  );
  const titleParts = splitIdentifierParts(metadata.title);
  const classParts = uniqueStrings([
    ...splitIdentifierParts(metadata.windowClass),
    ...splitIdentifierParts(metadata.initialClass),
  ]);
  const entryId = normalizeIdentifier(entry.id);
  const entryName = normalizeIdentifier(entry.name);
  const entryStartupWMClass = normalizeIdentifier(entry.startupWMClass);
  const entryExec = normalizeIdentifier(entry.execBasename);
  const entryIcon = normalizeIdentifier(entry.icon);

  let score = 0;

  for (const classToken of classTokens) {
    if (!classToken) {
      continue;
    }

    if (classToken === entryStartupWMClass) score = Math.max(score, 120);
    if (classToken === entryId) score = Math.max(score, 110);
    if (classToken === entryExec) score = Math.max(score, 95);
    if (classToken === entryIcon) score = Math.max(score, 90);
    if (
      entryId.length > 3 &&
      (classToken.includes(entryId) || entryId.includes(classToken))
    ) {
      score = Math.max(score, 70);
    }
  }

  for (const commandToken of commandTokens) {
    if (!commandToken) {
      continue;
    }

    if (commandToken === entryExec) score = Math.max(score, 100);
    if (commandToken === entryId) score = Math.max(score, 90);
    if (commandToken === entryIcon) score = Math.max(score, 85);
  }

  for (const part of classParts) {
    const normalizedPart = normalizeIdentifier(part);
    if (!normalizedPart) {
      continue;
    }

    if (normalizedPart === entryId) score = Math.max(score, 80);
    if (normalizedPart === entryExec) score = Math.max(score, 75);
    if (normalizedPart === entryIcon) score = Math.max(score, 70);
  }

  for (const part of titleParts) {
    const normalizedPart = normalizeIdentifier(part);
    if (normalizedPart && normalizedPart === entryId) {
      score = Math.max(score, 45);
    }
  }

  if (
    entryName.length > 3 &&
    normalizeIdentifier(metadata.title).includes(entryName)
  ) {
    score = Math.max(score, 35);
  }

  return score;
}

function findDesktopEntryForApp(metadata) {
  let bestEntry = null;
  let bestScore = 0;

  for (const entry of getDesktopEntries()) {
    const score = getDesktopEntryScore(entry, metadata);

    if (score > bestScore) {
      bestEntry = entry;
      bestScore = score;
    }
  }

  return bestScore > 0 ? bestEntry : null;
}

function getIconFilenames(iconName) {
  const basename = path.basename(iconName);
  const extension = path.extname(basename);

  if (ICON_EXTENSIONS.includes(extension.toLowerCase())) {
    return [basename];
  }

  return ICON_EXTENSIONS.map((iconExtension) => `${basename}${iconExtension}`);
}

function getIconThemeDirectories(iconRoot) {
  let entries;
  try {
    entries = fs.readdirSync(iconRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const themeNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  return uniqueStrings(["hicolor", ...themeNames]).map((themeName) =>
    path.join(iconRoot, themeName),
  );
}

function getIconSearchCandidates(iconName) {
  const filenames = getIconFilenames(iconName);
  const dataDirectories = getXdgDataDirectories();
  const iconRoots = uniqueStrings([
    path.join(os.homedir(), ".icons"),
    ...dataDirectories.map((directory) => path.join(directory, "icons")),
  ]);
  const candidates = [];

  for (const dataDirectory of dataDirectories) {
    for (const filename of filenames) {
      candidates.push(path.join(dataDirectory, "pixmaps", filename));
    }
  }

  for (const iconRoot of iconRoots) {
    for (const filename of filenames) {
      candidates.push(path.join(iconRoot, filename));
    }

    for (const themeDirectory of getIconThemeDirectories(iconRoot)) {
      for (const sizeDirectory of ICON_SIZE_DIRECTORIES) {
        for (const contextDirectory of ICON_CONTEXT_DIRECTORIES) {
          for (const filename of filenames) {
            candidates.push(
              path.join(
                themeDirectory,
                sizeDirectory,
                contextDirectory,
                filename,
              ),
            );
          }
        }
      }
    }
  }

  return candidates;
}

function resolveIconPath(iconName) {
  if (!iconName || typeof iconName !== "string") {
    return null;
  }

  if (iconPathCache.has(iconName)) {
    return iconPathCache.get(iconName);
  }

  const result = path.isAbsolute(iconName)
    ? (() => {
        const extension = path.extname(iconName).toLowerCase();
        return (
          ICON_EXTENSIONS.includes(extension) && fs.existsSync(iconName)
            ? path.resolve(iconName)
            : null
        );
      })()
    : getIconSearchCandidates(iconName).find((candidate) =>
        fs.existsSync(candidate),
      ) || null;

  iconPathCache.set(iconName, result);
  return result;
}

function getAppIconCandidates(metadata, desktopEntry) {
  return uniqueStrings([
    desktopEntry?.icon,
    desktopEntry?.id,
    desktopEntry?.execBasename,
    metadata.windowClass,
    metadata.initialClass,
    ...splitIdentifierParts(metadata.windowClass),
    ...splitIdentifierParts(metadata.initialClass),
    ...getCommandMatchTokens(metadata.cmdline),
  ]);
}

function resolveAppIconPath(metadata) {
  const desktopEntry = findDesktopEntryForApp(metadata);

  for (const candidate of getAppIconCandidates(metadata, desktopEntry)) {
    const iconPath = resolveIconPath(candidate);

    if (iconPath) {
      return iconPath;
    }
  }

  return null;
}

function parseStatus(statusText) {
  const result = {};

  for (const line of statusText.split("\n")) {
    const [key, ...valueParts] = line.split(":");
    if (key && valueParts.length > 0) {
      result[key] = valueParts.join(":").trim();
    }
  }

  return result;
}

function readProcFile(pid, filename) {
  return fs.readFileSync(path.join("/proc", String(pid), filename), "utf8");
}

function readCommandLine(pid) {
  try {
    const cmdline = readProcFile(pid, "cmdline").split("\0").filter(Boolean);

    return cmdline;
  } catch {
    return [];
  }
}

function getProcessParentPid(pid) {
  try {
    const status = parseStatus(readProcFile(pid, "status"));
    return Number(status.PPid) || null;
  } catch {
    return null;
  }
}

function getProcessAncestors(pid) {
  const result = [];
  let currentPid = pid;

  while (currentPid && currentPid > 1) {
    const parentPid = getProcessParentPid(currentPid);
    if (!parentPid || result.includes(parentPid)) {
      break;
    }

    result.push(parentPid);
    currentPid = parentPid;
  }

  return result;
}

function validatePid(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("Invalid pid");
  }
}

function validateHyprlandAddress(address) {
  if (
    typeof address !== "string" ||
    !HYPRLAND_ADDRESS_REGEX.test(address.trim())
  ) {
    throw new TypeError("Invalid Hyprland window address");
  }
}

function getProtectedPids() {
  // Descendants may be Kodi, frontends, or games launched by this app.
  // Electron-owned child processes are filtered separately by command line.
  return new Set([process.pid, ...getProcessAncestors(process.pid)]);
}

function getProcessLabel(pid, statusName, cmdline) {
  const executable = cmdline[0];
  if (!executable) {
    return statusName || `Process ${pid}`;
  }

  return path.basename(executable);
}

function isCurrentAppProcess(pid, cmdline) {
  if (pid === process.pid) {
    return true;
  }

  const commandText = cmdline.join(" ");
  return (
    commandText.includes("lutris-bigscreen") ||
    commandText.includes("lutris-gamepad-ui") ||
    commandText.includes("electron.cjs")
  );
}

function readCandidateProcess(
  pid,
  protectedPids,
  currentUid,
  {
    title = null,
    windowAddress = null,
    workspace = null,
    fullscreen = 0,
    windowClass = null,
    initialClass = null,
  } = {},
) {
  if (protectedPids.has(pid)) {
    return null;
  }

  let status;

  try {
    status = parseStatus(readProcFile(pid, "status"));
  } catch {
    return null;
  }

  const uid = Number(status.Uid?.split(/\s+/)[0]);
  if (uid !== currentUid || status.State?.startsWith("Z")) {
    return null;
  }

  const cmdline = readCommandLine(pid);
  if (isCurrentAppProcess(pid, cmdline)) {
    return null;
  }

  const iconPath = resolveAppIconPath({
    title,
    windowClass,
    initialClass,
    cmdline,
  });

  if (iconPath) {
    addWhitelistedFile(iconPath);
  }

  return {
    pid,
    ppid: Number(status.PPid) || 0,
    name: title || getProcessLabel(pid, status.Name, cmdline),
    command: cmdline.join(" "),
    iconPath,
    windowAddress,
    workspace,
    fullscreen,
  };
}

function uniqueAppsByPid(apps) {
  const seenPids = new Set();
  const result = [];

  for (const app of apps) {
    if (seenPids.has(app.pid)) {
      continue;
    }

    seenPids.add(app.pid);
    result.push(app);
  }

  return result;
}

async function getHyprlandClients() {
  const { stdout } = await execFilePromise("hyprctl", ["clients", "-j"]);
  const clients = JSON.parse(stdout);

  if (!Array.isArray(clients)) {
    return [];
  }

  return clients;
}

function isSameHyprlandAddress(leftAddress, rightAddress) {
  return (
    typeof leftAddress === "string" &&
    typeof rightAddress === "string" &&
    leftAddress.toLowerCase() === rightAddress.toLowerCase()
  );
}

async function getHyprlandClientByAddress(address) {
  const clients = await getHyprlandClients();
  return clients.find((client) =>
    isSameHyprlandAddress(client.address, address),
  );
}

async function getActiveHyprlandWindowAddress() {
  const { stdout } = await execFilePromise("hyprctl", ["activewindow", "-j"]);
  const activeWindow = JSON.parse(stdout);
  return activeWindow?.address || null;
}

async function getActiveHyprlandWorkspaceName() {
  const { stdout } = await execFilePromise("hyprctl", [
    "activeworkspace",
    "-j",
  ]);
  const activeWorkspace = JSON.parse(stdout);
  const workspaceName =
    activeWorkspace?.name ||
    (Number.isInteger(activeWorkspace?.id) ? String(activeWorkspace.id) : null);

  if (!workspaceName) {
    throw new Error("Unable to determine active Hyprland workspace");
  }

  return workspaceName;
}

async function dispatchHyprland(dispatcher, ...arguments_) {
  const args = ["dispatch", dispatcher];
  for (const argument of arguments_) {
    if (argument) {
      args.push(argument);
    }
  }

  await execFilePromise("hyprctl", args);
}

async function dispatchHyprlandLua(luaDispatcher) {
  await execFilePromise("hyprctl", ["dispatch", luaDispatcher]);
}

function quoteLuaString(value) {
  return JSON.stringify(String(value));
}

async function waitForHyprlandState(checkState, errorMessage) {
  const startTime = Date.now();

  while (Date.now() - startTime < HYPRLAND_STATE_WAIT_TIMEOUT_MS) {
    if (await checkState()) {
      return;
    }

    await wait(HYPRLAND_STATE_WAIT_INTERVAL_MS);
  }

  throw new Error(errorMessage);
}

function getHyprlandWindowSelector(app) {
  validateHyprlandAddress(app.windowAddress);
  return `address:${app.windowAddress}`;
}

function isClientOnWorkspace(client, workspaceName) {
  return (
    client?.workspace?.name === workspaceName ||
    String(client?.workspace?.id) === workspaceName
  );
}

async function listHyprlandUserApps(protectedPids, currentUid) {
  const clients = await getHyprlandClients();

  return uniqueAppsByPid(
    clients
      .map((client) => {
        const pid = Number(client.pid);
        if (!pid || !client.address) {
          return null;
        }

        return readCandidateProcess(pid, protectedPids, currentUid, {
          title: client.title || client.class || null,
          windowAddress: client.address,
          workspace: client.workspace || null,
          fullscreen: client.fullscreen || 0,
          windowClass: client.class || null,
          initialClass: client.initialClass || null,
        });
      })
      .filter(Boolean),
  );
}

async function listRunningUserApps() {
  const currentUid = process.getuid?.();
  if (typeof currentUid !== "number") {
    return [];
  }

  const protectedPids = getProtectedPids();

  const apps = await listHyprlandUserApps(protectedPids, currentUid);

  return apps
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(({ ppid: _ppid, ...app }) => app);
}

async function findRunningUserApp(pid, windowAddress = null) {
  validatePid(pid);
  if (windowAddress) {
    validateHyprlandAddress(windowAddress);
  }

  const apps = await listRunningUserApps();
  const app = apps.find(
    (candidate) =>
      candidate.pid === pid &&
      (!windowAddress || candidate.windowAddress === windowAddress),
  );

  if (!app) {
    throw new Error("Process is not a closeable user app");
  }

  return app;
}

async function focusRunningUserApp(pid, windowAddress) {
  const app = await findRunningUserApp(pid, windowAddress);
  const windowSelector = getHyprlandWindowSelector(app);
  const workspaceName = await getActiveHyprlandWorkspaceName();
  const luaWindowSelector = quoteLuaString(windowSelector);
  const luaWorkspaceName = /^\d+$/.test(workspaceName)
    ? workspaceName
    : quoteLuaString(workspaceName);

  logInfo("Moving and focusing Hyprland user app window", pid, app.name);
  await dispatchHyprlandLua(
    `hl.dsp.window.move({ workspace = ${luaWorkspaceName}, window = ${luaWindowSelector} })`,
  );
  await waitForHyprlandState(async () => {
    const client = await getHyprlandClientByAddress(app.windowAddress);
    return isClientOnWorkspace(client, workspaceName);
  }, `Hyprland did not move ${app.name} to workspace ${workspaceName}`);

  await dispatchHyprlandLua(`hl.dsp.focus({ workspace = ${luaWorkspaceName} })`);
  await waitForHyprlandState(async () => {
    const activeWorkspaceName = await getActiveHyprlandWorkspaceName();
    return activeWorkspaceName === workspaceName;
  }, `Hyprland did not switch to workspace ${workspaceName}`);

  await dispatchHyprlandLua(`hl.dsp.focus({ window = ${luaWindowSelector} })`);
  await waitForHyprlandState(async () => {
    const activeAddress = await getActiveHyprlandWindowAddress();
    return isSameHyprlandAddress(activeAddress, app.windowAddress);
  }, `Hyprland did not focus ${app.name}`);

  await dispatchHyprlandLua(
    `hl.dsp.window.fullscreen_state({ internal = 2, client = 2, action = "set", window = ${luaWindowSelector} })`,
  );

  await waitForHyprlandState(async () => {
    const client = await getHyprlandClientByAddress(app.windowAddress);
    return Boolean(client?.fullscreen || client?.fullscreenClient);
  }, `Hyprland did not fullscreen ${app.name}`);

  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
    mainWindow.minimize();
  }
}

async function closeRunningUserApp(pid, windowAddress) {
  const app = await findRunningUserApp(pid, windowAddress);
  const windowSelector = getHyprlandWindowSelector(app);

  logInfo("Closing Hyprland user app window", pid, app.name);
  await dispatchHyprland("closewindow", windowSelector);

  await wait(500);
  const remainingClients = await getHyprlandClients();
  const isStillOpen = remainingClients.some(
    (client) => client.address === app.windowAddress,
  );

  if (!isStillOpen) {
    return;
  }

  logInfo("Hyprland close did not remove window, terminating pid", pid);
  logInfo("Closing user app pid", pid, app.name);
  process.kill(pid, "SIGTERM");
}

module.exports = {
  listRunningUserApps,
  focusRunningUserApp,
  closeRunningUserApp,
};
