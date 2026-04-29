import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  KeyRound,
  Link2,
  Loader2,
  Play,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { workflowInputLabel } from "../lib/workflow-labels";
import type {
  WorkflowInputManifest,
  WorkflowManagedConnectionManifest,
} from "../types";
import { JsonSchemaForm } from "./json-schema-form";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Step = "secrets" | "connections" | "choose";

export type ManagedConnectionDisplayState = {
  status: "not_connected" | "connecting" | "connected" | "error";
  waitingOn?: string;
  actionUrl?: string;
};

export function StartWorkflowForm({
  inputs,
  managedConnections,
  managedConnectionStates,
  inputValues,
  onInputValuesChange,
  canSubmitSeed,
  onSubmitSeed,
  onConnectManagedConnection,
  onClearManagedConnection,
  connectingManagedConnectionId,
  clearingManagedConnectionId,
  error,
  starting,
}: {
  inputs: WorkflowInputManifest[];
  managedConnections: WorkflowManagedConnectionManifest[];
  managedConnectionStates?: Record<string, ManagedConnectionDisplayState>;
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  canSubmitSeed: boolean;
  onSubmitSeed: (inputId?: string) => void;
  onConnectManagedConnection: (
    connectionId: string,
    options?: { restart?: boolean },
  ) => void;
  connectingManagedConnectionId?: string;
  onClearManagedConnection: (connectionId: string) => void;
  clearingManagedConnectionId?: string;
  error?: string;
  starting?: boolean;
}) {
  const immediate = inputs.filter(
    (input) =>
      input.kind === "input" &&
      !input.internal &&
      !(input.secret && input.resolved),
  );
  const dataInputs = immediate.filter((input) => !input.secret);
  const secrets = immediate.filter((input) => input.secret);
  const visibleManagedConnections = managedConnections.filter(
    (connection) => !connection.internal,
  );
  const unresolvedRequiredConnections = visibleManagedConnections.filter(
    (connection) =>
      managedConnectionStates?.[connection.id]?.status !== "connected",
  );
  const startBlockedByManagedConnections =
    unresolvedRequiredConnections.length > 0;

  const allSecretsResolved = useMemo(
    () =>
      secrets.every(
        (s) => s.resolved === true || secretStringValue(inputValues[s.id]),
      ),
    [secrets, inputValues],
  );
  const secretsNeedAttention = secrets.length > 0 && !allSecretsResolved;
  const canStartBlank =
    canSubmitSeed && !starting && !startBlockedByManagedConnections;

  const [step, setStep] = useState<Step>(
    secretsNeedAttention
      ? "secrets"
      : visibleManagedConnections.length > 0
        ? "connections"
        : "choose",
  );
  const [selectedInputId, setSelectedInputId] = useState<string | null>(
    dataInputs.length === 1 ? dataInputs[0].id : null,
  );

  useEffect(() => {
    if (secretsNeedAttention) {
      setStep("secrets");
    }
  }, [secretsNeedAttention]);

  useEffect(() => {
    if (step === "choose" && startBlockedByManagedConnections) {
      setStep("connections");
    }
  }, [startBlockedByManagedConnections, step]);

  useEffect(() => {
    if (dataInputs.length === 1 && selectedInputId == null) {
      setSelectedInputId(dataInputs[0].id);
    }
  }, [dataInputs, selectedInputId]);

  if (immediate.length === 0 && visibleManagedConnections.length === 0) {
    return (
      <Shell
        title="Start the workflow"
        description="This workflow has no immediate inputs."
      >
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={() => onSubmitSeed()}
            disabled={!canStartBlank}
            aria-busy={starting}
          >
            {starting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {starting ? "Starting" : "Start"}
          </Button>
        </div>
      </Shell>
    );
  }

  if (step === "secrets" && secrets.length > 0) {
    return (
      <Shell
        title="Secrets"
        description="Secrets are resolved on the server. Enter values for missing secrets to use with this run."
      >
        <div className="space-y-2">
          {secrets.map((input) => (
            <SecretStatusRow
              key={input.id}
              input={input}
              value={secretStringValue(inputValues[input.id])}
              onChange={(value) => onInputValuesChange(input.id, value)}
            />
          ))}
        </div>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSubmitSeed()}
            disabled={!canStartBlank}
            aria-busy={starting}
          >
            {starting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            Blank run
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!allSecretsResolved}
            onClick={() =>
              setStep(
                visibleManagedConnections.length > 0 ? "connections" : "choose",
              )
            }
          >
            Next
            <ArrowRight className="size-3.5" aria-hidden />
          </Button>
        </div>
      </Shell>
    );
  }

  if (step === "connections" && visibleManagedConnections.length > 0) {
    return (
      <Shell
        title="Managed connections"
        description="Connect every managed service this worker depends on before triggering a run."
        onBack={secretsNeedAttention ? () => setStep("secrets") : undefined}
      >
        <ManagedConnectionsPanel
          managedConnections={visibleManagedConnections}
          managedConnectionStates={managedConnectionStates}
          unresolvedRequiredConnections={unresolvedRequiredConnections}
          connectingManagedConnectionId={connectingManagedConnectionId}
          clearingManagedConnectionId={clearingManagedConnectionId}
          onConnectManagedConnection={onConnectManagedConnection}
          onClearManagedConnection={onClearManagedConnection}
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            disabled={startBlockedByManagedConnections}
            onClick={() => setStep("choose")}
          >
            Next
            <ArrowRight className="size-3.5" aria-hidden />
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Start the workflow"
      description={
        dataInputs.length > 1
          ? "Choose how you want to start this workflow."
          : undefined
      }
      onBack={
        visibleManagedConnections.length > 0
          ? () => setStep("connections")
          : secretsNeedAttention
            ? () => setStep("secrets")
            : undefined
      }
    >
      {dataInputs.length === 0 ? (
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={() => onSubmitSeed()}
            disabled={!canStartBlank}
            aria-busy={starting}
          >
            {starting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {starting ? "Starting" : "Start blank run"}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                Blank run
              </p>
              <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                Start without an initial input.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => onSubmitSeed()}
              disabled={!canStartBlank}
              aria-busy={starting}
            >
              {starting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Play className="size-3.5" aria-hidden />
              )}
              {starting ? "Starting" : "Start"}
            </Button>
          </div>
          {dataInputs.map((input) => {
            const expanded = selectedInputId === input.id;
            return (
              <InputOption
                key={input.id}
                input={input}
                expanded={expanded}
                onSelect={() => setSelectedInputId(expanded ? null : input.id)}
                value={inputValues[input.id]}
                onChange={(value) => onInputValuesChange(input.id, value)}
                canSubmit={
                  canSubmitSeed &&
                  !starting &&
                  !startBlockedByManagedConnections
                }
                starting={starting}
                onSubmit={() => onSubmitSeed(input.id)}
              />
            );
          })}
        </div>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Shell>
  );
}

function Shell({
  title,
  description,
  onBack,
  children,
}: {
  title?: string;
  description?: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pointer-events-auto flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-card/95 p-6 shadow-lg backdrop-blur-sm">
      {title ? (
        <header className="space-y-1">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              ← Back to secrets
            </button>
          ) : null}
          <h2 className="font-semibold text-sm">{title}</h2>
          {description ? (
            <p className="text-muted-foreground text-xs leading-snug">
              {description}
            </p>
          ) : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}

function SecretStatusRow({
  input,
  value,
  onChange,
}: {
  input: WorkflowInputManifest;
  value: string;
  onChange: (value: string) => void;
}) {
  const resolved = input.resolved === true;
  const provided = !resolved && value.length > 0;
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-3",
        resolved
          ? "border-emerald-500/40 bg-emerald-500/5"
          : provided
            ? "border-blue-500/40 bg-blue-500/5"
            : "border-yellow-500/50 bg-yellow-500/5",
      )}
    >
      {resolved ? (
        <Check
          className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
          aria-hidden
        />
      ) : provided ? (
        <KeyRound
          className="mt-0.5 size-3.5 shrink-0 text-blue-700 dark:text-blue-400"
          aria-hidden
        />
      ) : (
        <AlertTriangle
          className="mt-0.5 size-3.5 shrink-0 text-yellow-700 dark:text-yellow-500"
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <code className="block truncate text-[11px] text-foreground">
          {input.id}
        </code>
        {input.description ? (
          <p className="text-muted-foreground text-[11px] leading-snug">
            {input.description}
          </p>
        ) : null}
        <p
          className={cn(
            "text-[11px] leading-snug",
            resolved
              ? "text-emerald-700 dark:text-emerald-400"
              : provided
                ? "text-blue-800 dark:text-blue-300"
                : "text-yellow-800 dark:text-yellow-300",
          )}
        >
          {resolved
            ? "Resolved by the workflow."
            : provided
              ? "Provided for this run."
              : (input.errorMessage ??
                "Missing — resolve this secret in the workflow server.")}
        </p>
        {!resolved ? (
          <div className="grid gap-1.5">
            <label
              className="text-[11px] font-medium text-muted-foreground"
              htmlFor={`secret-${input.id}`}
            >
              Secret
            </label>
            <Input
              id={`secret-${input.id}`}
              type="password"
              value={value}
              onChange={(e) => onChange(e.currentTarget.value)}
              placeholder="Secret value"
              autoComplete="off"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ManagedConnectionsPanel({
  managedConnections,
  managedConnectionStates,
  unresolvedRequiredConnections,
  connectingManagedConnectionId,
  clearingManagedConnectionId,
  onConnectManagedConnection,
  onClearManagedConnection,
}: {
  managedConnections: WorkflowManagedConnectionManifest[];
  managedConnectionStates?: Record<string, ManagedConnectionDisplayState>;
  unresolvedRequiredConnections: WorkflowManagedConnectionManifest[];
  connectingManagedConnectionId?: string;
  clearingManagedConnectionId?: string;
  onConnectManagedConnection: (
    connectionId: string,
    options?: { restart?: boolean },
  ) => void;
  onClearManagedConnection: (connectionId: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-3">
      <p className="text-muted-foreground text-[11px] leading-snug">
        {unresolvedRequiredConnections.length > 0
          ? "Connect the required managed services before sending workflow inputs to this worker."
          : "All managed connections are ready. Reauth or clear them here any time you need to change credentials."}
      </p>
      <div className="space-y-2">
        {managedConnections.map((connection) => (
          <ManagedConnectionRow
            key={connection.id}
            connection={connection}
            state={managedConnectionStates?.[connection.id]}
            connecting={connectingManagedConnectionId === connection.id}
            clearing={clearingManagedConnectionId === connection.id}
            onConnect={(options) =>
              onConnectManagedConnection(connection.id, options)
            }
            onClear={() => onClearManagedConnection(connection.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ManagedConnectionRow({
  connection,
  state,
  connecting,
  clearing,
  onConnect,
  onClear,
}: {
  connection: WorkflowManagedConnectionManifest;
  state?: ManagedConnectionDisplayState;
  connecting: boolean;
  clearing: boolean;
  onConnect: (options?: { restart?: boolean }) => void;
  onClear: () => void;
}) {
  const blocked = connection.requirement === "preflight";
  const waitingOnOauth =
    state?.status === "connecting" &&
    state.waitingOn === `${connection.id}:oauth-callback`;
  const connected = state?.status === "connected";
  const busy = connecting || clearing;
  const connectDisabled =
    busy || (state?.status === "connecting" && !waitingOnOauth);

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-3",
        blocked
          ? "border-yellow-500/50 bg-yellow-500/5"
          : "border-blue-500/40 bg-blue-500/5",
      )}
    >
      <Link2
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          blocked
            ? "text-yellow-700 dark:text-yellow-500"
            : "text-blue-700 dark:text-blue-400",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-foreground">
          {managedConnectionLabel(connection)}
        </p>
        {connection.description ? (
          <p className="text-muted-foreground text-[11px] leading-snug">
            {connection.description}
          </p>
        ) : null}
        <p
          className={cn(
            "text-[11px] leading-snug",
            connected
              ? "text-emerald-700 dark:text-emerald-400"
              : blocked
                ? "text-yellow-800 dark:text-yellow-300"
                : "text-blue-800 dark:text-blue-300",
          )}
        >
          {managedConnectionStatusText(connection, state, connecting)}
        </p>
        {waitingOnOauth ? (
          <p className="text-[11px] leading-snug text-muted-foreground">
            This link should open automatically.{" "}
            <button
              type="button"
              className="text-blue-800 underline underline-offset-2 dark:text-blue-300"
              onClick={() =>
                state?.actionUrl ? onConnect() : onConnect({ restart: true })
              }
            >
              Click here if it doesn&apos;t.
            </button>
          </p>
        ) : null}
      </div>
      {connected ? (
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/8 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            Connected
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={onClear}
          >
            {clearing ? "Disconnecting" : "Disconnect"}
          </Button>
        </div>
      ) : waitingOnOauth ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onConnect({ restart: true })}
          className="shrink-0"
        >
          {connecting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Initializing connection
            </>
          ) : (
            "Restart"
          )}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={blocked ? "default" : "outline"}
          disabled={connectDisabled}
          onClick={() => onConnect()}
          className="shrink-0"
        >
          {connecting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Initializing connection
            </>
          ) : (
            "Connect"
          )}
        </Button>
      )}
    </div>
  );
}

function secretStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function managedConnectionLabel(
  connection: WorkflowManagedConnectionManifest,
): string {
  return connection.title ?? capitalize(connection.providerId);
}

function managedConnectionStatusText(
  connection: WorkflowManagedConnectionManifest,
  state: ManagedConnectionDisplayState | undefined,
  connecting: boolean,
): string {
  if (connecting) return "Initializing connection for this worker.";
  switch (state?.status) {
    case "connected":
      return "Authorization complete for this worker.";
    case "connecting":
      if (state.waitingOn === `${connection.id}:oauth-callback`) {
        return "Authorization is waiting in the browser.";
      }
      return "Authorization is in progress for this worker.";
    case "error":
      return "Authorization failed. Try reconnecting.";
    default:
      return "Required before this worker can accept workflow inputs.";
  }
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function InputOption({
  input,
  expanded,
  onSelect,
  value,
  onChange,
  canSubmit,
  starting,
  onSubmit,
}: {
  input: WorkflowInputManifest;
  expanded: boolean;
  onSelect: () => void;
  value: unknown;
  onChange: (value: unknown) => void;
  canSubmit: boolean;
  starting?: boolean;
  onSubmit: () => void;
}) {
  const label = workflowInputLabel(input);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card transition-colors",
        expanded && "border-primary/40 bg-white shadow-sm",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={expanded}
        disabled={starting}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Play
          className={cn(
            "size-3.5 shrink-0",
            expanded ? "text-primary" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <span className="block truncate text-sm font-medium text-foreground">
            {label}
          </span>
          {input.description ? (
            <p className="text-muted-foreground text-[11px] leading-snug">
              {input.description}
            </p>
          ) : null}
        </div>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <JsonSchemaForm
            schema={input.schema}
            value={value}
            onChange={onChange}
            idPrefix={input.id}
            disabled={starting}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={onSubmit}
              disabled={!canSubmit || starting}
              aria-busy={starting}
            >
              {starting ? (
                <>
                  <Loader2
                    className="size-3.5 shrink-0 animate-spin"
                    aria-hidden
                  />
                  Starting
                </>
              ) : (
                <>
                  <Play className="size-3.5" aria-hidden />
                  Start
                </>
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p className="whitespace-pre-line text-destructive text-xs" role="alert">
      {children}
    </p>
  );
}
