import { atom, input, schedule } from "@workflow/core";
import { z } from "zod";

// A no-op workflow used to verify that the scheduling abstraction fires runs
// on the expected wall-clock cadence. Enable with HYLO_SCHEDULE_PROBE=1 in the
// Next.js env. The workflow has no side effects: a single atom records the
// trigger payload + a server-side timestamp, which we read from the run state
// to confirm the dispatcher fired at the right minute.

// Two schedules share this trigger, so we declare it explicitly with
// `internal: true` to keep it out of the "Start the workflow" UI — humans
// never fire this directly; the dispatcher does.
const probeTrigger = input(
  "scheduleProbeTrigger",
  z.object({
    label: z.string(),
    cron: z.string(),
  }),
  { internal: true },
);

export const scheduleProbeResult = atom(
  (get) => {
    const trigger = get.maybe(probeTrigger);
    if (!trigger) return get.skip("No probe trigger fired");
    return {
      workflow: "schedule-probe",
      label: trigger.label,
      cron: trigger.cron,
      observedAt: new Date().toISOString(),
    };
  },
  {
    name: "scheduleProbeResult",
    description: "Records the wall-clock time at which a probe schedule fired.",
  },
);

if (typeof process !== "undefined" && process.env.HYLO_SCHEDULE_PROBE === "1") {
  // Two schedules sharing one explicit trigger.
  schedule("scheduleProbeEveryMinute", "* * * * *", {
    trigger: probeTrigger,
    payload: { label: "every-minute", cron: "* * * * *" },
    description: "Probe: fire every minute.",
  });

  schedule("scheduleProbeEvenMinutes", "*/2 * * * *", {
    trigger: probeTrigger,
    payload: { label: "every-2-minutes", cron: "*/2 * * * *" },
    description: "Probe: fire every two minutes (even minutes only).",
  });

  // Schema form: schedule creates its own hidden internal input. No separate
  // input() declaration needed; nothing surfaces in the UI.
  schedule("scheduleProbeOddMinutes", "1-59/2 * * * *", {
    schema: z.object({ label: z.string(), cron: z.string() }),
    payload: { label: "every-2-minutes-odd", cron: "1-59/2 * * * *" },
    description: "Probe (schema form): fire on odd minutes only.",
  });
}
