import { createWorkflowCloudflareDb } from "@workflow/cloudflare";
import type { BackendAppEnv } from "./app";
import { createApp } from "./app";

export default {
  fetch(request, env) {
    const db = createWorkflowCloudflareDb(env.DB);
    return createApp(db, env, env.DB).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export type Env = BackendAppEnv & {
  DB: D1Database;
};
