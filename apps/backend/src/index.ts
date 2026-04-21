import type { BackendAppEnv } from "./app";
import { BackendDurableObject } from "./worker";

export { BackendDurableObject };

export default {
  fetch(request, env) {
    const id = env.BACKEND.idFromName("default");
    return env.BACKEND.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export type Env = BackendAppEnv & {
  BACKEND: DurableObjectNamespace<BackendDurableObject>;
};
