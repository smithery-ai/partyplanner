import type { ZodSchema } from "zod";
import { getActiveRegistry } from "./registry";
import { makeHandle, type Input, type DeferredInput } from "./handles";

export function input<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: { description?: string }
): Input<T> {
  getActiveRegistry().registerInput({
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
  opts?: { description?: string }
): DeferredInput<T> {
  getActiveRegistry().registerInput({
    kind: "deferred_input",
    id: name,
    schema: schema as ZodSchema<unknown>,
    description: opts?.description,
  });
  return makeHandle<T>("deferred_input", name) as DeferredInput<T>;
};
