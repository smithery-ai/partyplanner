import { DurableObject } from "cloudflare:workers";
import { type AppType, createApp } from "./app";
import type { Env } from "./index";

export class BackendDurableObject extends DurableObject<Env> {
  private readonly app: AppType;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    void env;
    this.app = createApp(state.storage);
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.app.fetch(request);
  }
}
