export const HANDLE = Symbol.for("@rxwf/handle");

export type HandleKind = "input" | "deferred_input" | "atom";

export interface Handle<T = unknown> {
  readonly [HANDLE]: true;
  readonly __id: string;
  readonly __kind: HandleKind;
  readonly __type?: T; // phantom type, compile-time only
}

export type Input<T> = Handle<T> & { readonly __kind: "input" };
export type DeferredInput<T> = Handle<T> & { readonly __kind: "deferred_input" };
export type Atom<T> = Handle<T> & { readonly __kind: "atom" };

export function makeHandle<T>(kind: HandleKind, id: string): Handle<T> {
  return Object.freeze({ [HANDLE]: true as const, __id: id, __kind: kind });
}

export function isHandle(x: unknown): x is Handle {
  return typeof x === "object" && x !== null && (x as any)[HANDLE] === true;
}
