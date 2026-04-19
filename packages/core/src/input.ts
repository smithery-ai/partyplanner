import { type ZodSchema, z } from "zod";
import { type DeferredInput, type Input, makeHandle } from "./handles";
import { globalRegistry } from "./registry";

type InputOpts = { description?: string };

export function input<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: InputOpts,
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
  opts?: InputOpts,
): DeferredInput<T> {
  globalRegistry.registerInput({
    kind: "deferred_input",
    id: name,
    schema: schema as ZodSchema<unknown>,
    description: opts?.description,
  });
  return makeHandle<T>("deferred_input", name) as DeferredInput<T>;
};

export function secret(name: string, opts?: InputOpts): Input<string> {
  globalRegistry.registerInput({
    kind: "input",
    id: name,
    schema: z.string(),
    description: opts?.description,
    secret: true,
  });
  return makeHandle<string>("input", name) as Input<string>;
}
