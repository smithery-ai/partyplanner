import { X } from "lucide-react";
import { JsonSchemaForm } from "../components/json-schema-form";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { WorkflowInputManifest } from "../types";

export function StartWorkflowSheet({
  open,
  onOpenChange,
  inputs,
  inputValues,
  onInputValuesChange,
  canSubmitSeed,
  onSubmitSeed,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inputs: WorkflowInputManifest[];
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  canSubmitSeed: boolean;
  onSubmitSeed: (inputId: string) => void;
  error?: string;
}) {
  if (!open) return null;

  const immediate = inputs.filter((input) => input.kind === "input");
  const dataInputs = immediate.filter((input) => !input.secret);
  const secrets = immediate.filter((input) => input.secret);

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
          {immediate.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This workflow has no immediate inputs.
            </p>
          ) : (
            <>
              {dataInputs.length > 0 ? (
                <div className="space-y-4">
                  {dataInputs.map((input) => (
                    <WorkflowInputBlock
                      key={input.id}
                      input={input}
                      value={inputValues[input.id]}
                      onChange={(value) => onInputValuesChange(input.id, value)}
                      canSubmit={canSubmitSeed}
                      onSubmit={() => onSubmitSeed(input.id)}
                    />
                  ))}
                </div>
              ) : null}

              {secrets.length > 0 ? (
                <div className="space-y-3 border-t border-border pt-4">
                  <h3 className="font-medium text-xs text-foreground">
                    Secrets
                  </h3>
                  {secrets.map((input) => (
                    <WorkflowInputBlock
                      key={input.id}
                      input={input}
                      value={inputValues[input.id]}
                      onChange={(value) => onInputValuesChange(input.id, value)}
                    />
                  ))}
                </div>
              ) : null}

              {dataInputs.length === 0 && canSubmitSeed ? (
                <p className="text-muted-foreground text-sm">
                  Add a non-secret input to start a run from the UI.
                </p>
              ) : null}
            </>
          )}

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

function WorkflowInputBlock({
  input,
  value,
  onChange,
  canSubmit,
  onSubmit,
}: {
  input: WorkflowInputManifest;
  value: unknown;
  onChange: (value: unknown) => void;
  canSubmit?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="space-y-1">
        <code className="block text-[11px] text-foreground">{input.id}</code>
        {input.description ? (
          <p className="text-muted-foreground text-[11px] leading-snug">
            {input.description}
          </p>
        ) : null}
      </div>
      <JsonSchemaForm
        schema={input.schema}
        value={value}
        onChange={onChange}
        idPrefix={input.id}
        secret={input.secret}
      />
      {canSubmit && onSubmit ? (
        <Button type="button" size="sm" onClick={onSubmit}>
          Start with "{input.id}"
        </Button>
      ) : null}
    </div>
  );
}
