import { BrowserWindow, type Event, ipcMain, shell } from "electron";
import {
  AUTH_CHANNELS,
  type AuthChangePayload,
  type AuthIpcResult,
} from "../shared/auth";
import {
  clearSession,
  getAccessToken,
  getLogoutUrl,
  getSignInUrl,
  getUser,
  handleCallback,
} from "./auth";

export function setupAuthIpcHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(AUTH_CHANNELS.SIGN_IN, async (): Promise<AuthIpcResult> => {
    try {
      await openAuthWindow(mainWindow);
      return { success: true };
    } catch (error) {
      console.error("Sign in failed:", error);
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(AUTH_CHANNELS.SIGN_OUT, async (): Promise<AuthIpcResult> => {
    try {
      const logoutUrl = await getLogoutUrl();
      clearSession();
      if (logoutUrl) {
        await shell.openExternal(logoutUrl);
      }
      notifyAuthChange(mainWindow, null);
      return { success: true };
    } catch (error) {
      console.error("Sign out failed:", error);
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(AUTH_CHANNELS.GET_USER, async () => {
    try {
      return await getUser();
    } catch (error) {
      console.error("Get user failed:", error);
      return null;
    }
  });

  ipcMain.handle(AUTH_CHANNELS.GET_ACCESS_TOKEN, async () => {
    return getAccessToken();
  });
}

export function notifyAuthChange(
  mainWindow: BrowserWindow,
  user: AuthChangePayload["user"],
): void {
  mainWindow.webContents.send(AUTH_CHANNELS.ON_AUTH_CHANGE, { user });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let authWindow: BrowserWindow | null = null;

async function openAuthWindow(mainWindow: BrowserWindow): Promise<void> {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    return;
  }

  const signInUrl = await getSignInUrl();
  authWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 480,
    height: 760,
    minWidth: 420,
    minHeight: 640,
    autoHideMenuBar: true,
    show: false,
    title: "Sign in to Hylo",
    webPreferences: {
      sandbox: true,
    },
  });

  const closeAuthWindow = () => {
    if (!authWindow || authWindow.isDestroyed()) {
      authWindow = null;
      return;
    }
    authWindow.close();
    authWindow = null;
  };

  const handleCallbackUrl = async (url: string) => {
    const params = new URL(url).searchParams;
    const error = params.get("error");
    const code = params.get("code");

    if (error) {
      throw new Error(params.get("error_description") ?? error);
    }
    if (!code) {
      throw new Error("No authorization code returned from WorkOS.");
    }

    await handleCallback(code);
    closeAuthWindow();
    const user = await getUser();
    notifyAuthChange(mainWindow, user);
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  };

  const interceptCallback = (event: Event, url: string): void => {
    if (!url.startsWith("hylo-auth://")) return;
    event.preventDefault();
    void handleCallbackUrl(url).catch((error) => {
      console.error("Auth callback failed:", error);
      closeAuthWindow();
    });
  };

  authWindow.on("closed", () => {
    authWindow = null;
  });
  authWindow.once("ready-to-show", () => {
    authWindow?.show();
  });
  authWindow.webContents.on("will-redirect", interceptCallback);
  authWindow.webContents.on("will-navigate", interceptCallback);
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("hylo-auth://")) {
      void handleCallbackUrl(url).catch((error) => {
        console.error("Auth callback failed:", error);
        closeAuthWindow();
      });
      return { action: "deny" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  authWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      if (validatedUrl.startsWith("hylo-auth://")) {
        void handleCallbackUrl(validatedUrl).catch((error) => {
          console.error("Auth callback failed:", error);
          closeAuthWindow();
        });
        return;
      }
      if (errorCode !== -3) {
        console.error(
          `Auth window failed to load (${errorCode}): ${errorDescription}`,
        );
      }
    },
  );

  await authWindow.loadURL(signInUrl);
}
