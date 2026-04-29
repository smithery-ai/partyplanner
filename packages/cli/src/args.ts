export type BuildOptions = {
  local?: boolean;
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
    if (arg === "--local") {
      options.local = true;
      continue;
    }
    rest.push(arg);
  }

  return { options, rest };
}
