import type { Registry } from "@workflow/core";
import { X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ZodSchemaForm } from "../components/zod-schema-form";
import { cn } from "../lib/utils";
import type { SecretVaultEntry } from "../types";

/** Only the deferred input the run is currently waiting on (SPEC: WaitError → queue event). */
export function PendingInputSheet({
  open,
  onOpenChange,
  registry,
  pendingInputId,
  inputValues,
  onInputValuesChange,
  vaultEntries = [],
  secretBindings,
  onSecretBindingChange,
  newSecretValues,
  onNewSecretValueChange,
  onSubmit,
  onBindSecret,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry: Registry;
  pendingInputId: string | undefined;
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  vaultEntries?: SecretVaultEntry[];
  secretBindings: Record<string, string>;
  onSecretBindingChange: (logicalName: string, vaultEntryId: string) => void;
  newSecretValues: Record<string, string>;
  onNewSecretValueChange: (logicalName: string, value: string) => void;
  onSubmit: () => void;
  onBindSecret: () => void;
  error?: string;
}) {
  if (!open || !pendingInputId) return null;

  const def = registry.getInput(pendingInputId);
  if (!def || (def.kind !== "deferred_input" && !def.secret)) return null;
  const isSecret = Boolean(def.secret);
  const selectedVaultEntryId = secretBindings[pendingInputId] ?? "";

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[45] bg-background/80 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card shadow-xl",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold text-sm">Pending input</h2>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {isSecret ? null : (
            <p className="text-muted-foreground text-[11px] leading-snug">
              A step is blocked until this deferred input is delivered as a
              queue event (validated with its Zod schema). The producer can be
              this UI, a webhook, or any system that calls{" "}
              <code className="rounded bg-muted px-1 py-0.5">process</code> with{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                kind: &quot;input&quot;
              </code>
              .
            </p>
          )}
          <div className="space-y-2 rounded-lg border border-yellow-500/40 bg-yellow-500/8 p-3">
            <div className="space-y-1">
              <code className="block text-[11px] text-foreground">
                {pendingInputId}
              </code>
              {def.description ? (
                <p className="text-muted-foreground text-[11px] leading-snug">
                  {def.description}
                </p>
              ) : null}
            </div>
            {isSecret ? (
              <>
                <select
                  className="flex h-8 w-full rounded-lg border border-input bg-background px-2 text-xs"
                  value={selectedVaultEntryId}
                  onChange={(e) =>
                    onSecretBindingChange(pendingInputId, e.target.value)
                  }
                >
                  <option value="">Choose vault secret</option>
                  {vaultEntries.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.key ? ` (${entry.key})` : ""}
                    </option>
                  ))}
                </select>
                {!selectedVaultEntryId ? (
                  <Input
                    type="password"
                    value={newSecretValues[pendingInputId] ?? ""}
                    onChange={(e) =>
                      onNewSecretValueChange(pendingInputId, e.target.value)
                    }
                    placeholder="New vault value"
                  />
                ) : null}
                <Button type="button" size="sm" onClick={() => onBindSecret()}>
                  Bind “{pendingInputId}”
                </Button>
              </>
            ) : (
              <>
                <ZodSchemaForm
                  schema={def.schema}
                  value={inputValues[pendingInputId]}
                  onChange={(v) => onInputValuesChange(pendingInputId, v)}
                  idPrefix={pendingInputId}
                  secret={def.secret}
                />
                <Button type="button" size="sm" onClick={() => onSubmit()}>
                  Submit “{pendingInputId}”
                </Button>
              </>
            )}
          </div>
          {error ? (
            <p
              className="whitespace-pre-line text-destructive text-xs"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      </aside>
    </>
  );
}
