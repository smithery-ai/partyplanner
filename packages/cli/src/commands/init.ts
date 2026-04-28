import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { info } from "../log.js";

export async function runInit(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: hylo init\n\nCreates ~/.flamecast for local chats.\n",
    );
    return 0;
  }

  if (args.length > 0) {
    process.stderr.write(
      "hylo init does not accept arguments. It initializes ~/.flamecast.\n",
    );
    return 1;
  }

  const target = resolve(homedir(), ".flamecast");
  await mkdir(target, { recursive: true });
  info(`Initialized Hylo chat directory at ${target}`);
  return 0;
}
