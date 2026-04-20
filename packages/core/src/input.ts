import { type ZodSchema, z } from "zod";
import { type DeferredInput, type Input, makeHandle } from "./handles";
import { globalRegistry } from "./registry";

type InputOpts = { title?: string; description?: string };
type SecretOpts = InputOpts & { errorMessage?: string };

export function input<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: InputOpts,
): Input<T> {
  globalRegistry.registerInput({
    kind: "input",
    id: name,
    title: opts?.title,
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
    title: opts?.title,
    schema: schema as ZodSchema<unknown>,
    description: opts?.description,
  });
  return makeHandle<T>("deferred_input", name) as DeferredInput<T>;
};

export function secret(
  name: string,
  value: string | undefined,
  opts?: SecretOpts,
): Input<string> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error(
      `secret() names must be UPPER_SNAKE_CASE. Got: ${JSON.stringify(name)}`,
    );
  }
  const resolved =
    typeof value === "string" && value.length > 0 ? value : undefined;
  globalRegistry.registerInput({
    kind: "input",
    id: name,
    title: opts?.title,
    schema: z.string().min(1, "Secret must not be empty."),
    description: opts?.description,
    secret: true,
    secretValue: resolved,
    errorMessage: opts?.errorMessage,
  });
  return makeHandle<string>("input", name) as Input<string>;
}
