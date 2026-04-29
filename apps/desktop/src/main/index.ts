import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { getUser } from "./auth";
import { registerProtocol, setupDeepLinkHandling } from "./deep-link-handler";
import { notifyAuthChange, setupAuthIpcHandlers } from "./ipc-handlers";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

registerProtocol();

app.whenReady().then(async () => {
  const mainWindow = createWindow();

  setupAuthIpcHandlers(mainWindow);
  setupDeepLinkHandling(mainWindow, async (success) => {
    if (!success) return;
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    await notifyAuthChange(mainWindow);
  });

  try {
    const user = await getUser();
    if (user) {
      mainWindow.webContents.once("did-finish-load", () => {
        void notifyAuthChange(mainWindow, user);
      });
    }
  } catch (error) {
    console.error("Failed to load initial auth state:", error);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}
