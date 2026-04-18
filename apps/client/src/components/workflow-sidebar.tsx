import { useEffect, useState } from "react"
import { ChevronRight, FileCode2, History } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { allWorkflowFilenames } from "@/workflows/loader"
import { fetchRuns } from "@/lib/api"

type RunSummary = {
  runId: string
  filename: string
  startedAt: number
  nodeCount: number
  complete: boolean
}

export function WorkflowSidebar({
  activeFile,
  activeRunId,
  onFileSelect,
  onRunSelect,
}: {
  activeFile: string | null
  activeRunId: string | null
  onFileSelect: (filename: string) => void
  onRunSelect: (filename: string, runId: string) => void
}) {
  const files = allWorkflowFilenames()
  const [runsMap, setRunsMap] = useState<Record<string, RunSummary[]>>({})

  function loadRuns(filename: string) {
    fetchRuns(filename).then((res) => {
      setRunsMap((prev) => ({ ...prev, [filename]: res.runs as RunSummary[] }))
    })
  }

  // Refresh runs for active workflow when activeRunId changes (new run created)
  useEffect(() => {
    if (activeFile) loadRuns(activeFile)
  }, [activeFile, activeRunId])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-1">
          <FileCode2 className="size-4 shrink-0" />
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            Workflows
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Files</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {files.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>
                    <span className="text-muted-foreground">No workflows</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                files.map((filename) => {
                  const runs = runsMap[filename] ?? []
                  return (
                    <Collapsible
                      key={filename}
                      onOpenChange={(open) => {
                        if (open && !runsMap[filename]) loadRuns(filename)
                      }}
                    >
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={filename === activeFile && !activeRunId}
                          tooltip={filename}
                          onClick={() => onFileSelect(filename)}
                        >
                          <FileCode2 className="size-4 shrink-0" />
                          <span className="truncate">{filename.replace(/\.ts$/, "")}</span>
                        </SidebarMenuButton>
                        <CollapsibleTrigger
                          className="absolute right-1 top-1.5 rounded-md p-0.5 text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors group-data-[collapsible=icon]:hidden"
                        >
                          <ChevronRight className="size-3.5 transition-transform duration-200 [[data-state=open]>&]:rotate-90" />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {runs.length === 0 ? (
                              <SidebarMenuSubItem>
                                <span className="px-2 py-1 text-muted-foreground text-xs">
                                  No runs yet
                                </span>
                              </SidebarMenuSubItem>
                            ) : (
                              runs.map((run) => (
                                <SidebarMenuSubItem key={run.runId}>
                                  <SidebarMenuSubButton
                                    isActive={
                                      filename === activeFile &&
                                      run.runId === activeRunId
                                    }
                                    onClick={() => onRunSelect(filename, run.runId)}
                                  >
                                    <History className="size-3 shrink-0" />
                                    <span className="truncate text-xs">
                                      {new Date(run.startedAt).toLocaleString(undefined, {
                                        month: "short",
                                        day: "numeric",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                    <span
                                      className={`ml-auto size-1.5 shrink-0 rounded-full ${
                                        run.complete
                                          ? "bg-emerald-500"
                                          : "bg-yellow-500"
                                      }`}
                                    />
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ))
                            )}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  )
                })
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  )
}
