export function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function fail(msg: string): never {
  throw new Error(msg);
}
