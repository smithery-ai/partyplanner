import { createHyloApiClient, HyloApiError } from "@hylo/api-client";
import { resolveHyloBackendUrl } from "../config.js";
import { getHyloAccessToken } from "./auth.js";

type WorkersCommandOptions = {
  apiKey?: string;
  local?: boolean;
  organizationId?: string;
};

const HELP = `hylo workers

Usage:
  hylo workers list [--organization <id>]

Options:
  --api-key <key>          API key for admin APIs
  --local                  Use the portless local Hylo backend
  --organization <id>      Organization ID (defaults to "me")
`;

export async function runWorkers(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "list":
        await listWorkers(rest);
        return 0;
      default:
        process.stderr.write(`Unknown workers command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    process.stderr.write(`${workerErrorMessage(e)}\n`);
    return 1;
  }
}

async function listWorkers(args: string[]): Promise<void> {
  const { options, rest } = parseWorkersArgs(args);
  requireNoRest(rest, "workers list");
  const backendUrl = resolveHyloBackendUrl({ local: options.local });
  const adminApiKey = options.apiKey ?? process.env.HYLO_API_KEY?.trim();
  const accessToken = adminApiKey
    ? undefined
    : await getHyloAccessToken({ backendUrl });
  if (!adminApiKey && !accessToken) {
    throw new Error(
      `Sign in with \`hylo auth login${options.local ? " --local" : ""}\` or provide HYLO_API_KEY/--api-key.`,
    );
  }
  const api = createHyloApiClient({
    bearerToken: adminApiKey ?? accessToken,
    baseUrl: backendUrl,
  });
  const result = await api.tenants.listDeployments(
    options.organizationId ?? "me",
  );
  printJson({
    ok: result.ok,
    organizationId: result.tenantId,
    workers: result.deployments,
  });
}

function parseWorkersArgs(args: string[]): {
  options: WorkersCommandOptions;
  rest: string[];
} {
  const options: WorkersCommandOptions = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--api-key") {
      options.apiKey = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--api-key=")) {
      options.apiKey = arg.slice("--api-key=".length);
    } else if (arg === "--local") {
      options.local = true;
    } else if (
      arg === "--organization" ||
      arg === "--organization-id" ||
      arg === "--tenant" ||
      arg === "--tenant-id"
    ) {
      options.organizationId = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--organization=")) {
      options.organizationId = arg.slice("--organization=".length);
    } else if (arg.startsWith("--organization-id=")) {
      options.organizationId = arg.slice("--organization-id=".length);
    } else if (arg.startsWith("--tenant=")) {
      options.organizationId = arg.slice("--tenant=".length);
    } else if (arg.startsWith("--tenant-id=")) {
      options.organizationId = arg.slice("--tenant-id=".length);
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

function requireArgValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function requireNoRest(rest: string[], command: string): void {
  if (rest.length > 0) {
    throw new Error(`Unexpected argument for ${command}: ${rest[0]}`);
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function workerErrorMessage(e: unknown): string {
  if (e instanceof HyloApiError) {
    const details =
      e.error && typeof e.error === "object" && "message" in e.error
        ? `: ${String(e.error.message)}`
        : "";
    return `Hylo API request failed with HTTP ${e.response.status}${details}`;
  }
  return e instanceof Error ? e.message : String(e);
}
