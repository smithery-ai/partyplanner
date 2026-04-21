import { DurableObject } from "cloudflare:workers";
import {
  createWorkflowCloudflareDb,
  migrateWorkflowCloudflareSchema,
  type WorkflowCloudflareDb,
} from "@workflow/cloudflare";
import { type AppType, createApp } from "./app";
import type { Env } from "./index";

export class BackendDurableObject extends DurableObject<Env> {
  private readonly db: WorkflowCloudflareDb;
  private readonly app: AppType;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.db = createWorkflowCloudflareDb(state.storage);
    state.blockConcurrencyWhile(async () => {
      await migrateWorkflowCloudflareSchema(this.db);
    });
    this.app = createApp(this.db, env);
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.app.fetch(request);
  }
}
