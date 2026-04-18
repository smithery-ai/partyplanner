import type { ZodSchema } from "zod";
import { type DeferredInput, type Input, makeHandle } from "./handles";
import { globalRegistry } from "./registry";

export function input<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: { description?: string },
): Input<T> {
  globalRegistry.registerInput({
    kind: "input",
    id: name,
    schema: schema as ZodSchema<unknown>,
    description: opts?.description,
  });
  return makeHandle<T>("input", name) as Input<T>;
}

input.deferred = function deferred<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: { description?: string },
): DeferredInput<T> {
  globalRegistry.registerInput({
    kind: "deferred_input",
    id: name,
    schema: schema as ZodSchema<unknown>,
    description: opts?.description,
  });
  return makeHandle<T>("deferred_input", name) as DeferredInput<T>;
};
