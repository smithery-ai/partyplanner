/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_BACKEND_NODE_URL?: string;
  readonly VITE_BACKEND_WORKER_URL?: string;
  readonly VITE_CLOUDFLARE_WORKER_URL?: string;
  readonly VITE_HYLO_BACKEND_URL?: string;
  readonly VITE_NEXTJS_WORKER_URL?: string;
  readonly VITE_RESOLVED_BACKEND_NODE_URL?: string;
  readonly VITE_RESOLVED_BACKEND_WORKER_URL?: string;
  readonly VITE_WORKFLOW_API_URL?: string;
  readonly VITE_WORKFLOW_WORKER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
