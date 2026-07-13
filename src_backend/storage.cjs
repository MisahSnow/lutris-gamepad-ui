const fs = require("node:fs");
const path = require("node:path");

const { app } = require("electron");

function getLegacyStorageDirectory() {
  return path.join(app.getPath("home"), ".local", "lutris-gamepad-ui");
}

function getPreviousStorageDirectory() {
  return path.join(app.getPath("appData"), "lutris-gamepad-ui.d");
}

function getModernStorageDirectory() {
  return path.join(app.getPath("appData"), "lutris-bigscreen.d");
}

function migrateLegacyDirectory(modernDirectory, legacyDirectory) {
  if (fs.existsSync(modernDirectory) || !fs.existsSync(legacyDirectory)) {
    return;
  }

  const tmpModernDirectory = path.join(
    path.dirname(modernDirectory),
    path.basename(modernDirectory) + "_migration_" + Date.now(),
  );

  const legacyDirectoryFiles = fs.readdirSync(legacyDirectory);

  fs.mkdirSync(tmpModernDirectory, { recursive: true });

  for (const filename of legacyDirectoryFiles) {
    const src = path.join(legacyDirectory, filename);
    const dst = path.join(tmpModernDirectory, filename);

    if (!fs.statSync(src).isFile()) {
      continue;
    }

    fs.copyFileSync(src, dst);
  }

  fs.renameSync(tmpModernDirectory, modernDirectory);
  fs.rmdirSync(legacyDirectory, { force: true, recursive: true });
}

function deleteLegacyJunkChromiumSessionFiles() {
  const dir = path.join(app.getPath("appData"), "lutris-gamepad-ui");

  if (!fs.existsSync(dir)) {
    return;
  }

  fs.rmdirSync(dir, { force: true, recursive: true });
}

function migrateAndGetHomeDirectory() {
  const modernDirectory = getModernStorageDirectory();
  const previousDirectory = getPreviousStorageDirectory();
  const legacyDirectory = getLegacyStorageDirectory();

  migrateLegacyDirectory(modernDirectory, previousDirectory);
  migrateLegacyDirectory(modernDirectory, legacyDirectory);
  deleteLegacyJunkChromiumSessionFiles();

  return modernDirectory;
}

function getStorageModule() {
  const storageHomeDirectory = migrateAndGetHomeDirectory();
  fs.mkdirSync(storageHomeDirectory, { recursive: true });

  const module = {
    getThemeFilePath: () => {
      return path.join(storageHomeDirectory, "theme.json");
    },

    getDefaultThemeFilePath: () => {
      return path.join(storageHomeDirectory, "theme.default.json");
    },

    getLogFilePath: () => {
      return path.join(storageHomeDirectory, "logs.txt");
    },

    getKvStorageFilePath: () => {
      return path.join(storageHomeDirectory, "config.json");
    },

    generateBugReportFilePath: () => {
      const filename = `bugreport-${new Date().toISOString()}.tar`;
      return path.join(storageHomeDirectory, filename);
    },
  };

  return module;
}

module.exports = getStorageModule();
