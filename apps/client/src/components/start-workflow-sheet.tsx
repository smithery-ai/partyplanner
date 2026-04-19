import type { Registry } from "@rxwf/core";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ZodSchemaForm } from "@/components/zod-schema-form";
import { cn } from "@/lib/utils";

/**
 * Seed / immediate inputs only. Per SPEC, deferred inputs are separate queue events
 * when a step throws WaitError; payloads can be produced by any external publisher.
 */
export function StartWorkflowSheet({
  open,
  onOpenChange,
  registry,
  inputValues,
  onInputValuesChange,
  secretValues,
  onSecretValuesChange,
  seedInputId,
  onSeedInputIdChange,
  canSubmitSeed,
  onSubmitSeed,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry: Registry;
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  secretValues: Record<string, unknown>;
  onSecretValuesChange: (id: string, value: unknown) => void;
  seedInputId: string;
  onSeedInputIdChange: (id: string) => void;
  canSubmitSeed: boolean;
  onSubmitSeed: () => void;
  error?: string;
}) {
  if (!open) return null;

  const immediate = registry.allInputs().filter((i) => i.kind === "input");
  const secrets = registry.allSecrets();

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
          <h2 className="font-semibold text-sm">Start Workflow</h2>
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
          <p className="text-muted-foreground text-[11px] leading-snug">
            Submit an{" "}
            <span className="font-medium text-foreground">immediate</span> input
            to enqueue the first{" "}
            <code className="rounded bg-muted px-1 py-0.5">input</code> event.
            Per the SDK model, the queue is external: deferred inputs are
            separate validated events when a step waits on them—they can be
            supplied from a webhook, job, or DB as long as they are processed
            through{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              runtime.process
            </code>
            .
          </p>

          {immediate.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This workflow has no registered immediate <code>input()</code>—add
              one in code to seed a run.
            </p>
          ) : (
            <>
              {immediate.length > 1 && (
                <div className="space-y-1">
                  <label
                    className="text-[11px] font-medium text-foreground"
                    htmlFor="seed-input-id"
                  >
                    Which input seeds the run?
                  </label>
                  <select
                    id="seed-input-id"
                    className="flex h-8 w-full max-w-xs rounded-lg border border-input bg-background px-2 text-xs"
                    value={seedInputId}
                    onChange={(e) => onSeedInputIdChange(e.target.value)}
                  >
                    {immediate.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.id}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {immediate.map((inp) => {
                if (inp.id !== seedInputId && immediate.length > 1) return null;
                return (
                  <div key={inp.id} className="space-y-2">
                    <div className="space-y-1">
                      <code className="block text-[11px] text-foreground">
                        {inp.id}
                      </code>
                      {inp.description ? (
                        <p className="text-muted-foreground text-[11px] leading-snug">
                          {inp.description}
                        </p>
                      ) : null}
                    </div>
                    <ZodSchemaForm
                      schema={inp.schema}
                      value={inputValues[inp.id]}
                      onChange={(v) => onInputValuesChange(inp.id, v)}
                      idPrefix={inp.id}
                    />
                    {canSubmitSeed && inp.id === seedInputId ? (
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2"
                        onClick={() => onSubmitSeed()}
                      >
                        Start Workflow
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}

          {secrets.length > 0 ? (
            <div className="space-y-3 border-t border-border pt-4">
              <h3 className="font-medium text-xs text-foreground">Secrets</h3>
              {secrets.map((s) => (
                <div key={s.id} className="space-y-1">
                  <label
                    className="block text-[11px] font-medium text-foreground"
                    htmlFor={`secret-${s.id}`}
                  >
                    {s.id}
                  </label>
                  {s.description ? (
                    <p className="text-muted-foreground text-[11px] leading-snug">
                      {s.description}
                    </p>
                  ) : null}
                  <Input
                    id={`secret-${s.id}`}
                    type="password"
                    className="h-8 font-mono text-xs"
                    value={secretInputValue(secretValues[s.id])}
                    onChange={(e) => onSecretValuesChange(s.id, e.target.value)}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
      </aside>
    </>
  );
}

function secretInputValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
