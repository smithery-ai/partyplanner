import { type Atom, makeHandle } from "./handles";
import { hashString } from "./hash";
import { globalRegistry } from "./registry";
import type { AtomRuntimeContext, Get, RequestIntervention } from "./types";

export type AtomOpts = {
  name?: string;
  description?: string;
};

export function atom<T>(
  fn: (
    get: Get,
    requestIntervention: RequestIntervention,
    context: AtomRuntimeContext,
  ) => Promise<T> | T,
  opts?: AtomOpts,
): Atom<T> {
  const id = opts?.name ?? `atom_${hashString(fn.toString())}`;
  globalRegistry.registerAtom({
    kind: "atom",
    id,
    fn: fn as (
      get: Get,
      requestIntervention: RequestIntervention,
      context: AtomRuntimeContext,
    ) => unknown,
    description: opts?.description,
  });
  return makeHandle<T>("atom", id) as Atom<T>;
}
