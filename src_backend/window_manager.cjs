const { execFile } = require("node:child_process");
const path = require("node:path");
const url = require("node:url");
const { promisify } = require("node:util");

const {
  BrowserWindow,
  session,
  powerSaveBlocker,
  protocol,
  net,
  app,
} = require("electron");

const {
  getAppConfig,
  subscribeConfigValueChange,
} = require("./config_manager.cjs");
const {
  startRemoteDesktopSession,
  sendAltTab,
  stopRemoteDesktopSession,
} = require("./remote_desktop_manager.cjs");
const {
  setMainWindow,
  getMainWindow,
  getWhitelistedFiles,
  getRemoteDesktopSessionHandle,
} = require("./state.cjs");
const { initializeThemeManager } = require("./theme_manager.cjs");
const { checkForUpdates } = require("./update_checker.cjs");
const {
  isDev,
  forceWindowed,
  overlayMode,
  getElectronPreloadPath,
  logError,
  logWarn,
  debounce,
  logInfo,
  isRunningInsideGamescope,
} = require("./utils.cjs");
const { x11gamescopeToggleFocus } = require("./x11_manager.cjs");

const execFilePromise = promisify(execFile);
let coveredFullscreenWindow = null;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function captureCoveredFullscreenWindow() {
  coveredFullscreenWindow = null;

  if (!overlayMode || process.env.XDG_CURRENT_DESKTOP !== "Hyprland") {
    return;
  }

  try {
    const { stdout } = await execFilePromise("hyprctl", ["activewindow", "-j"]);
    const activeWindow = JSON.parse(stdout);
    const address = String(activeWindow.address || "");
    const internal = Number(activeWindow.fullscreen || 0);
    const client = Number(activeWindow.fullscreenClient || 0);

    if (
      /^0x[\da-f]+$/i.test(address) &&
      Number.isInteger(internal) &&
      Number.isInteger(client) &&
      (internal > 0 || client > 0)
    ) {
      coveredFullscreenWindow = { address, internal, client };
    }
  } catch (error) {
    logWarn("Unable to capture the covered fullscreen window", error);
  }
}

async function restoreCoveredFullscreenWindow(clearAfterRestore = false) {
  const coveredWindow = coveredFullscreenWindow;
  if (!coveredWindow) return;

  try {
    const command =
      "hl.dsp.window.fullscreen_state({ " +
      `internal = ${coveredWindow.internal}, ` +
      `client = ${coveredWindow.client}, ` +
      'action = "set", ' +
      `window = "address:${coveredWindow.address}" })`;
    await execFilePromise("hyprctl", ["dispatch", command]);
  } catch (error) {
    logWarn("Unable to restore the covered fullscreen window", error);
  } finally {
    if (clearAfterRestore) coveredFullscreenWindow = null;
  }
}

async function getHyprlandOverlayClient() {
  const { stdout } = await execFilePromise("hyprctl", ["clients", "-j"]);
  const clients = JSON.parse(stdout);
  return clients.find((client) => client.title === "Lutris Bigscreen") || null;
}

async function isOverlayFocused(mainWindow) {
  if (!overlayMode || process.env.XDG_CURRENT_DESKTOP !== "Hyprland") {
    return mainWindow.isFocused();
  }

  try {
    const { stdout } = await execFilePromise("hyprctl", ["activewindow", "-j"]);
    const activeWindow = JSON.parse(stdout);
    return activeWindow.title === "Lutris Bigscreen";
  } catch (error) {
    logWarn("Unable to determine whether Lutris Bigscreen is focused", error);
    return mainWindow.isFocused();
  }
}

async function raiseHyprlandOverlay({ focus = true } = {}) {
  if (!overlayMode || process.env.XDG_CURRENT_DESKTOP !== "Hyprland") {
    return;
  }

  try {
    let overlayClient = null;
    for (let attempt = 0; attempt < 10 && !overlayClient; attempt += 1) {
      overlayClient = await getHyprlandOverlayClient();
      if (!overlayClient) await wait(50);
    }
    if (!overlayClient) return;

    const address = String(overlayClient.address || "");
    if (!/^0x[\da-f]+$/i.test(address)) return;

    const selector = `address:${address}`;
    const { stdout } = await execFilePromise("hyprctl", [
      "activeworkspace",
      "-j",
    ]);
    const activeWorkspace = JSON.parse(stdout);
    const workspaceName = String(activeWorkspace.name || "");
    const overlayWorkspace = String(overlayClient.workspace?.name || "");

    if (workspaceName && workspaceName !== overlayWorkspace) {
      const workspace = /^\d+$/.test(workspaceName)
        ? workspaceName
        : JSON.stringify(workspaceName);
      await execFilePromise("hyprctl", [
        "dispatch",
        `hl.dsp.window.move({ workspace = ${workspace}, window = "${selector}" })`,
      ]);
    }

    await execFilePromise("hyprctl", [
      "dispatch",
      `hl.dsp.window.alter_zorder({ mode = "top", window = "${selector}" })`,
    ]);

    if (focus) {
      await execFilePromise("hyprctl", [
        "dispatch",
        `hl.dsp.focus({ window = "${selector}" })`,
      ]);
    }
  } catch (error) {
    logWarn("Unable to raise the Lutris Bigscreen overlay", error);
  }
}

async function setWaybarVisible(visible) {
  if (!overlayMode || process.env.XDG_CURRENT_DESKTOP !== "Hyprland") {
    return;
  }

  try {
    await execFilePromise("pkill", [visible ? "-USR2" : "-USR1", "-x", "waybar"]);
  } catch (error) {
    if (error?.code !== 1) {
      logWarn("Unable to change Waybar visibility", error);
    }
  }
}

function getWindowZoomFactor() {
  return getAppConfig().zoomFactor || 1;
}

function setWindowZoomFactor(factor) {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.setZoomFactor(factor || 1);
  }
}

function createSendAltTabDebounced(delayMs) {
  return debounce(() => {
    sendAltTab().catch((error) => {
      logError("unable to send alt+tab using remote desktop portal", error);
    });
  }, delayMs);
}

let sendAltTabDebounced = createSendAltTabDebounced(
  getAppConfig().gamepadAutorepeatMs,
);

subscribeConfigValueChange("gamepadAutorepeatMs", (newValue) => {
  sendAltTabDebounced = createSendAltTabDebounced(newValue);
});

async function toggleWindowShow() {
  const mainWindow = getMainWindow();
  if (!mainWindow) {
    return;
  }

  if (isRunningInsideGamescope()) {
    logInfo("toggleWindowShow: using gamescope");

    const showUp = !mainWindow.isFocused();

    x11gamescopeToggleFocus(showUp).catch((error) => {
      logError("x11gamescopeToggleFocus", error);
    });

    return;
  }

  if (getRemoteDesktopSessionHandle()) {
    logInfo("toggleWindowShow: using remote desktop portal");
    sendAltTabDebounced();
    return;
  }

  logInfo("toggleWindowShow: using fallback");

  if (mainWindow.isVisible() && (await isOverlayFocused(mainWindow))) {
    mainWindow.hide();
    await setWaybarVisible(true);
    await restoreCoveredFullscreenWindow(true);
    return;
  }

  await showWindow();
}

async function showWindow() {
  const mainWindow = getMainWindow();
  if (!mainWindow) {
    return;
  }

  await captureCoveredFullscreenWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  await setWaybarVisible(false);
  mainWindow.show();
  mainWindow.focus();
  await wait(150);
  await raiseHyprlandOverlay();
  await restoreCoveredFullscreenWindow();
  await raiseHyprlandOverlay({ focus: false });
}

function fillSearchParams(searchParams, envPrefix, searchParamPrefix) {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(envPrefix) && v === "1") {
      const flag = k.slice(envPrefix.length);
      searchParams.append(`${searchParamPrefix}_${flag}`, "1");
    }
  }
}

function encodeAppProtocolPath(filePath) {
  const normalizedPath = path.normalize(filePath);

  const encodedPath = normalizedPath
    .split(path.sep)
    .map((pathSegment) => encodeURIComponent(pathSegment))
    .join("/");

  return `app://${encodedPath}`;
}

function getHomePageUrl() {
  const searchParams = new URLSearchParams();
  // Keep the original prefixes as compatibility aliases for existing setups.
  fillSearchParams(searchParams, "LUTRIS_GAMEPAD_UI_ENABLE_", "ENABLE");
  fillSearchParams(searchParams, "LUTRIS_GAMEPAD_UI_DISABLE_", "DISABLE");
  fillSearchParams(searchParams, "LUTRIS_BIGSCREEN_ENABLE_", "ENABLE");
  fillSearchParams(searchParams, "LUTRIS_BIGSCREEN_DISABLE_", "DISABLE");

  const queryString = searchParams.toString();
  const suffix = queryString ? `?${queryString}` : "";

  if (isDev) {
    return "http://localhost:5173" + suffix;
  }

  const mainAppDir = path.join(__dirname, "..");

  const htmlPath = mainAppDir.endsWith("/dist")
    ? path.join(mainAppDir, "index.html")
    : path.join(mainAppDir, "dist/index.html");

  return encodeAppProtocolPath(htmlPath) + suffix;
}

function getRequestedAppPath(requestedUrl) {
  const rawPath = requestedUrl.host
    ? `${path.sep}${requestedUrl.host}${requestedUrl.pathname}`
    : requestedUrl.pathname;

  return path.resolve(path.normalize(decodeURIComponent(rawPath)));
}

function createWindow(onWindowClosedCallback) {
  powerSaveBlocker.start("prevent-display-sleep");
  powerSaveBlocker.start("prevent-app-suspension");

  session.defaultSession.setDevicePermissionHandler((details) => {
    return details.deviceType === "hid";
  });

  const allowedProtocols = new Set(["app:", "devtools:"]);
  if (isDev) {
    allowedProtocols.add("http:");
    allowedProtocols.add("ws:");
  }

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const requestProtocol = new URL(details.url).protocol;
    callback({ cancel: !allowedProtocols.has(requestProtocol) });
  });

  protocol.handle("app", (request) => {
    let requestedPath;

    try {
      const requestedUrl = new URL(request.url);
      requestedPath = getRequestedAppPath(requestedUrl);
    } catch (error) {
      logError("Invalid app protocol request:", request.url, error);
      return new Response(null, { status: 400 });
    }

    const whitelistedFiles = getWhitelistedFiles();
    const mainAppDir = path.join(__dirname, "..");

    const authorized =
      requestedPath === mainAppDir ||
      requestedPath.startsWith(mainAppDir + "/") ||
      whitelistedFiles.has(requestedPath);

    if (!authorized) {
      logError("Unauthorized file access:", requestedPath);
      return new Response(null, { status: 403 });
    }

    return net.fetch(url.pathToFileURL(requestedPath).toString());
  });

  const homePageUrl = getHomePageUrl();

  logInfo("homePageUrl:", homePageUrl);

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler((details) => {
      logWarn("Tried to open window", details);
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, navigationUrl) => {
      const parsedUrl = new URL(navigationUrl);

      if (parsedUrl.origin !== new URL(homePageUrl).origin) {
        logWarn("Tried to navigate to another page", parsedUrl);
        event.preventDefault();
      }
    });
  });

  const fullscreen = !forceWindowed && !isDev && !overlayMode;

  const win = new BrowserWindow({
    show: !overlayMode,
    fullscreen,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      sandbox: true,
      preload: getElectronPreloadPath(),
      autoplayPolicy: "no-user-gesture-required",
    },
    frame: !fullscreen && !overlayMode,
    title: "Lutris Bigscreen",
  });

  if (!fullscreen && !overlayMode) {
    win.setSize(1280, 800);
  }

  setMainWindow(win);

  subscribeConfigValueChange("zoomFactor", setWindowZoomFactor);

  const startRemoteDesktopSessionDebounced = debounce(() => {
    startRemoteDesktopSession().catch((error) => {
      logError("unable to start remote desktop session", error);
    });
  }, 1000);

  win.on("focus", () => {
    if (!isRunningInsideGamescope()) {
      startRemoteDesktopSessionDebounced();
    }
  });

  win.on("focus", () => {
    if (fullscreen) {
      win.setFullScreen(true);
    }
  });

  win.on("show", () => {
    win.restore();
    win.focus();
    if (fullscreen) {
      win.setFullScreen(true);
    }
  });

  win.on("closed", () => {
    void setWaybarVisible(true);
    void restoreCoveredFullscreenWindow(true);
    setMainWindow(null);
    if (onWindowClosedCallback) {
      onWindowClosedCallback();
    }
  });

  win.webContents.once("did-stop-loading", () => {
    initializeThemeManager();

    win.webContents.setZoomFactor(getWindowZoomFactor());

    checkForUpdates().catch((error) => {
      logError("unable to check for new updates:", error);
    });
  });

  if (overlayMode) {
    win.once("ready-to-show", async () => {
      await captureCoveredFullscreenWindow();
      await setWaybarVisible(false);
      win.show();
      win.focus();
      await wait(150);
      await raiseHyprlandOverlay();
      await restoreCoveredFullscreenWindow();
      await raiseHyprlandOverlay({ focus: false });
    });
  }

  subscribeConfigValueChange("useRemoteDesktopPortal", (enabled) => {
    if (enabled) {
      startRemoteDesktopSessionDebounced();
    } else {
      stopRemoteDesktopSession().catch((error) => {
        logError("unable to stop remote desktop session", error);
      });
    }
  });

  win.loadURL(homePageUrl);
}

module.exports = {
  createWindow,
  showWindow,
  toggleWindowShow,
};
