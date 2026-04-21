/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HYLO_WORKFLOW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
