import { createHyloApiClient } from "@hylo/api-client";
import { Button } from "@workflow/frontend/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workflow/frontend/components/ui/card";
import { AuthKitProvider, type User, useAuth } from "@workos-inc/authkit-react";
import { LogOut } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

type AppProps = {
  children: (props: {
    getAccessToken: () => Promise<string>;
    sidebarFooter: ReactNode;
  }) => ReactNode;
};

type WorkOSConfig = {
  clientId: string;
  apiHostname?: string;
  https?: boolean;
  port?: number;
  redirectUri?: string;
  devMode?: boolean;
};

export function App({ children }: AppProps) {
  const [workos, setWorkos] = useState<WorkOSConfig | null | undefined>();

  useEffect(() => {
    if (workos !== undefined) return;

    const abort = new AbortController();
    void getWorkOSConfig(abort.signal)
      .then((config) => {
        if (!abort.signal.aborted) setWorkos(config);
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          console.warn("[hylo-client] failed to load auth config", error);
          setWorkos(null);
        }
      });

    return () => abort.abort();
  }, [workos]);

  if (workos === undefined) {
    return <div className="p-6 text-sm">Loading sign-in configuration...</div>;
  }

  if (!workos) {
    return (
      <div className="p-6 text-sm">
        WorkOS AuthKit is not configured for this Hylo backend.
      </div>
    );
  }

  return (
    <AuthKitProvider
      clientId={workos.clientId}
      apiHostname={workos.apiHostname}
      https={workos.https}
      port={workos.port}
      redirectUri={workos.redirectUri}
      devMode={workos.devMode}
      onRedirectCallback={handleRedirectCallback}
    >
      <AuthenticatedApp>{children}</AuthenticatedApp>
    </AuthKitProvider>
  );
}

function AuthenticatedApp({ children }: AppProps) {
  const { getAccessToken, isLoading, user, signIn, signOut } = useAuth();

  if (!user) {
    return (
      <SignedOutScreen
        isLoading={isLoading}
        onSignIn={() => void signIn({ state: { returnTo: currentReturnTo() } })}
      />
    );
  }

  return children({
    getAccessToken,
    sidebarFooter: (
      <UserFooter
        user={user}
        onSignOut={() => signOut({ returnTo: window.location.origin })}
      />
    ),
  });
}

function UserFooter({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {user.profilePictureUrl ? (
        <img
          className="size-7 shrink-0 rounded-full object-cover"
          src={user.profilePictureUrl}
          alt=""
        />
      ) : (
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-sidebar-accent text-[0.7rem] font-semibold text-sidebar-accent-foreground"
          aria-hidden
        >
          {userInitials(user)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {displayName(user)}
      </span>
      <button
        type="button"
        onClick={onSignOut}
        aria-label="Sign out"
        title="Sign out"
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <LogOut className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function SignedOutScreen({
  isLoading,
  onSignIn,
}: {
  isLoading: boolean;
  onSignIn: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader className="gap-2 px-8 pt-8">
          <p className="text-sm font-medium text-muted-foreground">Hylo</p>
          <CardTitle className="text-2xl">Sign in to continue</CardTitle>
          <CardDescription>Authenticate to access the client.</CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8">
          <Button
            type="button"
            onClick={onSignIn}
            disabled={isLoading}
            size="lg"
            className="mt-2 w-full"
          >
            {isLoading ? "Loading..." : "Sign in"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

type BackendAuthConfig = Awaited<
  ReturnType<ReturnType<typeof createHyloApiClient>["auth"]["clientConfig"]>
>;

async function getWorkOSConfig(
  signal: AbortSignal,
): Promise<WorkOSConfig | null> {
  const clientId = optionalEnv(import.meta.env.VITE_WORKOS_CLIENT_ID);
  const config = await getBackendAuthConfig(signal, Boolean(clientId));
  const backendAuth = config?.auth;
  const resolvedClientId = clientId ?? backendAuth?.clientId;
  if (!resolvedClientId) return null;

  const apiConfig = workOSApiConfig();
  return {
    clientId: resolvedClientId,
    ...apiConfig,
    redirectUri:
      optionalEnv(import.meta.env.VITE_WORKOS_REDIRECT_URI) ??
      (import.meta.env.DEV ? window.location.origin : undefined),
    devMode: resolveWorkOSDevMode(apiConfig),
  };
}

async function getBackendAuthConfig(
  signal: AbortSignal,
  optional: boolean,
): Promise<BackendAuthConfig | null> {
  const client = createHyloApiClient({
    baseUrl: authConfigBackendUrl(),
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal,
      }),
  });
  try {
    return await client.auth.clientConfig();
  } catch (error) {
    if (!optional) throw error;
    console.warn("[hylo-client] failed to load backend auth config", error);
    return null;
  }
}

function workOSApiConfig(): {
  apiHostname: string;
  https?: boolean;
  port?: number;
  devMode?: boolean;
} {
  if (!import.meta.env.DEV) {
    // authkit-js 0.20.x hardcodes /user_management/* endpoints. The current
    // first-party AuthKit domain serves /oauth2/* but not /user_management/*.
    const hostname = "api.workos.com";
    return {
      apiHostname: hostname,
      devMode: true,
    };
  }

  const port = Number(window.location.port);
  return {
    apiHostname: window.location.hostname,
    https: window.location.protocol === "https:",
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
  };
}

function resolveWorkOSDevMode(apiConfig: {
  devMode?: boolean;
}): boolean | undefined {
  if (!import.meta.env.DEV) return apiConfig.devMode;
  return optionalBooleanEnv(import.meta.env.VITE_WORKOS_DEV_MODE) ?? true;
}

function handleRedirectCallback({
  state,
}: {
  state: Record<string, unknown> | null;
}) {
  const fallback = "/";
  const returnTo =
    state && typeof state.returnTo === "string" ? state.returnTo : fallback;
  window.history.replaceState({}, "", sameOriginPath(returnTo) ?? fallback);
}

function currentReturnTo() {
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return path === "/login" ? "/" : path;
}

function sameOriginPath(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function optionalEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function authConfigBackendUrl(): string {
  return "/api";
}

function displayName(user: User) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return fullName || user.email;
}

function userInitials(user: User) {
  const first = user.firstName?.[0];
  const last = user.lastName?.[0];
  const initials = `${first ?? ""}${last ?? ""}` || user.email[0] || "H";
  return initials.toUpperCase();
}
