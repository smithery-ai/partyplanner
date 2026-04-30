// `route(...)` — declare an HTTP route that the worker shim auto-mounts
// alongside atoms / actions / inputs / schedules.
//
// Same registration model as the rest of hylo's primitives: calling
// `route(...)` registers a `RouteDef` on `globalRegistry`. The worker
// shim iterates `globalRegistry.allRoutes()` at boot and mounts each
// on its Hono app, with a `RouteContext` giving the handler typed
// helpers for the things route handlers need: resolving secrets,
// starting workflow runs, and reading the worker's env.
//
// This closes the "user has to know about routes / hono / shim
// editing" gap for plugins like `@smithery/hylo-linear` that need
// HTTP intake. The plugin owns the registration (calls `route(...)`
// inside its `linearWebhook(...)` factory); the workflow author just
// declares the trigger like any other primitive.
//
// Example:
//
//   export const linearTrigger = linearWebhook({
//     path: "/webhooks/linear",
//     signingSecret: linearWebhookSecret,
//     filter: ({ data, action }) => action !== "remove" && data.assigneeId === BOT_USER_ID,
//     onIssue: ({ data }, ctx) =>
//       ctx.startRun(linearTicket, { ticketId: data.identifier, ... }),
//   });

import type { Input } from "./handles";
import { globalRegistry } from "./registry";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "OPTIONS";

/**
 * Helpers passed to a route handler at request time. Lets the handler
 * resolve hylo `secret(...)` refs, start workflow runs without going
 * through `fetch`, and read the worker env directly.
 */
export interface RouteContext {
  /**
   * Resolve a `secret(...)` ref against the worker's bound env. Returns
   * the resolved string, or `undefined` if unbound. Caller decides
   * whether unbound is fatal.
   */
  getSecret(ref: Input<string>): string | undefined;

  /**
   * Fire a workflow run for `input` with `payload`. Returns the new
   * run id. Equivalent to POST /api/workflow/runs but in-process — no
   * self-fetch.
   */
  startRun<T>(input: Input<T>, payload: T): Promise<{ runId: string }>;

  /**
   * The worker's runtime env (CF Workers `env` binding or equivalent).
   * Use sparingly — prefer `getSecret` for secrets so the value is
   * type-tracked through hylo's secret model.
   */
  env: Record<string, unknown>;
}

export type RouteHandler = (
  request: Request,
  ctx: RouteContext,
) => Response | Promise<Response>;

export interface RouteOpts {
  /** URL path the handler responds at (e.g. `/webhooks/linear`). */
  path: string;
  /** HTTP method the handler accepts. Defaults to `POST`. */
  method?: HttpMethod;
  /** Human-readable description; surfaced in tooling. */
  description?: string;
  /**
   * Stable id used in registry collision detection. Defaults to a
   * deterministic id derived from method+path. Override only when
   * mounting multiple routes that share method+path via different
   * adapters (rare).
   */
  id?: string;
}

/**
 * Register an HTTP route. Side-effect call — pushes a `RouteDef` onto
 * `globalRegistry` so the worker shim picks it up at boot.
 *
 * Most consumers won't call `route(...)` directly — plugins wrap it
 * (e.g. `linearWebhook(...)`, `stripeWebhook(...)`) so workflow code
 * stays declarative.
 */
export function route(opts: RouteOpts, handler: RouteHandler): void {
  const method: HttpMethod = opts.method ?? "POST";
  const id = opts.id ?? defaultRouteId(method, opts.path);
  globalRegistry.registerRoute({
    id,
    path: opts.path,
    method,
    handler,
    description: opts.description,
  });
}

function defaultRouteId(method: HttpMethod, path: string): string {
  return `__route_${method}_${path}`;
}
