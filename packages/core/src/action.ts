import { type Action, makeHandle } from "./handles";
import { hashString } from "./hash";
import { globalRegistry } from "./registry";
import type { AtomRuntimeContext, Get, RequestIntervention } from "./types";

export type ActionOpts = {
  name?: string;
  description?: string;
  internal?: boolean;
};

// Actions are non-idempotent side effects (POST/PUT/DELETE-shaped work). Unlike
// atoms they are pull-only: the runtime will not fan them out on input events,
// so they only execute when some other step reads them via get(). The resolved
// value is cached in run state, so replayed events do not re-fire the action.
export function action<T>(
  fn: (
    get: Get,
    requestIntervention: RequestIntervention,
    context: AtomRuntimeContext,
  ) => Promise<T> | T,
  opts?: ActionOpts,
): Action<T> {
  const id = opts?.name ?? `action_${hashString(fn.toString())}`;
  globalRegistry.registerAction({
    kind: "action",
    id,
    fn: fn as (
      get: Get,
      requestIntervention: RequestIntervention,
      context: AtomRuntimeContext,
    ) => unknown,
    description: opts?.description,
    internal: opts?.internal,
  });
  return makeHandle<T>("action", id) as Action<T>;
}
