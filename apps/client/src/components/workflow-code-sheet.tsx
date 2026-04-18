import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export function WorkflowCodeSheet({
  open,
  onOpenChange,
  workflowCode,
  onWorkflowCodeChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workflowCode: string
  onWorkflowCodeChange: (v: string) => void
}) {
  if (!open) return null

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
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-muted-foreground text-[11px] leading-snug">
            Reference only until hot reload: the live runtime uses the compiled{" "}
            <code className="rounded bg-muted px-1 py-0.5">workflow.ts</code> module.
          </p>
          <Textarea
            spellCheck={false}
            value={workflowCode}
            onChange={(e) => onWorkflowCodeChange(e.target.value)}
            className="min-h-[min(50vh,420px)] resize-y font-mono text-xs leading-relaxed"
          />
        </div>
      </aside>
    </>
  )
}
