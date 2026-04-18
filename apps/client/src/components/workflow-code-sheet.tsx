import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Save, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { fetchWorkflowCode, saveWorkflowCode } from "@/lib/api"

function useServerSyncedState(serverValue: string | undefined) {
  const [local, setLocal] = useState("")
  const [lastSynced, setLastSynced] = useState<string | undefined>(undefined)

  if (serverValue != null && serverValue !== lastSynced) {
    setLastSynced(serverValue)
    setLocal(serverValue)
  }

  return [local, setLocal] as const
}

export function WorkflowCodeSheet({
  open,
  onOpenChange,
  filename,
  onPreviewInput,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  filename: string | null
  /** Opens the seed input step; user starts the run from there. */
  onPreviewInput: () => void
}) {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ["workflow-code", filename],
    queryFn: () => fetchWorkflowCode(filename!),
    enabled: !!filename,
  })

  const [localCode, setLocalCode] = useServerSyncedState(data?.code)

  const saveMutation = useMutation({
    mutationFn: () => saveWorkflowCode(filename!, localCode),
    onSuccess: (result) => {
      queryClient.setQueryData(["workflow-code", filename], result)
    },
  })

  const isDirty = data?.code != null && localCode !== data.code

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
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-semibold text-sm truncate">
              {filename ?? "Workflow code"}
            </h2>
            {isDirty && (
              <span className="shrink-0 rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:text-yellow-400">
                unsaved
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {filename && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveMutation.mutate()}
                disabled={!isDirty || saveMutation.isPending}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                <span className="ml-1">Save</span>
              </Button>
            )}
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

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {!filename ? (
              <p className="text-muted-foreground text-sm">
                Select a workflow file from the sidebar.
              </p>
            ) : isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <>
                {saveMutation.isError && (
                  <p className="text-destructive text-xs">
                    {saveMutation.error instanceof Error
                      ? saveMutation.error.message
                      : "Save failed"}
                  </p>
                )}
                <Textarea
                  spellCheck={false}
                  value={localCode}
                  onChange={(e) => setLocalCode(e.target.value)}
                  className="min-h-[min(55vh,480px)] resize-y font-mono text-xs leading-relaxed"
                />
              </>
            )}
          </div>

          <div className="shrink-0 border-t border-border bg-card p-4">
            <Button type="button" className="w-full" onClick={onPreviewInput}>
              Continue to inputs
            </Button>
            <p className="mt-2 text-center text-muted-foreground text-[11px] leading-snug">
              You can adjust your starting values there, then press{" "}
              <span className="font-medium text-foreground">Start Workflow</span> when you're ready.
            </p>
          </div>
        </div>
      </aside>
    </>
  )
}
