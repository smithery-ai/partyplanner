import { createHyloApiClient } from "@hylo/api-client";
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
  redirectUri?: string;
  devMode?: boolean;
};

export function App({ children }: AppProps) {
  const [workos, setWorkos] = useState<WorkOSConfig | null | undefined>();

  useEffect(() => {
    if (workos !== undefined) return;

    const abort = new AbortController();
    void getApiWorkOSConfig(abort.signal)
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
  const isLoginRoute = window.location.pathname === "/login";

  useEffect(() => {
    if (isLoading) return;

    if (isLoginRoute && user) {
      window.history.replaceState({}, "", "/");
    }
  }, [isLoading, isLoginRoute, user]);

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
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Hylo</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Sign in to continue
          </h1>
          <p className="text-sm text-muted-foreground">
            Authenticate to access the client.
          </p>
        </div>
        <button
          type="button"
          onClick={onSignIn}
          disabled={isLoading}
          className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {isLoading ? "Loading..." : "Sign in"}
        </button>
      </div>
    </main>
  );
}

async function getApiWorkOSConfig(
  signal: AbortSignal,
): Promise<WorkOSConfig | null> {
  const client = createHyloApiClient({
    baseUrl: authConfigBackendUrl(),
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal,
      }),
  });
  const config = await client.auth.clientConfig();
  if (!config.auth) return null;

  return {
    clientId: config.auth.clientId,
    apiHostname:
      optionalEnv(import.meta.env.VITE_WORKOS_API_HOSTNAME) ??
      config.auth.apiHostname,
    redirectUri: optionalEnv(import.meta.env.VITE_WORKOS_REDIRECT_URI),
    devMode:
      optionalBooleanEnv(import.meta.env.VITE_WORKOS_DEV_MODE) ??
      (import.meta.env.DEV ? true : undefined),
  };
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

function hyloBackendUrl(): string | undefined {
  return optionalEnv(import.meta.env.VITE_HYLO_BACKEND_URL)?.replace(
    /\/+$/,
    "",
  );
}

function authConfigBackendUrl(): string {
  return hyloBackendUrl() ?? window.location.origin;
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
