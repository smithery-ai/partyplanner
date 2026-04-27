import { Clock, Loader2, Play } from "lucide-react";
import { useMemo } from "react";
import type { RunSummary, WorkflowScheduleManifest } from "../types";
import { Button } from "./ui/button";

export function SchedulesPanel({
  schedules,
  runs,
  runScheduleNow,
  runningScheduleId,
}: {
  schedules: WorkflowScheduleManifest[];
  runs: RunSummary[];
  runScheduleNow: (scheduleId: string) => void;
  runningScheduleId?: string;
}) {
  const runStats = useMemo(() => buildRunStats(runs), [runs]);

  if (schedules.length === 0) return null;

  return (
    <section className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-border bg-card/95 p-5 shadow-sm">
      <header className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="font-semibold text-sm">Schedules</h2>
        <span className="text-[11px] text-muted-foreground">
          {schedules.length} registered
        </span>
      </header>
      <p className="text-muted-foreground text-xs leading-snug">
        These schedules fire automatically on their cron cadence. Use “Run now”
        to start a run with the registered payload without waiting for the next
        tick — useful for backfills and smoke tests.
      </p>
      <ul className="space-y-2">
        {schedules.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            stats={runStats[schedule.inputId]}
            onRunNow={() => runScheduleNow(schedule.id)}
            running={runningScheduleId === schedule.id}
          />
        ))}
      </ul>
    </section>
  );
}

function ScheduleRow({
  schedule,
  stats,
  onRunNow,
  running,
}: {
  schedule: WorkflowScheduleManifest;
  stats: RunStat | undefined;
  onRunNow: () => void;
  running: boolean;
}) {
  const description = describeCron(schedule.cron);
  const last = stats?.lastFiredAt
    ? new Date(stats.lastFiredAt).toISOString().replace("T", " ").slice(0, 19)
    : "never";

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-3">
      <div className="flex flex-1 flex-col gap-1 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{schedule.id}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {schedule.cron}
          </code>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          {description}
        </p>
        {schedule.description ? (
          <p className="text-[11px] text-foreground/80 leading-snug">
            {schedule.description}
          </p>
        ) : null}
        <div className="flex items-center gap-3 pt-0.5 text-[10px] text-muted-foreground">
          <span>Last run: {last} UTC</span>
          <span>Total runs: {stats?.runCount ?? 0}</span>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRunNow}
        disabled={running}
        className="shrink-0"
      >
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : (
          <Play className="h-3 w-3" aria-hidden="true" />
        )}
        Run now
      </Button>
    </li>
  );
}

type RunStat = { runCount: number; lastFiredAt: number };

function buildRunStats(runs: RunSummary[]): Record<string, RunStat> {
  const stats: Record<string, RunStat> = {};
  for (const run of runs) {
    const inputId = run.triggerInputId;
    if (!inputId) continue;
    const existing = stats[inputId];
    if (!existing) {
      stats[inputId] = { runCount: 1, lastFiredAt: run.startedAt };
    } else {
      existing.runCount += 1;
      if (run.startedAt > existing.lastFiredAt) {
        existing.lastFiredAt = run.startedAt;
      }
    }
  }
  return stats;
}

// Best-effort prose for the most common cron shapes. Keeps the renderer
// readable without pulling in a full cron-to-text library; falls back to the
// raw expression for anything more exotic.
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `Custom: ${expr}`;
  const [m, h, dom, mon, dow] = parts;

  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "Every minute (UTC).";
  }
  if (
    /^\*\/\d+$/.test(m) &&
    h === "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Every ${m.slice(2)} minutes (UTC).`;
  }
  if (
    m === "0" &&
    /^\*\/\d+$/.test(h) &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Every ${h.slice(2)} hours, on the hour (UTC).`;
  }
  if (
    /^\d+$/.test(m) &&
    /^\d+$/.test(h) &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Daily at ${h.padStart(2, "0")}:${m.padStart(2, "0")} UTC.`;
  }
  if (
    /^\d+$/.test(m) &&
    /^\d+$/.test(h) &&
    dom === "*" &&
    mon === "*" &&
    /^[0-7]$/.test(dow)
  ) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return `Weekly on ${days[Number(dow)]} at ${h.padStart(2, "0")}:${m.padStart(2, "0")} UTC.`;
  }
  return `Cron: ${expr} (UTC).`;
}
