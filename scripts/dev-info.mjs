#!/usr/bin/env node

const urls = [
  ["Client", "https://hylo-client.localhost"],
  ["Local API", "https://local-api.localhost"],
  ["Backend", "https://api-worker.hylo.localhost"],
  ["Workflow", "https://workflow-cloudflare-worker-example.localhost"],
];

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
    ...urls.map(([label, url]) => `${label.padEnd(10)} ${url}`),
    "",
    "Local worker source:",
    ".flamecast",
    "",
    "Run just the local worker:",
    "pnpm hylo dev .flamecast",
  ];

  console.log("");
  console.log(line);
  for (const row of rows) {
    console.log(row);
  }
  console.log(line);
  console.log("");
}
