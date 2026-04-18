import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { NodeRecord } from "@rxwf/core"
import { cn } from "@/lib/utils"

export function NodeDetailSheet({
  nodeId,
  record,
  open,
  onOpenChange,
}: {
  nodeId: string | null
  record: NodeRecord | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!open || !nodeId) return null

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
          {record ? (
            <div className="space-y-4 text-xs">
              <div>
                <div className="mb-1 font-medium text-foreground">Status</div>
                <code className="rounded bg-muted px-1.5 py-0.5">{record.status}</code>
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
                  Waiting on <code className="text-foreground">{record.waitingOn}</code>
                </p>
              )}
              {record.blockedOn && (
                <p className="text-muted-foreground">
                  Blocked on <code className="text-foreground">{record.blockedOn}</code>
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
                  duration: <span className="text-foreground">{record.duration_ms}ms</span>
                </span>
                <span>
                  attempts: <span className="text-foreground">{record.attempts}</span>
                </span>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No record for this node.</p>
          )}
        </div>
      </aside>
    </>
  )
}
