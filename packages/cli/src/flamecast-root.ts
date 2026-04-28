import { homedir } from "node:os";
import { resolve } from "node:path";

export function flamecastRoot(): string {
  const explicit = process.env.FLAMECAST_LOG_DIR?.trim();
  return explicit ? resolve(explicit) : resolve(homedir(), ".flamecast");
}

export function flamecastWorkerRoot(): string {
  return resolve(flamecastRoot(), "worker");
}
