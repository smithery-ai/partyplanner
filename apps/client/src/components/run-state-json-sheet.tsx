import { useState } from "react"
import type { RunState } from "@rxwf/core"
import { Check, Copy, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function RunStateJsonSheet({
  open,
  onOpenChange,
  runState,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  runState: RunState | undefined
}) {
  const [copied, setCopied] = useState(false)

  if (!open) return null

  const jsonText = runState ? JSON.stringify(runState, null, 2) : ""

  async function copy() {
    if (!jsonText) return
    try {
      await navigator.clipboard.writeText(jsonText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

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
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card shadow-xl",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm">Run state (JSON)</h2>
            {runState ? (
              <p className="truncate text-muted-foreground text-[11px]" title={runState.runId}>
                Run <code className="rounded bg-muted px-1 py-0.5">{runState.runId}</code>
              </p>
            ) : (
              <p className="text-muted-foreground text-[11px]">No active run</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!jsonText}
              onClick={() => void copy()}
              aria-label="Copy JSON"
            >
              {copied ? (
                <Check className="size-4" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
              <span className="ml-1.5 hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {jsonText ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
              {jsonText}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm leading-relaxed">
              Submit a seed input to create a run. Node records (status, values, deps, waits, etc.)
              appear under <code className="rounded bg-muted px-1 py-0.5">nodes</code> once steps
              execute.
            </p>
          )}
        </div>
      </aside>
    </>
  )
}
