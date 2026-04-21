import { spawn } from "node:child_process";

const backendUrl =
  process.env.HYLO_BACKEND_URL ??
  derivePortlessServiceUrl(
    process.env.PORTLESS_URL,
    "cf-worker.hylo",
    "api.hylo",
  );

if (!backendUrl) {
  console.error(
    "HYLO_BACKEND_URL is required. Start backend-node and set HYLO_BACKEND_URL, or run through portless.",
  );
  process.exit(1);
}

const port = process.env.PORT ?? "8789";

const child = spawn(
  "wrangler",
  [
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    port,
    "--var",
    `HYLO_BACKEND_URL:${backendUrl}`,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HYLO_BACKEND_URL: backendUrl,
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function derivePortlessServiceUrl(sourceUrl, sourceName, targetName) {
  if (!sourceUrl) return undefined;

  try {
    const url = new URL(sourceUrl);
    const sourcePrefix = `${sourceName}.`;
    const sourceMarker = `.${sourceName}.`;

    if (url.hostname.startsWith(sourcePrefix)) {
      url.hostname = `${targetName}.${url.hostname.slice(sourcePrefix.length)}`;
      return url.origin;
    }

    const markerIndex = url.hostname.indexOf(sourceMarker);
    if (markerIndex === -1) return undefined;

    const prefix = url.hostname.slice(0, markerIndex);
    const suffix = url.hostname.slice(markerIndex + sourceMarker.length);
    url.hostname = `${prefix}.${targetName}.${suffix}`;
    return url.origin;
  } catch {
    return undefined;
  }
}
