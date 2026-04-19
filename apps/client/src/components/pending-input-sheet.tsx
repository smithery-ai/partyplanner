import type { Registry } from "@rxwf/core";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ZodSchemaForm } from "@/components/zod-schema-form";
import { cn } from "@/lib/utils";

/** Only the deferred input the run is currently waiting on (SPEC: WaitError → queue event). */
export function PendingInputSheet({
  open,
  onOpenChange,
  registry,
  pendingInputId,
  inputValues,
  onInputValuesChange,
  onSubmit,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry: Registry;
  pendingInputId: string | undefined;
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  onSubmit: () => void;
  error?: string;
}) {
  if (!open || !pendingInputId) return null;

  const def = registry.getInput(pendingInputId);
  if (!def || def.kind !== "deferred_input") return null;

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
          <p className="text-muted-foreground text-[11px] leading-snug">
            A step is blocked until this deferred input is delivered as a queue
            event (validated with its Zod schema). The producer can be this UI,
            a webhook, or any system that calls{" "}
            <code className="rounded bg-muted px-1 py-0.5">process</code> with{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              kind: &quot;input&quot;
            </code>
            .
          </p>
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
          </div>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
      </aside>
    </>
  );
}
