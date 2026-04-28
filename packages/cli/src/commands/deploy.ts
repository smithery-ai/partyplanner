import { resolve } from "node:path";
import { createHyloApiClient, HyloApiError } from "@hylo/api-client";
import { parseBuildArgs } from "../args.js";
import { DEFAULT_HYLO_BACKEND_URL, resolveHyloBackendUrl } from "../config.js";
import { info } from "../log.js";
import { defaultProjectRoot, loadProject } from "../project.js";
import { envSecretBindings } from "../secrets.js";
import { getHyloAccessToken } from "./auth.js";
import { buildWorkerBundle } from "./build.js";

const DEFAULT_CLIENT_URL = "https://hylo-client.vercel.app";
const LOCAL_CLIENT_URL = "https://hylo-client.localhost";

export async function runDeploy(args: string[]): Promise<number> {
  try {
    const { options, rest } = parseBuildArgs(args);
    if (rest.length > 1) {
      throw new Error(`Unexpected argument for deploy: ${rest[1]}`);
    }

    const projectRoot = rest[0]
      ? resolve(process.cwd(), rest[0])
      : await defaultProjectRoot(process.cwd());
    const project = await loadProject(projectRoot);
    const backendUrl = resolveHyloBackendUrl(options.backendUrl);
    const accessToken = await getHyloAccessToken({ backendUrl });
    if (!accessToken) {
      throw new Error(
        `Sign in with \`hylo auth login --backend-url ${backendUrl}\` before deploying.`,
      );
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
    const bindings = await envSecretBindings(resolve(projectRoot, "src"));
    const deployment = await api.deployments.create({
      deploymentId: project.workerName,
      ...(bindings.length > 0 ? { bindings } : {}),
      label: project.workflowName,
      moduleCode: bundle.moduleCode,
      moduleName: bundle.moduleName,
      workflowId: project.workflowId,
      workflowName: project.workflowName,
      workflowVersion: project.workflowVersion,
    });

    info(``);
    info(`Deployment: ${deployment.deploymentId}`);
    info(`Open it at: ${clientUrl(backendUrl, deployment.deploymentId)}`);
    return 0;
  } catch (e) {
    process.stderr.write(`${deployErrorMessage(e)}\n`);
    return 1;
  }
}

function clientUrl(backendUrl: string, deploymentId: string): string {
  const url = new URL(clientBaseUrl(backendUrl));
  url.searchParams.set("worker", deploymentId);
  return url.toString();
}

function clientBaseUrl(backendUrl: string): string {
  const explicit = process.env.HYLO_CLIENT_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const backend = new URL(backendUrl);
  if (isLoopbackHost(backend.hostname)) return LOCAL_CLIENT_URL;

  if (backend.origin === DEFAULT_HYLO_BACKEND_URL) return DEFAULT_CLIENT_URL;

  const previewBranch = backend.hostname.match(
    /^(.+)-hylo-backend-preview\.smithery\.workers\.dev$/,
  )?.[1];
  if (previewBranch) {
    return `https://hylo-client-git-${previewBranch}-smithery.vercel.app`;
  }

  return DEFAULT_CLIENT_URL;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
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
