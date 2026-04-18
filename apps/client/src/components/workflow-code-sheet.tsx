import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function WorkflowCodeSheet({
  open,
  onOpenChange,
  workflowCode,
  onWorkflowCodeChange,
  onPreviewInput,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowCode: string;
  onWorkflowCodeChange: (v: string) => void;
  /** Opens the seed input step; user starts the run from there. */
  onPreviewInput: () => void;
  error?: string;
}) {
  if (!open) return null;

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
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold text-sm">Workflow code</h2>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <p className="text-foreground text-xs font-medium leading-snug">
              Scroll to the bottom to continue.
            </p>
            <p className="text-muted-foreground text-[11px] leading-snug">
              Changes are applied before the input form is built.
            </p>
            <Textarea
              spellCheck={false}
              value={workflowCode}
              onChange={(e) => onWorkflowCodeChange(e.target.value)}
              className="min-h-[min(55vh,480px)] resize-y font-mono text-xs leading-relaxed"
            />
          </div>

          <div className="shrink-0 border-t border-border bg-card p-4">
            {error ? (
              <p className="mb-3 text-destructive text-xs">{error}</p>
            ) : null}
            <Button type="button" className="w-full" onClick={onPreviewInput}>
              Continue to inputs
            </Button>
            <p className="mt-2 text-center text-muted-foreground text-[11px] leading-snug">
              You can adjust your starting values there, then press{" "}
              <span className="font-medium text-foreground">
                Start Workflow
              </span>{" "}
              when you're ready.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
