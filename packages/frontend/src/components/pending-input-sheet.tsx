import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  KeyRound,
  X,
} from "lucide-react";
import { useState } from "react";
import { JsonSchemaForm } from "../components/json-schema-form";
import { Button, buttonVariants } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { workflowInputLabel } from "../lib/workflow-labels";
import type { JsonSchema, WorkflowInputManifest } from "../types";

export type PendingFormRequest = {
  id: string;
  title?: string;
  description?: string;
  schema: JsonSchema;
  secret?: boolean;
  errorMessage?: string;
  action?: {
    type: "open_url" | "message";
    url?: string;
    label?: string;
  };
  /**
   * First-class URL the user should open to satisfy the intervention (e.g. OAuth
   * consent). When set, the sheet surfaces this link prominently and collapses
   * the manual payload form behind a toggle.
   */
  actionUrl?: string;
};

/** Only the input, secret, or intervention the run is currently waiting on. */
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
  input: WorkflowInputManifest | PendingFormRequest | undefined;
  inputValues: Record<string, unknown>;
  onInputValuesChange: (id: string, value: unknown) => void;
  onSubmit: () => void;
  error?: string;
}) {
  const [manualFormOpen, setManualFormOpen] = useState(false);

  if (!open || !input) return null;

  const isSecret = Boolean(input.secret);
  const formTitle = "title" in input ? input.title : undefined;
  const action = "action" in input ? input.action : undefined;
  const actionUrl =
    "actionUrl" in input && input.actionUrl
      ? input.actionUrl
      : action?.type === "open_url"
        ? action.url
        : undefined;
  const actionLabel = action?.label;
  const label = workflowInputLabel(input);
  const title = formTitle ?? (isSecret ? "Pending secret" : label);
  const rawSecretValue = inputValues[input.id];
  const secretValue =
    isSecret && typeof rawSecretValue === "string" ? rawSecretValue : "";

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
          {isSecret ? (
            <div className="space-y-2 rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-3">
              <div className="flex items-start gap-2.5">
                <KeyRound
                  className="mt-0.5 size-3.5 shrink-0 text-yellow-700 dark:text-yellow-500"
                  aria-hidden
                />
                <div className="min-w-0 space-y-1">
                  <p className="font-medium text-sm text-foreground">{label}</p>
                  {input.description ? (
                    <p className="text-muted-foreground text-[11px] leading-snug">
                      {input.description}
                    </p>
                  ) : null}
                  <p className="text-[11px] leading-snug text-yellow-800 dark:text-yellow-300">
                    {input.errorMessage ??
                      "This step is waiting on a secret. Enter a value to continue this run."}
                  </p>
                </div>
              </div>
              <div className="grid gap-1.5">
                <label
                  className="text-xs font-medium"
                  htmlFor={`pending-secret-${input.id}`}
                >
                  Value
                </label>
                <Input
                  id={`pending-secret-${input.id}`}
                  type="password"
                  value={secretValue}
                  onChange={(e) =>
                    onInputValuesChange(input.id, e.currentTarget.value)
                  }
                  placeholder="Secret value"
                  autoComplete="off"
                />
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => onSubmit()}
                disabled={secretValue.length === 0}
              >
                Add secret
              </Button>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-yellow-500/40 bg-yellow-500/8 p-3">
              <div className="space-y-1">
                <p className="font-medium text-sm text-foreground">{label}</p>
                {input.description ? (
                  <p className="text-muted-foreground text-[11px] leading-snug">
                    {input.description}
                  </p>
                ) : null}
                {actionUrl ? (
                  <a
                    href={actionUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      buttonVariants({ size: "sm", variant: "default" }),
                      "w-full justify-center",
                    )}
                  >
                    <ExternalLink className="size-3.5" />
                    {actionLabel ?? "Open to continue"}
                  </a>
                ) : null}
              </div>
              {actionUrl ? (
                <div className="space-y-2 border-t border-yellow-500/30 pt-2">
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => setManualFormOpen((prev) => !prev)}
                    aria-expanded={manualFormOpen}
                  >
                    {manualFormOpen ? (
                      <ChevronDown className="size-3.5" aria-hidden />
                    ) : (
                      <ChevronRight className="size-3.5" aria-hidden />
                    )}
                    Manually enter callback payload
                  </button>
                  {manualFormOpen ? (
                    <div className="space-y-2">
                      <JsonSchemaForm
                        schema={input.schema}
                        value={inputValues[input.id]}
                        onChange={(value) =>
                          onInputValuesChange(input.id, value)
                        }
                        idPrefix={input.id}
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onSubmit()}
                      >
                        Submit
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <JsonSchemaForm
                    schema={input.schema}
                    value={inputValues[input.id]}
                    onChange={(value) => onInputValuesChange(input.id, value)}
                    idPrefix={input.id}
                  />
                  <Button type="button" size="sm" onClick={() => onSubmit()}>
                    Submit
                  </Button>
                </>
              )}
            </div>
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
