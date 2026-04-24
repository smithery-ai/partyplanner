export type BackendAppEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_BASE_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_DISPATCH_NAMESPACE?: string;
  CLOUDFLARE_WORKER_COMPATIBILITY_DATE?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CF_DISPATCH_NAMESPACE?: string;
  HYLO_API_KEY?: string;
  HYLO_BACKEND_PUBLIC_URL?: string;
  HYLO_BROKER_BASE_URL?: string;
  HYLO_LOCAL_WORKFLOW_URL_TEMPLATE?: string;
  HYPERDRIVE?: HyperdriveBinding;
  DATABASE_URL?: string;
  POSTGRES_URL?: string;
  HYLO_WORKER_DISPATCH_BASE_URL?: string;
  DISPATCHER?: WorkerDispatchNamespace;
  NODE_ENV?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  WORKOS_API_HOSTNAME?: string;
  WORKOS_CLIENT_API_HOSTNAME?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_ISSUER?: string;
  WORKOS_JWKS_URL?: string;
  VITE_WORKOS_API_HOSTNAME?: string;
  VITE_WORKOS_CLIENT_ID?: string;
};

export type HyperdriveBinding = {
  connectionString: string;
};

export type WorkerDispatchNamespace = {
  get(scriptName: string): { fetch(request: Request): Promise<Response> };
};
