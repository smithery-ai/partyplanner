import { app, type BrowserWindow } from "electron";
import path from "node:path";
import { handleCallback } from "./auth";

const PROTOCOL = "hylo-auth";
const pendingProtocolUrls: string[] = [];
let protocolUrlHandler: ((url: string) => void) | undefined;

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!url.startsWith(`${PROTOCOL}://`)) return;
  if (protocolUrlHandler) {
    protocolUrlHandler(url);
    return;
  }
  pendingProtocolUrls.push(url);
});

export function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
    return;
  }
  app.setAsDefaultProtocolClient(PROTOCOL);
}

export function setupDeepLinkHandling(
  mainWindow: BrowserWindow,
  onAuthComplete: (success: boolean) => void,
): void {
  const handleUrl = async (url: string): Promise<void> => {
    const params = new URL(url).searchParams;
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      console.error("OAuth error:", error, params.get("error_description"));
      onAuthComplete(false);
      return;
    }
    if (!code) {
      console.error("No authorization code in callback");
      onAuthComplete(false);
      return;
    }

    try {
      await handleCallback(code);
      onAuthComplete(true);
    } catch (authError) {
      console.error("Auth callback failed:", authError);
      onAuthComplete(false);
    }
  };
  protocolUrlHandler = (url: string) => {
    void handleUrl(url);
  };

  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url) {
      void handleUrl(url);
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  const initialUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (initialUrl) {
    pendingProtocolUrls.push(initialUrl);
  }

  for (const url of pendingProtocolUrls.splice(0)) {
    void handleUrl(url);
  }
}
