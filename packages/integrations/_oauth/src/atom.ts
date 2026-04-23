import {
  type Atom,
  atom,
  type Handle,
  type Input,
  secret,
} from "@workflow/core";
import { type ZodSchema, z } from "zod";

// Intervention payload shape for the brokered OAuth flow. Either a successful
// provider-shaped token, or an error surfaced from the broker callback (user
// denied, provider returned an error, etc.).
const errorSchema = z.object({ error: z.string() });

export type BrokerCredentials = {
  // Base URL of the broker server, e.g. `${HYLO_BACKEND_URL}/oauth`.
  url: string;
  // Static API key the runtime presents to the broker. Today this is a
  // single shared `HYLO_API_KEY`. Will become user/org-derived later.
  appToken: string;
};

// Shared secrets used by every connection in this package. Declared once so
// callers don't need a per-app `oauthBroker.ts` helper. If the user wants to
// override (e.g. point a single connection at a different broker), they pass
// their own `broker` Handle.
const HYLO_BACKEND_URL = secret(
  "HYLO_BACKEND_URL",
  envVar("HYLO_BACKEND_URL"),
  {
    description:
      "Base URL of the Hylo backend hosting the OAuth broker (broker is mounted at <HYLO_BACKEND_URL>/oauth).",
    errorMessage:
      "Set HYLO_BACKEND_URL in the worker environment to point at your Hylo backend.",
  },
);

// Stable dev default — matches the backend-node fallback so local setups
// work without coordinating env vars between worker and backend.
const DEV_API_KEY = "local-dev-hylo-api-key";

const HYLO_API_KEY = secret("HYLO_API_KEY", resolveApiKey(), {
  description:
    "Bearer token presented to the Hylo OAuth broker. Must match the backend's HYLO_API_KEY.",
  errorMessage: "Set HYLO_API_KEY in the worker environment.",
});

function resolveApiKey(): string | undefined {
  const explicit = envVar("HYLO_API_KEY");
  if (explicit) return explicit;
  if (envVar("NODE_ENV") === "production") return undefined;
  return DEV_API_KEY;
}

// Default broker derived from the env-backed secrets above. Most callers use
// this implicitly; advanced callers pass their own `broker` Handle.
export const defaultBroker: Atom<BrokerCredentials> = atom(
  (get) => ({
    url: `${get(HYLO_BACKEND_URL).replace(/\/+$/, "")}/oauth`,
    appToken: get(HYLO_API_KEY),
  }),
  {
    name: "@workflow/integrations-oauth/defaultBroker",
    description: "Resolves OAuth broker URL + API key from worker env.",
  },
);

// Default app base URL for building handoff URLs. Read via `secret()` so CF
// worker bindings resolve it at runtime; falls back to process.env for node.
// Override per connection via the `appBaseUrl` option if your deployment
// uses something different.
const HYLO_APP_URL = secret("HYLO_APP_URL", resolveDefaultAppBaseUrl(), {
  description:
    "Base URL of the app that hosts the OAuth handoff route. On hosted Hylo this is injected at deploy time.",
  errorMessage: "Set HYLO_APP_URL in the worker environment.",
});

export const defaultAppBaseUrl: Atom<string> = atom(
  (get) => get(HYLO_APP_URL),
  {
    name: "@workflow/integrations-oauth/defaultAppBaseUrl",
    description:
      "Resolves the app base URL used to build OAuth handoff redirects.",
  },
);

function resolveDefaultAppBaseUrl(): string {
  const hylo = envVar("HYLO_APP_URL");
  if (hylo) return hylo;
  const next = envVar("NEXT_PUBLIC_APP_URL");
  if (next) return next;
  const vercel = envVar("VERCEL_URL");
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

// Reads a process env var without requiring @types/node. Returns undefined
// in environments without `process` (e.g. some edge runtimes).
function envVar(name: string): string | undefined {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return env?.[name];
}

export type CreateConnectionOptions<Token> = {
  // Provider ID matching one registered with the broker (curated by Hylo:
  // "spotify", "notion", etc.). The broker has the spec + credentials; the
  // worker only needs the ID and the token shape.
  providerId: string;
  // Token shape returned by the broker handoff. Used to parse the
  // intervention payload. Shipped by the integration package alongside the
  // pre-built connection (e.g. `spotifyAuthSchema`).
  tokenSchema: ZodSchema<Token>;
  // Override broker credentials. Defaults to env-backed `defaultBroker`.
  broker?: Handle<BrokerCredentials>;
  // Override the worker app base URL. Defaults to env-backed
  // `defaultAppBaseUrl`. Worker mounts the handoff route here.
  appBaseUrl?: Handle<string>;
  // Path on the worker app where the handoff route is mounted.
  // Defaults to `/api/workflow/integrations/${providerId}/handoff`.
  handoffPath?: string;
  scopes?: string[];
  // Forwarded to the provider's authorize URL via the broker.
  // e.g. `{ show_dialog: "true" }` for Spotify, custom owner params for Notion.
  extra?: Handle<Record<string, string>>;
  // Block this atom on upstream work before requesting authorization.
  waitFor?: Handle<unknown>;
  name?: string;
  description?: string;
  interventionTitle?: string;
  interventionDescription?: string;
  interventionLabel?: string;
};

// Returns an atom that resolves to a brokered OAuth token. The first time any
// downstream atom calls `get()` on this connection, it requests an OAuth
// intervention; once the user authorizes through the broker, the resolved
// token flows back through the handoff route and the atom returns it.
//
// Usage in worker code:
//   import { spotify } from "@workflow/integrations-spotify";
//   const profile = atom(async (get) => {
//     const { accessToken } = get(spotify);
//     return (await fetch("https://api.spotify.com/v1/me", {
//       headers: { Authorization: `Bearer ${accessToken}` },
//     })).json();
//   });
export function createConnection<Token>(
  opts: CreateConnectionOptions<Token>,
): Atom<Token> {
  const broker = opts.broker ?? defaultBroker;
  const appBaseUrlHandle = opts.appBaseUrl ?? defaultAppBaseUrl;
  const handoffPath =
    opts.handoffPath ?? `/api/workflow/integrations/${opts.providerId}/handoff`;

  return atom(
    async (get, requestIntervention, context) => {
      if (opts.waitFor) get(opts.waitFor);

      const brokerCreds = get(broker);
      const appBaseUrl = get(appBaseUrlHandle);
      const extra = opts.extra ? get(opts.extra) : {};
      // Avoid `new URL(path, base)` — a leading slash in `path` wipes
      // the base's path, breaking deployments reachable at {origin}/{id}.
      const runtimeHandoffUrl = /^https?:\/\//i.test(handoffPath)
        ? handoffPath
        : `${appBaseUrl.replace(/\/+$/, "")}/${handoffPath.replace(/^\/+/, "")}`;

      const interventionKey = "oauth-callback";
      const interventionId = context.interventionId(interventionKey);

      const startUrl = `${trimTrailingSlash(brokerCreds.url)}/${opts.providerId}/start`;
      const startResp = await fetch(startUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${brokerCreds.appToken}`,
        },
        body: JSON.stringify({
          runtimeHandoffUrl,
          runId: context.runId,
          interventionId,
          scopes: opts.scopes ?? [],
          extra,
        }),
      });
      if (!startResp.ok) {
        throw new Error(
          `Broker /${opts.providerId}/start failed (${startResp.status}): ${await responseErrorMessage(startResp)}`,
        );
      }
      const { authorizeUrl } = (await startResp.json()) as {
        authorizeUrl: string;
      };

      const resolutionSchema = z.union([opts.tokenSchema, errorSchema]);
      const callback = requestIntervention(interventionKey, resolutionSchema, {
        title:
          opts.interventionTitle ?? `Connect ${capitalize(opts.providerId)}`,
        description:
          opts.interventionDescription ??
          `Authorize ${capitalize(opts.providerId)}. The workflow run will resume automatically once you approve.`,
        action: {
          type: "open_url",
          url: authorizeUrl,
          label:
            opts.interventionLabel ?? `Connect ${capitalize(opts.providerId)}`,
        },
      });

      if (typeof callback === "object" && callback && "error" in callback) {
        return get.skip(
          `${opts.providerId} authorization failed: ${(callback as { error: string }).error}`,
        );
      }
      return callback as Token;
    },
    {
      name: opts.name ?? `${opts.providerId}Connection`,
      description:
        opts.description ??
        `Authorize ${capitalize(opts.providerId)} via the OAuth broker and return the access token.`,
    },
  );
}

// Re-exported `Input` to keep older callers compiling if they passed a login
// input. New API doesn't use it.
export type { Input };

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    // Fall through to the raw response text.
  }
  return text;
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
