interface ImportMetaEnv {
  readonly MAIN_VITE_WORKOS_AUTHKIT_HOSTNAME?: string;
  readonly MAIN_VITE_HYLO_BACKEND_URL?: string;
  readonly MAIN_VITE_WORKOS_API_HOSTNAME?: string;
  readonly MAIN_VITE_WORKOS_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
