import {
  type CurrentUserOrganization,
  createHyloApiClient,
} from "@hylo/api-client";
import { Button } from "@workflow/frontend/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workflow/frontend/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workflow/frontend/components/ui/dropdown-menu";
import { AuthKitProvider, type User, useAuth } from "@workos-inc/authkit-react";
import { Check, ChevronsUpDown, Loader2, LogOut } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

type AppProps = {
  children: (props: {
    getAccessToken: () => Promise<string>;
    organizationId: string | null;
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

type UserOrganizationsState =
  | { status: "loading"; items: [] }
  | { status: "loaded"; items: CurrentUserOrganization[] }
  | { status: "error"; items: [] };

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
  const {
    getAccessToken,
    isLoading,
    organizationId,
    signIn,
    signOut,
    switchToOrganization,
    user,
  } = useAuth();
  const [organizations, setOrganizations] = useState<UserOrganizationsState>({
    status: "loading",
    items: [],
  });

  useEffect(() => {
    if (!user) return;

    const abort = new AbortController();
    setOrganizations({ status: "loading", items: [] });
    void getAccessToken()
      .then((accessToken) => getUserOrganizations(accessToken, abort.signal))
      .then((items) => {
        if (!abort.signal.aborted) {
          setOrganizations({ status: "loaded", items });
        }
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        console.warn("[hylo-client] failed to load organizations", error);
        setOrganizations({ status: "error", items: [] });
      });

    return () => abort.abort();
  }, [getAccessToken, user]);

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
    organizationId,
    sidebarFooter: (
      <UserFooter
        currentOrganizationId={organizationId}
        organizations={organizations}
        user={user}
        onOrganizationSelect={(nextOrganizationId) => {
          if (nextOrganizationId === organizationId) return;
          void switchToOrganization({
            organizationId: nextOrganizationId,
            signInOpts: { state: { returnTo: currentReturnTo() } },
          });
        }}
        onSignOut={() => signOut({ returnTo: window.location.origin })}
      />
    ),
  });
}

function UserFooter({
  currentOrganizationId,
  organizations,
  user,
  onOrganizationSelect,
  onSignOut,
}: {
  currentOrganizationId: string | null;
  organizations: UserOrganizationsState;
  user: User;
  onOrganizationSelect: (organizationId: string) => void;
  onSignOut: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
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
          <ChevronsUpDown
            className="size-3.5 shrink-0 opacity-70"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          Organizations
        </DropdownMenuLabel>
        <OrganizationMenuItems
          currentOrganizationId={currentOrganizationId}
          organizations={organizations}
          onOrganizationSelect={onOrganizationSelect}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={onSignOut}
          className="cursor-pointer"
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OrganizationMenuItems({
  currentOrganizationId,
  organizations,
  onOrganizationSelect,
}: {
  currentOrganizationId: string | null;
  organizations: UserOrganizationsState;
  onOrganizationSelect: (organizationId: string) => void;
}) {
  if (organizations.status === "loading") {
    return (
      <DropdownMenuItem disabled>
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading organizations
      </DropdownMenuItem>
    );
  }

  if (organizations.status === "error") {
    return (
      <DropdownMenuItem disabled>
        Organization list unavailable
      </DropdownMenuItem>
    );
  }

  if (organizations.items.length === 0) {
    return <DropdownMenuItem disabled>No organizations</DropdownMenuItem>;
  }

  return organizations.items.map((organization) => {
    const selected = organization.id === currentOrganizationId;
    return (
      <DropdownMenuItem
        key={organization.id}
        disabled={selected}
        onSelect={() => onOrganizationSelect(organization.id)}
        className="cursor-pointer gap-2"
      >
        <span
          className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-[0.65rem] font-semibold text-muted-foreground"
          aria-hidden
        >
          {organizationInitials(organization.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{organization.name}</span>
          {organization.role ? (
            <span className="block truncate text-xs text-muted-foreground">
              {roleLabel(organization.role)}
            </span>
          ) : null}
        </span>
        {selected ? <Check className="size-4 shrink-0" aria-hidden /> : null}
      </DropdownMenuItem>
    );
  });
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

async function getUserOrganizations(
  accessToken: string,
  signal: AbortSignal,
): Promise<CurrentUserOrganization[]> {
  const response = await fetch(`${authConfigBackendUrl()}/me/organizations`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to load organizations with HTTP ${response.status}.`,
    );
  }
  const body = (await response.json()) as {
    organizations?: CurrentUserOrganization[];
  };
  return body.organizations ?? [];
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

function organizationInitials(name: string) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
  return (initials || name[0] || "O").toUpperCase();
}

function roleLabel(role: string) {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
