import { resolve } from "node:path";
import { createHyloApiClient, HyloApiError } from "@hylo/api-client";
import { parseBuildArgs } from "../args.js";
import { resolveHyloBackendUrl } from "../config.js";
import { info } from "../log.js";
import { loadProject } from "../project.js";
import { getHyloAccessToken } from "./auth.js";
import { buildWorkerBundle } from "./build.js";

const CLIENT_URL = "https://hylo-client.vercel.app";

export async function runDeploy(args: string[]): Promise<number> {
  try {
    const { options, rest } = parseBuildArgs(args);
    if (rest.length > 1) {
      throw new Error(`Unexpected argument for deploy: ${rest[1]}`);
    }

    const projectRoot = rest[0]
      ? resolve(process.cwd(), rest[0])
      : process.cwd();
    const project = await loadProject(projectRoot);
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
      workflowId: project.workflowId,
      workflowName: project.workflowName,
      workflowVersion: project.workflowVersion,
    });

    info(``);
    info(`Deployment: ${deployment.deploymentId}`);
    info(`Open it at: ${CLIENT_URL}/?worker=${deployment.deploymentId}`);
    return 0;
  } catch (e) {
    process.stderr.write(`${deployErrorMessage(e)}\n`);
    return 1;
  }
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
