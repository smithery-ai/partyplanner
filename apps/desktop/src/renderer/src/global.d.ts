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
      getUser: () => Promise<AuthUser | null>;
      getAccessToken: () => Promise<string>;
      onAuthChange: (
        callback: (payload: AuthChangePayload) => void,
      ) => () => void;
    };
  }
}

export {};
