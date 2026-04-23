import { readFile } from "node:fs/promises";
import { createHyloApiClient, HyloApiError } from "@hylo/api-client";

type DeploymentCommandOptions = {
  apiKey?: string;
  backendUrl?: string;
  deploymentId?: string;
  label?: string;
  modulePath?: string;
  tenantId?: string;
  workflowApiUrl?: string;
};

const HELP = `hylo deployments

Usage:
  hylo deployments list --tenant <id>
  hylo deployments workflows --tenant <id>
  hylo deployments get <deploymentId>
  hylo deployments create --tenant <id> --deployment <id> --module <path>
  hylo deployments delete <deploymentId>

Options:
  --api-key <key>          API key for admin deployment APIs
  --backend <url>          Hylo backend API URL
  --deployment <id>        Deployment ID
  --label <label>          Registry label
  --module <path>          Worker module source file to upload
  --tenant <id>            Tenant ID
  --workflow-api-url <url> Registry workflow API URL
`;

export async function runDeployments(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "list":
        await listTenantDeployments(rest);
        return 0;
      case "workflows":
        await getTenantWorkflows(rest);
        return 0;
      case "get":
        await getDeployment(rest);
        return 0;
      case "create":
        await createDeployment(rest);
        return 0;
      case "delete":
        await deleteDeployment(rest);
        return 0;
      default:
        process.stderr.write(
          `Unknown deployments command: ${command}\n\n${HELP}`,
        );
        return 1;
    }
  } catch (e) {
    process.stderr.write(`${deploymentErrorMessage(e)}\n`);
    return 1;
  }
}

async function listTenantDeployments(args: string[]): Promise<void> {
  const { options, rest } = parseDeploymentArgs(args);
  requireNoRest(rest, "deployments list");
  const api = deploymentApi(options);
  printJson(await api.tenants.listDeployments(requireTenantId(options)));
}

async function getTenantWorkflows(args: string[]): Promise<void> {
  const { options, rest } = parseDeploymentArgs(args);
  requireNoRest(rest, "deployments workflows");
  const api = deploymentApi(options);
  printJson(await api.tenants.getWorkflows(requireTenantId(options)));
}

async function getDeployment(args: string[]): Promise<void> {
  const { options, rest } = parseDeploymentArgs(args);
  const deploymentId = options.deploymentId ?? rest[0];
  requireNoRest(
    rest.slice(deploymentId === rest[0] ? 1 : 0),
    "deployments get",
  );
  const api = deploymentApi(options, { requireApiKey: true });
  printJson(
    await api.deployments.get(requireValue(deploymentId, "deploymentId")),
  );
}

async function createDeployment(args: string[]): Promise<void> {
  const { options, rest } = parseDeploymentArgs(args);
  requireNoRest(rest, "deployments create");
  const api = deploymentApi(options, { requireApiKey: true });
  const deploymentId = requireValue(options.deploymentId, "--deployment");
  const moduleCode = await readFile(
    requireValue(options.modulePath, "--module"),
    "utf8",
  );

  printJson(
    await api.deployments.create({
      tenantId: requireTenantId(options),
      deploymentId,
      label: options.label,
      moduleName: `${deploymentId}.mjs`,
      moduleCode,
      ...(options.workflowApiUrl
        ? { workflowApiUrl: options.workflowApiUrl }
        : {}),
    }),
  );
}

async function deleteDeployment(args: string[]): Promise<void> {
  const { options, rest } = parseDeploymentArgs(args);
  const deploymentId = options.deploymentId ?? rest[0];
  requireNoRest(
    rest.slice(deploymentId === rest[0] ? 1 : 0),
    "deployments delete",
  );
  const api = deploymentApi(options, { requireApiKey: true });
  printJson(
    await api.deployments.delete(requireValue(deploymentId, "deploymentId")),
  );
}

function deploymentApi(
  options: DeploymentCommandOptions,
  apiOptions: { requireApiKey?: boolean } = {},
) {
  const apiKey = options.apiKey ?? process.env.HYLO_API_KEY?.trim();
  if (apiOptions.requireApiKey && !apiKey) {
    throw new Error("HYLO_API_KEY or --api-key is required.");
  }
  return createHyloApiClient({
    apiKey,
    baseUrl: requireValue(
      options.backendUrl ?? process.env.HYLO_BACKEND_URL?.trim(),
      "HYLO_BACKEND_URL or --backend",
    ),
  });
}

function parseDeploymentArgs(args: string[]): {
  options: DeploymentCommandOptions;
  rest: string[];
} {
  const options: DeploymentCommandOptions = {};
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
    } else if (arg === "--label") {
      options.label = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--label=")) {
      options.label = arg.slice("--label=".length);
    } else if (arg === "--module") {
      options.modulePath = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--module=")) {
      options.modulePath = arg.slice("--module=".length);
    } else if (arg === "--tenant" || arg === "--tenant-id") {
      options.tenantId = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--tenant=")) {
      options.tenantId = arg.slice("--tenant=".length);
    } else if (arg.startsWith("--tenant-id=")) {
      options.tenantId = arg.slice("--tenant-id=".length);
    } else if (arg === "--workflow-api-url") {
      options.workflowApiUrl = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--workflow-api-url=")) {
      options.workflowApiUrl = arg.slice("--workflow-api-url=".length);
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

function requireTenantId(options: DeploymentCommandOptions): string {
  return requireValue(options.tenantId, "--tenant");
}

function requireValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  return trimmed;
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

function deploymentErrorMessage(e: unknown): string {
  if (e instanceof HyloApiError) {
    const details =
      e.error && typeof e.error === "object" && "message" in e.error
        ? `: ${String(e.error.message)}`
        : "";
    return `Hylo API request failed with HTTP ${e.response.status}${details}`;
  }
  return e instanceof Error ? e.message : String(e);
}
