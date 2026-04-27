export const AUTH_CHANNELS = {
  GET_ACCESS_TOKEN: "auth:get-access-token",
  GET_USER: "auth:get-user",
  ON_AUTH_CHANGE: "auth:on-auth-change",
  SIGN_IN: "auth:sign-in",
  SIGN_OUT: "auth:sign-out",
} as const;

export type AuthUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
};

export type AuthChangePayload = {
  user: AuthUser | null;
};

export type AuthIpcResult = {
  success: boolean;
  error?: string;
};
