#!/usr/bin/env node

const urls = [
  ["Client", "https://hylo-client.localhost"],
  ["Backend", "https://api-worker.hylo.localhost"],
  ["Workflow", "https://workflow-cloudflare-worker-example.localhost"],
];
const backendTunnelUrl = process.env.HYLO_BACKEND_TUNNEL_URL?.trim();
if (backendTunnelUrl) {
  urls.push(["Public", backendTunnelUrl]);
  urls.push(["Webhooks", `${backendTunnelUrl.replace(/\/+$/, "")}/webhooks`]);
}

printBanner();

if (process.argv.includes("--once")) {
  process.exit(0);
}

const interval = setInterval(printBanner, 10 * 60 * 1000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(interval);
    process.exit(0);
  });
}

function printBanner() {
  const width = 78;
  const line = "=".repeat(width);
  const rows = [
    "Local Hylo dev URLs",
    "",
    ...urls.map(([label, url]) => `${label.padEnd(9)} ${url}`),
    "",
    "Deploy a worker into this local backend:",
    "pnpm hylo auth login \\",
    "  --backend-url http://127.0.0.1:8787",
    "",
    "pnpm hylo deploy examples/cloudflare-worker \\",
    "  --backend-url http://127.0.0.1:8787",
  ];

  console.log("");
  console.log(line);
  for (const row of rows) {
    console.log(row);
  }
  console.log(line);
  console.log("");
}
