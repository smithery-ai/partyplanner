import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./generated/schema.js";

export type {
  components,
  operations,
  paths,
} from "./generated/schema.js";

export type CreateDeploymentRequest = RequestJsonBody<
  paths["/deployments"]["post"]
>;
export type AuthClientConfig =
  paths["/auth/client-config"]["get"]["responses"][200]["content"]["application/json"];
export type CurrentIdentity =
  paths["/me"]["get"]["responses"][200]["content"]["application/json"];
export type WorkflowDeployment =
  paths["/tenants/{tenantId}/deployments"]["get"]["responses"][200]["content"]["application/json"]["deployments"][number];

export type HyloApiClientOptions = {
  apiKey?: string;
  accessToken?: string;
  baseUrl: string;
  bearerToken?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
};

export type DeploymentFilter =
  | { tenantId: string; tag?: never }
  | { tag: string; tenantId?: never };

export class HyloApiError extends Error {
  readonly response: Response;
  readonly error: unknown;

  constructor(response: Response, error: unknown) {
    super(`Hylo API request failed with HTTP ${response.status}.`);
    this.name = "HyloApiError";
    this.response = response;
    this.error = error;
  }
}

export function createHyloApiClient(options: HyloApiClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    fetch: options.fetch,
  });

  return {
    raw: client,
    auth: {
      clientConfig: () => unwrap(client.GET("/auth/client-config")),
      me: () =>
        unwrap(
          client.GET("/me", {
            headers: requestHeaders(options),
          }),
        ),
    },
    deployments: {
      list: (filter?: DeploymentFilter) =>
        unwrap(
          client.GET("/deployments", {
            headers: requestHeaders(options),
            params: filter ? { query: filter } : undefined,
          }),
        ),
      create: (body: CreateDeploymentRequest) =>
        unwrap(
          client.POST("/deployments", {
            body,
            headers: requestHeaders(options),
          }),
        ),
      deleteMany: (filter: DeploymentFilter) =>
        unwrap(
          client.DELETE("/deployments", {
            headers: requestHeaders(options),
            params: { query: filter },
          }),
        ),
      get: (deploymentId: string) =>
        unwrap(
          client.GET("/deployments/{deploymentId}", {
            headers: requestHeaders(options),
            params: { path: { deploymentId } },
          }),
        ),
      delete: (deploymentId: string) =>
        unwrap(
          client.DELETE("/deployments/{deploymentId}", {
            headers: requestHeaders(options),
            params: { path: { deploymentId } },
          }),
        ),
    },
    tenants: {
      listDeployments: (tenantId: string) =>
        unwrap(
          client.GET("/tenants/{tenantId}/deployments", {
            headers: requestHeaders(options),
            params: { path: { tenantId } },
          }),
        ),
      getWorkflows: (tenantId: string) =>
        unwrap(
          client.GET("/tenants/{tenantId}/workflows", {
            headers: requestHeaders(options),
            params: { path: { tenantId } },
          }),
        ),
    },
  };
}

type RequestJsonBody<Operation> = Operation extends {
  requestBody: { content: { "application/json": infer Body } };
}
  ? Body
  : never;

function requestHeaders(options: HyloApiClientOptions): HeadersInit {
  const token = options.bearerToken ?? options.accessToken ?? options.apiKey;
  return {
    ...headersToObject(options.headers),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function headersToObject(headers: HeadersInit | undefined): HeadersInit {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return headers;
}

async function unwrap<T>(
  result: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await result;
  if (response.ok && data !== undefined) return data;
  throw new HyloApiError(response, error);
}

export type HyloApiClient = ReturnType<typeof createHyloApiClient>;
export type HyloRawOpenApiClient = Client<paths>;
