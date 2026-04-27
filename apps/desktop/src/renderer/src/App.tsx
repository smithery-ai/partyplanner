import { Button } from "@workflow/frontend/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workflow/frontend/components/ui/card";
import { LogOut } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { AuthUser } from "../../shared/auth";

type AppProps = {
  children: (props: {
    getAccessToken: () => Promise<string>;
    sidebarFooter: ReactNode;
  }) => ReactNode;
};

export function App({ children }: AppProps) {
  const { getAccessToken, isLoading, lastError, signIn, signOut, user } =
    useDesktopAuth();

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
    sidebarFooter: (
      <UserFooter
        user={user}
        onSignOut={() => {
          void signOut();
        }}
      />
    ),
  });
}

function useDesktopAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastError, setLastError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof window.setTimeout> | undefined;
    let pollDeadline = 0;

    const refreshUser = () =>
      window.hyloAuth
        .getUser()
        .then((nextUser) => {
          if (cancelled) return;
          setUser(nextUser);
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

    const unsubscribe = window.hyloAuth.onAuthChange(({ user: nextUser }) => {
      setUser(nextUser);
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
    isLoading,
    lastError,
    getAccessToken: () => window.hyloAuth.getAccessToken(),
    signIn: async () => {
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
    },
    signOut: async () => {
      const result = await window.hyloAuth.signOut();
      if (result.success) {
        setUser(null);
      } else {
        setLastError(result.error);
      }
      return result;
    },
  };
}

function UserFooter({
  user,
  onSignOut,
}: {
  user: AuthUser;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
