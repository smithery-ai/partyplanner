import type { InterventionRequest, NodeRecord } from "@workflow/core";
import { X } from "lucide-react";
import { JsonSchemaForm } from "../components/json-schema-form";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { JsonSchema } from "../types";

export type NodeDetailEditor = {
  /** From `input(..., { description })` in the workflow registry. */
  inputDescription?: string;
  description: string;
  schema: JsonSchema;
  secret?: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  onSubmit: () => void | Promise<void>;
  submitLabel: string;
  error?: string;
};

export type NodeIntervention = {
  request: InterventionRequest;
  response?: unknown;
};

export function NodeDetailSheet({
  nodeId,
  record,
  editor,
  interventions,
  open,
  onOpenChange,
}: {
  nodeId: string | null;
  record: NodeRecord | undefined;
  editor?: NodeDetailEditor | null;
  interventions?: NodeIntervention[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open || !nodeId) return null;

  const showEmpty = !record && !editor && !interventions?.length;

  return (
    <>
      <button
        type="button"
        aria-label="Close node details"
        className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-[70] flex w-full max-w-lg flex-col border-l border-border bg-card shadow-xl",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold text-sm">{nodeId}</h2>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {editor && (
            <div className="mb-6 space-y-3">
              {editor.inputDescription ? (
                <p className="text-muted-foreground text-[11px] leading-snug">
                  {editor.inputDescription}
                </p>
              ) : null}
              <p className="text-muted-foreground text-xs leading-snug">
                {editor.description}
              </p>
              <JsonSchemaForm
                schema={editor.schema}
                value={editor.value}
                onChange={editor.onChange}
                idPrefix={nodeId}
                secret={editor.secret}
              />
              {editor.error ? (
                <p
                  className="whitespace-pre-line text-destructive text-xs"
                  role="alert"
                >
                  {editor.error}
                </p>
              ) : null}
              <Button
                type="button"
                size="sm"
                onClick={() => void editor.onSubmit()}
              >
                {editor.submitLabel}
              </Button>
            </div>
          )}
          {record ? (
            <div className="space-y-4 text-xs">
              <div>
                <div className="mb-1 font-medium text-foreground">Status</div>
                <code className="rounded bg-muted px-1.5 py-0.5">
                  {record.status}
                </code>
              </div>
              {record.value !== undefined && (
                <div>
                  <div className="mb-1 font-medium text-foreground">Value</div>
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                    {typeof record.value === "string"
                      ? record.value
                      : JSON.stringify(record.value, null, 2)}
                  </pre>
                </div>
              )}
              {record.error && (
                <div>
                  <div className="mb-1 font-medium text-destructive">Error</div>
                  <p className="text-destructive">{record.error.message}</p>
                  {record.error.stack && (
                    <pre className="mt-2 max-h-[40vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
                      {record.error.stack}
                    </pre>
                  )}
                </div>
              )}
              {record.waitingOn && (
                <p className="text-muted-foreground">
                  Waiting on{" "}
                  <code className="text-foreground">{record.waitingOn}</code>
                </p>
              )}
              {record.status === "skipped" && record.skipReason && (
                <div>
                  <div className="mb-1 font-medium text-foreground">
                    Skip Reason
                  </div>
                  <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground whitespace-pre-wrap">
                    {record.skipReason}
                  </p>
                </div>
              )}
              {record.blockedOn && (
                <p className="text-muted-foreground">
                  Blocked on{" "}
                  <code className="text-foreground">{record.blockedOn}</code>
                </p>
              )}
              <div>
                <div className="mb-1 font-medium text-foreground">Deps</div>
                <pre className="rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px]">
                  {record.deps.length ? record.deps.join(", ") : "—"}
                </pre>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                <span>
                  duration:{" "}
                  <span className="text-foreground">
                    {record.duration_ms}ms
                  </span>
                </span>
                <span>
                  attempts:{" "}
                  <span className="text-foreground">{record.attempts}</span>
                </span>
              </div>
            </div>
          ) : null}
          {interventions && interventions.length > 0 ? (
            <div className="mt-6 space-y-3">
              <div className="font-medium text-foreground text-xs">
                Human interventions
              </div>
              {interventions.map(({ request, response }) => (
                <div
                  key={request.id}
                  className="space-y-2 rounded-md border border-yellow-500/40 bg-yellow-400/10 p-3 text-[11px] dark:border-yellow-500/40 dark:bg-yellow-500/10"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <code className="text-[11px] text-foreground">
                      {request.key}
                    </code>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-medium text-[10px]",
                        request.status === "resolved"
                          ? "bg-emerald-600/15 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-100"
                          : "bg-yellow-400/25 text-yellow-950 dark:bg-yellow-500/20 dark:text-yellow-50",
                      )}
                    >
                      {request.status}
                    </span>
                  </div>
                  {request.title ? (
                    <div className="text-foreground">{request.title}</div>
                  ) : null}
                  {request.description ? (
                    <p className="text-muted-foreground leading-snug">
                      {request.description}
                    </p>
                  ) : null}
                  {request.status === "resolved" && response !== undefined ? (
                    <div>
                      <div className="mb-1 font-medium text-foreground">
                        Response
                      </div>
                      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                        {typeof response === "string"
                          ? response
                          : JSON.stringify(response, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {showEmpty ? (
            <p className="text-muted-foreground text-sm">
              No record for this node.
            </p>
          ) : null}
        </div>
      </aside>
    </>
  );
}
