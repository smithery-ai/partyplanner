/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HYLO_WORKFLOW?: string;
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
