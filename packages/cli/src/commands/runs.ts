import {
  createHyloApiClient,
  HyloApiError,
  type WorkflowDeployment,
} from "@hylo/api-client";
import { resolveHyloBackendUrl } from "../config.js";
import { getHyloAccessToken } from "./auth.js";

type RunsCommandOptions = {
  apiKey?: string;
  backendUrl?: string;
  deploymentId?: string;
  tenantId?: string;
  url?: string;
};

const HELP = `hylo runs

Usage:
  hylo runs list [--deployment <id>] [--url <url>] [--tenant <id>]
  hylo runs get <runId> [--deployment <id>] [--url <url>] [--tenant <id>]

Options:
  --api-key <key>          API key for admin APIs
  --backend <url>          Hylo backend API URL
  --deployment <id>        Deployment to query (defaults to the tenant's only deployment)
  --tenant <id>            Tenant ID (defaults to "me")
  --url <url>              Direct workflow API URL (overrides --deployment)
`;

export async function runRuns(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "list":
        await listRuns(rest);
        return 0;
      case "get":
        await getRun(rest);
        return 0;
      default:
        process.stderr.write(`Unknown runs command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    process.stderr.write(`${runsErrorMessage(e)}\n`);
    return 1;
  }
}

async function listRuns(args: string[]): Promise<void> {
  const { options, rest } = parseRunsArgs(args);
  requireNoRest(rest, "runs list");
  const { workflowApiUrl, accessToken } = await resolveWorkflowApi(options);
  const data = await fetchJson(`${workflowApiUrl}/runs`, accessToken);
  printJson(data);
}

async function getRun(args: string[]): Promise<void> {
  const { options, rest } = parseRunsArgs(args);
  const runId = rest[0];
  if (!runId) throw new Error("runId is required.");
  requireNoRest(rest.slice(1), "runs get");
  const { workflowApiUrl, accessToken } = await resolveWorkflowApi(options);
  const data = await fetchJson(
    `${workflowApiUrl}/runs/${encodeURIComponent(runId)}`,
    accessToken,
  );
  printJson(data);
}

async function resolveWorkflowApi(options: RunsCommandOptions): Promise<{
  workflowApiUrl: string;
  accessToken?: string;
}> {
  const backendUrl = resolveHyloBackendUrl(options.backendUrl);
  const adminApiKey = options.apiKey ?? process.env.HYLO_API_KEY?.trim();
  const accessToken = adminApiKey
    ? undefined
    : await getHyloAccessToken({ backendUrl });

  if (options.url) {
    return {
      workflowApiUrl: stripTrailingSlash(options.url),
      accessToken: adminApiKey ?? accessToken,
    };
  }

  if (!adminApiKey && !accessToken) {
    throw new Error(
      `Sign in with \`hylo auth login --backend-url ${backendUrl}\` or provide HYLO_API_KEY/--api-key.`,
    );
  }

  const api = createHyloApiClient({
    bearerToken: adminApiKey ?? accessToken,
    baseUrl: backendUrl,
  });
  const tenantId = options.tenantId ?? "me";
  const result = await api.tenants.listDeployments(tenantId);
  const deployments = result.deployments ?? [];
  const target = pickDeployment(deployments, options.deploymentId);

  if (!target.workflowApiUrl) {
    throw new Error(
      `Deployment ${target.deploymentId} has no workflowApiUrl. Pass --url to target a worker directly.`,
    );
  }

  return {
    workflowApiUrl: stripTrailingSlash(target.workflowApiUrl),
    accessToken: adminApiKey ?? accessToken,
  };
}

function pickDeployment(
  deployments: WorkflowDeployment[],
  deploymentId: string | undefined,
): WorkflowDeployment {
  if (deploymentId) {
    const match = deployments.find((d) => d.deploymentId === deploymentId);
    if (!match) {
      throw new Error(
        `Deployment ${deploymentId} not found for this tenant. Available: ${formatDeploymentIds(deployments)}`,
      );
    }
    return match;
  }
  if (deployments.length === 0) {
    throw new Error(
      "No deployments found for this tenant. Pass --url to target a worker directly.",
    );
  }
  if (deployments.length > 1) {
    throw new Error(
      `Multiple deployments found. Pass --deployment <id>. Available: ${formatDeploymentIds(deployments)}`,
    );
  }
  return deployments[0];
}

function formatDeploymentIds(deployments: WorkflowDeployment[]): string {
  if (deployments.length === 0) return "(none)";
  return deployments.map((d) => d.deploymentId).join(", ");
}

async function fetchJson(
  url: string,
  accessToken: string | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    const trimmed = text.trim();
    const detail = trimmed ? `: ${trimmed}` : "";
    throw new Error(`GET ${url} failed with HTTP ${response.status}${detail}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseRunsArgs(args: string[]): {
  options: RunsCommandOptions;
  rest: string[];
} {
  const options: RunsCommandOptions = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--api-key") {
      options.apiKey = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--api-key=")) {
      options.apiKey = arg.slice("--api-key=".length);
    } else if (arg === "--backend" || arg === "--backend-url") {
      options.backendUrl = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--backend=")) {
      options.backendUrl = arg.slice("--backend=".length);
    } else if (arg.startsWith("--backend-url=")) {
      options.backendUrl = arg.slice("--backend-url=".length);
    } else if (arg === "--deployment" || arg === "--deployment-id") {
      options.deploymentId = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--deployment=")) {
      options.deploymentId = arg.slice("--deployment=".length);
    } else if (arg.startsWith("--deployment-id=")) {
      options.deploymentId = arg.slice("--deployment-id=".length);
    } else if (arg === "--tenant" || arg === "--tenant-id") {
      options.tenantId = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--tenant=")) {
      options.tenantId = arg.slice("--tenant=".length);
    } else if (arg.startsWith("--tenant-id=")) {
      options.tenantId = arg.slice("--tenant-id=".length);
    } else if (arg === "--url") {
      options.url = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
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

function runsErrorMessage(e: unknown): string {
  if (e instanceof HyloApiError) {
    const details =
      e.error && typeof e.error === "object" && "message" in e.error
        ? `: ${String(e.error.message)}`
        : "";
    return `Hylo API request failed with HTTP ${e.response.status}${details}`;
  }
  return e instanceof Error ? e.message : String(e);
}
