import type {
  AuthChangePayload,
  AuthIpcResult,
  AuthUser,
} from "../../shared/auth";

declare global {
  interface Window {
    hyloAuth: {
      signIn: () => Promise<AuthIpcResult>;
      signOut: () => Promise<AuthIpcResult>;
      switchToOrganization: (organizationId: string) => Promise<AuthIpcResult>;
      getUser: () => Promise<AuthUser | null>;
      getAccessToken: () => Promise<string>;
      getOrganizationId: () => Promise<string | null>;
      onAuthChange: (
        callback: (payload: AuthChangePayload) => void,
      ) => () => void;
    };
  }
}
