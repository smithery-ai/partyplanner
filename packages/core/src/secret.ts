import { makeHandle, type Secret } from "./handles";
import { globalRegistry } from "./registry";

export type SecretOpts = {
  name?: string;
  description?: string;
};

export type SecretFactory = {
  <T>(defaultValue: T, opts?: SecretOpts): Secret<T>;
  named<T>(
    name: string,
    defaultValue: T,
    opts?: Omit<SecretOpts, "name">,
  ): Secret<T>;
};

function defineSecret<T>(
  defaultValue: T,
  opts: SecretOpts | undefined,
): Secret<T> {
  const id = opts?.name ?? globalRegistry.nextAnonymousId("secret");
  globalRegistry.registerSecret({
    kind: "secret",
    id,
    defaultValue,
    description: opts?.description,
  });
  return makeHandle<T>("secret", id) as Secret<T>;
}

export const secret: SecretFactory = Object.assign(
  <T>(defaultValue: T, opts?: SecretOpts): Secret<T> =>
    defineSecret(defaultValue, opts),
  {
    named: <T>(
      name: string,
      defaultValue: T,
      opts?: Omit<SecretOpts, "name">,
    ): Secret<T> => defineSecret(defaultValue, { ...opts, name }),
  },
);
