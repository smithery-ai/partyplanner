import { ArrowLeft } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

export type SlackSettingsWorkflowOption = {
  id: string;
  label: string;
  apiUrl: string;
};

type SlackInstallation = {
  installationKey: string;
  identity: Record<string, string>;
  runtimeHandoffUrl?: string;
  updatedAt: number;
};

export function SlackSettingsPage({
  backendUrl,
  workflowOptions,
  onBack,
}: {
  backendUrl?: string;
  workflowOptions: SlackSettingsWorkflowOption[];
  onBack?: () => void;
}): ReactNode {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    () => workflowOptions[0]?.id ?? "",
  );
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [installations, setInstallations] = useState<
    SlackInstallation[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowOptions.some((option) => option.id === selectedWorkflowId)) {
      setSelectedWorkflowId(workflowOptions[0]?.id ?? "");
    }
  }, [workflowOptions, selectedWorkflowId]);

  const refreshInstallations = useCallback(async () => {
    if (!backendUrl) return;
    try {
      const res = await fetch(
        `${backendUrl.replace(/\/+$/, "")}/integrations/slack/installations`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        installations?: SlackInstallation[];
      };
      setInstallations(data.installations ?? []);
    } catch {
      // Best-effort.
    }
  }, [backendUrl]);

  useEffect(() => {
    void refreshInstallations();
  }, [refreshInstallations]);

  const selectedWorkflow = workflowOptions.find(
    (option) => option.id === selectedWorkflowId,
  );
  const hasInstallations = (installations?.length ?? 0) > 0;

  const handleInstall = async () => {
    if (!backendUrl) {
      setError("Backend URL is not configured.");
      return;
    }
    if (!selectedWorkflow) {
      setError("Pick a workflow to route Slack events to.");
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      const runtimeHandoffUrl = `${selectedWorkflow.apiUrl.replace(
        /\/+$/,
        "",
      )}/integrations/slack/handoff`;
      const clientReturnUrl = `${window.location.origin}/settings/slack`;
      const res = await fetch(
        `${backendUrl.replace(/\/+$/, "")}/oauth/slack/install-url`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runtimeHandoffUrl, clientReturnUrl }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Install URL request failed (${res.status})`);
      }
      const data = (await res.json()) as { authorizeUrl?: string };
      if (!data.authorizeUrl) throw new Error("Missing authorizeUrl response.");
      window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
      void refreshInstallations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleRemove = async (installationKey: string) => {
    if (!backendUrl) return;
    setRemoving(installationKey);
    setError(null);
    try {
      const res = await fetch(
        `${backendUrl.replace(/\/+$/, "")}/integrations/slack/installations/${encodeURIComponent(
          installationKey,
        )}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Remove failed (${res.status})`);
      }
      await refreshInstallations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-off-white text-off-black">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" aria-hidden /> Back to chats
          </button>
        ) : null}
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Slack</h1>
          <p className="text-sm text-muted-foreground">
            Install the Slack app and pick which worker should receive its
            events. You can reconfigure or remove an install at any time.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">
              {hasInstallations ? "Reconfigure worker" : "Worker"}
            </h2>
            <p className="text-xs text-muted-foreground">
              Slack events for the installed workspace will forward to this
              worker's generic webhook endpoint.
            </p>
          </div>
          <Select
            value={selectedWorkflowId}
            onValueChange={(value) => setSelectedWorkflowId(value ?? "")}
            disabled={installing || workflowOptions.length === 0}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  workflowOptions.length === 0
                    ? "No workers available"
                    : "Pick a worker"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {workflowOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => void handleInstall()}
            disabled={installing || !selectedWorkflow}
            className="self-start"
          >
            {installing
              ? "Opening Slack…"
              : hasInstallations
                ? "Reconfigure"
                : "Add to Slack"}
          </Button>
        </section>

        {hasInstallations ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Installed workspaces</h2>
            <ul className="flex flex-col gap-2">
              {installations?.map((install) => {
                const teamId = install.identity.teamId ?? "(unknown team)";
                const enterpriseId = install.identity.enterpriseId;
                return (
                  <li
                    key={install.installationKey}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">{teamId}</span>
                      {enterpriseId ? (
                        <span className="text-muted-foreground text-xs">
                          Enterprise {enterpriseId}
                        </span>
                      ) : null}
                      {install.runtimeHandoffUrl ? (
                        <span
                          className="text-muted-foreground text-xs break-all"
                          title={install.runtimeHandoffUrl}
                        >
                          Routes to {install.runtimeHandoffUrl}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          No worker bound
                        </span>
                      )}
                    </div>
                    <Button
                      variant="destructive"
                      onClick={() => void handleRemove(install.installationKey)}
                      disabled={
                        installing || removing === install.installationKey
                      }
                      className="shrink-0"
                    >
                      {removing === install.installationKey
                        ? "Removing…"
                        : "Remove"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </div>
    </div>
  );
}
