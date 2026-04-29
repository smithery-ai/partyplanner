import { createHyloApiClient, HyloApiError } from "@hylo/api-client";
import { resolveHyloBackendUrl } from "../config.js";
import { cliFetch } from "../fetch.js";
import { getHyloAccessToken } from "./auth.js";

type OrganizationsCommandOptions = {
  local?: boolean;
};

const HELP = `hylo organizations

Usage:
  hylo organizations list

Options:
  --local                  Use the portless local Hylo backend
`;

export async function runOrganizations(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "list":
        await listOrganizations(rest);
        return 0;
      default:
        process.stderr.write(
          `Unknown organizations command: ${command}\n\n${HELP}`,
        );
        return 1;
    }
  } catch (e) {
    process.stderr.write(`${organizationErrorMessage(e)}\n`);
    return 1;
  }
}

async function listOrganizations(args: string[]): Promise<void> {
  const { options, rest } = parseOrganizationsArgs(args);
  requireNoRest(rest, "organizations list");
  const backendUrl = resolveHyloBackendUrl({ local: options.local });
  const accessToken = await getHyloAccessToken({ backendUrl });
  if (!accessToken) {
    throw new Error(
      `Sign in with \`hylo auth login${options.local ? " --local" : ""}\` before listing organizations.`,
    );
  }
  const api = createHyloApiClient({
    baseUrl: backendUrl,
    bearerToken: accessToken,
    fetch: cliFetch,
  });
  printJson(await api.auth.organizations());
}

function parseOrganizationsArgs(args: string[]): {
  options: OrganizationsCommandOptions;
  rest: string[];
} {
  const options: OrganizationsCommandOptions = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--local") {
      options.local = true;
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

function requireNoRest(rest: string[], command: string): void {
  if (rest.length > 0) {
    throw new Error(`Unexpected argument for ${command}: ${rest[0]}`);
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function organizationErrorMessage(e: unknown): string {
  if (e instanceof HyloApiError) {
    const details =
      e.error && typeof e.error === "object" && "message" in e.error
        ? `: ${String(e.error.message)}`
        : "";
    return `Hylo API request failed with HTTP ${e.response.status}${details}`;
  }
  return e instanceof Error ? e.message : String(e);
}
