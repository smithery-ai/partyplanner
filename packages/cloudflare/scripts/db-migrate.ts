import { backendForCommand } from "./db-common";

const backend = await backendForCommand(process.argv.slice(2));
try {
  await fetch(`${backend.url.replace(/\/+$/, "")}/health`);
  console.log(`Workflow Cloudflare schema is up to date via ${backend.url}.`);
} finally {
  await backend.stop();
}
