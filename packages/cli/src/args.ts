export type BuildOptions = {
  backendUrl?: string;
};

export function parseBuildArgs(args: string[]): {
  options: BuildOptions;
  rest: string[];
} {
  const options: BuildOptions = {};
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--backend" || arg === "--backend-url") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      options.backendUrl = value;
      continue;
    }
    if (arg.startsWith("--backend=")) {
      options.backendUrl = arg.slice("--backend=".length);
      continue;
    }
    if (arg.startsWith("--backend-url=")) {
      options.backendUrl = arg.slice("--backend-url=".length);
      continue;
    }
    rest.push(arg);
  }

  if (!options.backendUrl && process.env.HYLO_BACKEND_URL?.trim()) {
    options.backendUrl = process.env.HYLO_BACKEND_URL.trim();
  }

  return { options, rest };
}
