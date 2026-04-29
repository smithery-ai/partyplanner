import type { CurrentUserOrganization } from "@hylo/api-client";
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
import { Check, ChevronsUpDown, Loader2, LogOut } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AuthUser } from "../../shared/auth";

type AppProps = {
  children: (props: {
    getAccessToken: () => Promise<string>;
    organizationId: string | null;
    sidebarFooter: ReactNode;
  }) => ReactNode;
};

type UserOrganizationsState =
  | { status: "loading"; items: [] }
  | { status: "loaded"; items: CurrentUserOrganization[] }
  | { status: "error"; items: [] };

export function App({ children }: AppProps) {
  const {
    getAccessToken,
    isLoading,
    lastError,
    organizationId,
    signIn,
    signOut,
    switchToOrganization,
    user,
  } = useDesktopAuth();
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
        console.warn("[hylo-desktop] failed to load organizations", error);
        setOrganizations({ status: "error", items: [] });
      });

    return () => abort.abort();
  }, [getAccessToken, user]);

  if (isLoading) {
    return <div className="p-6 text-sm">Loading sign-in state...</div>;
  }

  if (!user) {
    return (
      <SignedOutScreen
        error={lastError}
        onSignIn={() => {
          void signIn();
        }}
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
          void switchToOrganization(nextOrganizationId);
        }}
        onSignOut={() => {
          void signOut();
        }}
      />
    ),
  });
}

function useDesktopAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastError, setLastError] = useState<string>();

  const getAccessToken = useCallback(
    () => window.hyloAuth.getAccessToken(),
    [],
  );

  const signIn = useCallback(async () => {
    setIsLoading(true);
    setLastError(undefined);
    const result = await window.hyloAuth.signIn();
    if (!result.success) {
      setLastError(result.error);
      setIsLoading(false);
    } else {
      window.dispatchEvent(new CustomEvent("hylo-auth-poll"));
    }
    return result;
  }, []);

  const signOut = useCallback(async () => {
    const result = await window.hyloAuth.signOut();
    if (result.success) {
      setUser(null);
      setOrganizationId(null);
    } else {
      setLastError(result.error);
    }
    return result;
  }, []);

  const switchToOrganization = useCallback(
    async (nextOrganizationId: string) => {
      const result =
        await window.hyloAuth.switchToOrganization(nextOrganizationId);
      if (!result.success) {
        setLastError(result.error);
      }
      return result;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof window.setTimeout> | undefined;
    let pollDeadline = 0;

    const refreshUser = () =>
      Promise.all([
        window.hyloAuth.getUser(),
        window.hyloAuth.getOrganizationId(),
      ])
        .then(([nextUser, nextOrganizationId]) => {
          if (cancelled) return;
          setUser(nextUser);
          setOrganizationId(nextUser ? nextOrganizationId : null);
          setIsLoading(false);
          if (nextUser) {
            setLastError(undefined);
            pollDeadline = 0;
            if (pollTimer) {
              window.clearTimeout(pollTimer);
              pollTimer = undefined;
            }
          }
        })
        .catch((error) => {
          if (cancelled) return;
          setLastError(errorMessage(error));
          setIsLoading(false);
        });

    const pollForUser = () => {
      if (cancelled) return;
      void refreshUser().finally(() => {
        if (cancelled || pollDeadline === 0 || Date.now() >= pollDeadline) {
          pollDeadline = 0;
          pollTimer = undefined;
          return;
        }
        pollTimer = window.setTimeout(pollForUser, 1000);
      });
    };

    const startAuthPolling = () => {
      pollDeadline = Date.now() + 60_000;
      if (pollTimer) {
        window.clearTimeout(pollTimer);
      }
      pollTimer = window.setTimeout(pollForUser, 250);
    };

    void refreshUser();

    const unsubscribe = window.hyloAuth.onAuthChange((payload) => {
      const nextUser = payload.user;
      setUser(nextUser);
      setOrganizationId(nextUser ? payload.organizationId : null);
      setIsLoading(false);
      setLastError(undefined);
    });

    const handleFocus = () => {
      void refreshUser();
    };
    const handleAuthPoll = () => {
      startAuthPolling();
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener("hylo-auth-poll", handleAuthPoll);
    document.addEventListener("visibilitychange", handleFocus);

    return () => {
      cancelled = true;
      if (pollTimer) {
        window.clearTimeout(pollTimer);
      }
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("hylo-auth-poll", handleAuthPoll);
      document.removeEventListener("visibilitychange", handleFocus);
      unsubscribe();
    };
  }, []);

  return {
    user,
    organizationId,
    isLoading,
    lastError,
    getAccessToken,
    signIn,
    signOut,
    switchToOrganization,
  };
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
  user: AuthUser;
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
  error,
  onSignIn,
}: {
  error?: string;
  onSignIn: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader className="gap-2 px-8 pt-8">
          <p className="text-sm font-medium text-muted-foreground">
            Hylo Desktop
          </p>
          <CardTitle className="text-2xl">Sign in to continue</CardTitle>
          <CardDescription>
            Authenticate in the sign-in window, then return to the app.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8">
          <Button
            type="button"
            onClick={onSignIn}
            size="lg"
            className="mt-2 w-full"
          >
            Sign in
          </Button>
          {error ? (
            <p className="mt-3 text-xs text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

function displayName(user: AuthUser) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return fullName || user.email;
}

function userInitials(user: AuthUser) {
  const first = user.firstName?.[0];
  const last = user.lastName?.[0];
  const initials = `${first ?? ""}${last ?? ""}` || user.email[0] || "H";
  return initials.toUpperCase();
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

function authConfigBackendUrl(): string {
  return (
    optionalEnv(import.meta.env.VITE_HYLO_BACKEND_URL)?.replace(/\/+$/, "") ??
    ""
  );
}

function optionalEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
