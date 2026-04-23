import { createHyloApiClient, HyloApiError } from "@hylo/api-client";
import { parseBuildArgs } from "../args.js";
import { resolveHyloBackendUrl } from "../config.js";
import { info } from "../log.js";
import { loadProject } from "../project.js";
import { getHyloAccessToken } from "./auth.js";
import { buildWorkerBundle } from "./build.js";

const CLIENT_URL = "https://hylo-client.vercel.app";
const WORKER_BASE_PATH = "/api/workflow";

export async function runDeploy(args: string[]): Promise<number> {
  try {
    const { options, rest } = parseBuildArgs(args);
    if (rest.length > 0) {
      throw new Error(`Unexpected argument for deploy: ${rest[0]}`);
    }

    const project = await loadProject(process.cwd());
    const backendUrl = resolveHyloBackendUrl(options.backendUrl);
    const accessToken = await getHyloAccessToken();
    if (!accessToken) {
      throw new Error("Sign in with `hylo auth login` before deploying.");
    }

    const bundle = await buildWorkerBundle(project, {
      ...options,
      backendUrl,
    });
    const api = createHyloApiClient({
      baseUrl: backendUrl,
      bearerToken: accessToken,
    });

    info(`Deploying ${project.workerName} via Hylo deployments API...`);
    const deployment = await api.deployments.create({
      deploymentId: project.workerName,
      label: project.workflowName,
      moduleCode: bundle.moduleCode,
      moduleName: bundle.moduleName,
      bindings: workflowBindings(project, backendUrl),
    });

    const workflowApiUrl =
      deployment.workflowApiUrl ??
      `${backendUrl}/workers/${encodeURIComponent(
        deployment.deploymentId,
      )}${WORKER_BASE_PATH}`;
    info(``);
    info(`Deployment: ${deployment.deploymentId}`);
    info(
      `Interact with it at: ${CLIENT_URL}/?workflowApiUrl=${encodeURIComponent(
        workflowApiUrl,
      )}`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`${deployErrorMessage(e)}\n`);
    return 1;
  }
}

function workflowBindings(
  project: Awaited<ReturnType<typeof loadProject>>,
  backendUrl: string,
) {
  return [
    plainTextBinding("HYLO_WORKFLOW_ID", project.workflowId),
    plainTextBinding("HYLO_WORKFLOW_NAME", project.workflowName),
    plainTextBinding("HYLO_WORKFLOW_VERSION", project.workflowVersion),
    plainTextBinding("HYLO_BACKEND_URL", backendUrl),
  ];
}

function plainTextBinding(name: string, text: string): Record<string, unknown> {
  return { name, text, type: "plain_text" };
}

function deployErrorMessage(e: unknown): string {
  if (e instanceof HyloApiError) {
    const details =
      e.error && typeof e.error === "object" && "message" in e.error
        ? `: ${String(e.error.message)}`
        : "";
    return `Hylo API request failed with HTTP ${e.response.status}${details}`;
  }
  return e instanceof Error ? e.message : String(e);
}
