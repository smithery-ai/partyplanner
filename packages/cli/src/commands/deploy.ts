import { parseBuildArgs } from "../args.js";
import { info } from "../log.js";
import { loadProject } from "../project.js";
import { runWrangler } from "../wrangler.js";
import { prepareBuildDir } from "./build.js";

const CLIENT_URL = "https://hylo-client.vercel.app";
const WORKER_BASE_PATH = "/api/workflow";

export async function runDeploy(args: string[]): Promise<number> {
  const { options, rest } = parseBuildArgs(args);
  const project = await loadProject(process.cwd());
  await prepareBuildDir(project, options);
  info(`Deploying ${project.workerName}…`);
  const code = await runWrangler(["deploy", ...rest], project.buildDir);
  if (code !== 0) return code;

  const apiUrl = `https://${project.workerName}.smithery.workers.dev${WORKER_BASE_PATH}`;
  info(``);
  info(
    `Interact with it at: ${CLIENT_URL}/?workflowApiUrl=${encodeURIComponent(apiUrl)}`,
  );
  return 0;
}
