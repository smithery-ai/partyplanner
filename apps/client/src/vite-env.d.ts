/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HYLO_BACKEND_URL?: string;
  readonly VITE_HYLO_TENANT_ID?: string;
  readonly VITE_HYLO_WORKFLOW?: string;
  readonly VITE_HYLO_WORKFLOW_REGISTRY_URL?: string;
  readonly VITE_WORKOS_API_HOSTNAME?: string;
  readonly VITE_WORKOS_DEV_MODE?: string;
  readonly VITE_WORKOS_REDIRECT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __HYLO_WORKFLOWS__: {
  defaultWorkflow?: string;
  workflows: Record<
    string,
    {
      label?: string;
      url: string;
    }
  >;
};
