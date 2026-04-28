/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HYLO_BACKEND_URL?: string;
  readonly VITE_HYLO_TENANT_ID?: string;
  readonly VITE_HYLO_WORKFLOW?: string;
  readonly VITE_HYLO_WORKFLOW_REGISTRY_URL?: string;
  readonly VITE_HYLO_SIDEBAR_TOP_INSET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
