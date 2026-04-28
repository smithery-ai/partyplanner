import type { ZodSchema } from "zod";
import type { DeferredInput, Input } from "./handles";
import { globalRegistry } from "./registry";

// Two ways to declare a schedule:
//
//   schedule(id, cron, { trigger, payload })
//     Bind to an existing input(). Useful when the same input is also
//     surfaced as a manual run option in the UI, or when several schedules
//     share one trigger with different payloads (e.g. a sweep workflow with
//     a connect + gateway schedule on the same trigger).
//
//   schedule(id, cron, { schema, payload })
//     Self-contained: schedule() creates a hidden internal input under the
//     covers and binds to it. The trigger does not appear in the workflow's
//     "Start the workflow" list — the schedule is the only way to fire it.
//     Use this when the schedule is the only entry point.

export type ScheduleWithTriggerOpts<T> = {
  trigger: Input<T> | DeferredInput<T>;
  payload: T;
  description?: string;
};

export type ScheduleWithSchemaOpts<T> = {
  schema: ZodSchema<T>;
  payload: T;
  title?: string;
  description?: string;
};

export type ScheduleOpts<T> =
  | ScheduleWithTriggerOpts<T>
  | ScheduleWithSchemaOpts<T>;

export function schedule<T>(
  id: string,
  cron: string,
  opts: ScheduleOpts<T>,
): void {
  const inputId =
    "trigger" in opts
      ? opts.trigger.__id
      : registerHiddenScheduleInput(id, opts);

  globalRegistry.registerSchedule({
    id,
    cron,
    inputId,
    payload: opts.payload,
    description: opts.description,
  });
}

// Stable id derivation so re-registers (HMR, multi-tenant clones) are
// deterministic and never collide with user-defined input ids.
function registerHiddenScheduleInput<T>(
  scheduleId: string,
  opts: ScheduleWithSchemaOpts<T>,
): string {
  const inputId = `__schedule_${scheduleId}`;
  globalRegistry.registerInput({
    kind: "input",
    id: inputId,
    schema: opts.schema as ZodSchema<unknown>,
    title: opts.title,
    description: opts.description,
    internal: true,
  });
  return inputId;
}
