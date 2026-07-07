const fs = require("node:fs");
const path = require("node:path");

const { getMainWindow } = require("./state.cjs");
const {
  execFilePromise,
  getProcessDescendants,
  logInfo,
} = require("./utils.cjs");

const HYPRLAND_ADDRESS_REGEX = /^0x[\da-f]+$/i;
const HYPRLAND_STATE_WAIT_TIMEOUT_MS = 1200;
const HYPRLAND_STATE_WAIT_INTERVAL_MS = 100;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return new Set([
    process.pid,
    ...getProcessDescendants(process.pid, new Set()),
    ...getProcessAncestors(process.pid),
  ]);
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
    commandText.includes("lutris-gamepad-ui") ||
    commandText.includes("electron.cjs")
  );
}

function readCandidateProcess(
  pid,
  protectedPids,
  currentUid,
  { title = null, windowAddress = null, workspace = null, fullscreen = 0 } = {},
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

  return {
    pid,
    ppid: Number(status.PPid) || 0,
    name: title || getProcessLabel(pid, status.Name, cmdline),
    command: cmdline.join(" "),
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
