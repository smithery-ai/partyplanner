import { X } from "lucide-react";
import { JsonSchemaForm } from "../components/json-schema-form";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { WorkflowInputManifest } from "../types";

/** Only the deferred input or secret the run is currently waiting on. */
export function PendingInputSheet({
  open,
  onOpenChange,
  input,
  inputValues,
  onInputValuesChange,
  onSubmit,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: WorkflowInputManifest | undefined;
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  onSubmit: () => void;
  error?: string;
}) {
  if (!open || !input) return null;

  const title = input.secret ? "Pending secret" : "Pending input";
  const submitLabel = input.secret
    ? `Submit secret "${input.id}"`
    : `Submit "${input.id}"`;

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
          <h2 className="font-semibold text-sm">{title}</h2>
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
          <div className="space-y-2 rounded-lg border border-yellow-500/40 bg-yellow-500/8 p-3">
            <div className="space-y-1">
              <code className="block text-[11px] text-foreground">
                {input.id}
              </code>
              {input.description ? (
                <p className="text-muted-foreground text-[11px] leading-snug">
                  {input.description}
                </p>
              ) : null}
            </div>
            <JsonSchemaForm
              schema={input.schema}
              value={inputValues[input.id]}
              onChange={(value) => onInputValuesChange(input.id, value)}
              idPrefix={input.id}
              secret={input.secret}
            />
            <Button type="button" size="sm" onClick={() => onSubmit()}>
              {submitLabel}
            </Button>
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
