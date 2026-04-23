import { AuthKitProvider, type User, useAuth } from "@workos-inc/authkit-react";
import { LogOut } from "lucide-react";
import { type ReactNode, useEffect } from "react";

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
  const workos = getWorkOSConfig();

  if (!workos) {
    return (
      <div className="p-6 text-sm">
        Set VITE_WORKOS_CLIENT_ID before starting the client.
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
      onRefreshFailure={({ signIn }) => {
        void signIn({ state: { returnTo: currentReturnTo() } });
      }}
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
      return;
    }

    if (!user) {
      void signIn({ state: { returnTo: currentReturnTo() } });
    }
  }, [isLoading, isLoginRoute, signIn, user]);

  if (!user) return null;

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

function getWorkOSConfig(): WorkOSConfig | null {
  const clientId = optionalEnv(import.meta.env.VITE_WORKOS_CLIENT_ID);
  if (!clientId) return null;

  const apiHostname =
    optionalEnv(import.meta.env.VITE_WORKOS_API_HOSTNAME) ??
    defaultWorkOSApiHostname();
  const redirectUri = optionalEnv(import.meta.env.VITE_WORKOS_REDIRECT_URI);
  const configuredDevMode = optionalBooleanEnv(
    import.meta.env.VITE_WORKOS_DEV_MODE,
  );
  const devMode = configuredDevMode ?? (import.meta.env.DEV ? true : undefined);

  return {
    clientId,
    apiHostname,
    redirectUri,
    devMode,
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

function defaultWorkOSApiHostname() {
  if (!import.meta.env.DEV) return undefined;
  return window.location.hostname.endsWith(".localhost")
    ? window.location.hostname
    : undefined;
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
