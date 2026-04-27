import type { DeferredInput, Input } from "./handles";
import { globalRegistry } from "./registry";

export type ScheduleOpts<T> = {
  trigger: Input<T> | DeferredInput<T>;
  payload: T;
  description?: string;
};

// schedule() declares that a workflow should be started on a recurring cadence,
// driven by whichever scheduling primitive the executing backend provides.
//
// The cron expression follows POSIX 5-field format (minute hour dom month dow)
// and is evaluated in UTC by the dispatcher. The associated input is submitted
// with `payload` each time the schedule fires.
//
// IDs must be globally unique across the workflow's registry (same namespace as
// inputs/atoms/actions). They are surfaced in the workflow manifest so a
// platform adapter can translate them into the native cron primitive.
export function schedule<T>(
  id: string,
  cron: string,
  opts: ScheduleOpts<T>,
): void {
  globalRegistry.registerSchedule({
    id,
    cron,
    inputId: opts.trigger.__id,
    payload: opts.payload,
    description: opts.description,
  });
}
