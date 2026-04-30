// `managedAgent({ provider, sandbox, resources, ... })` — the composer.
// Knits a (Provider, Sandbox, Resources) triple into the (Action, Atom)
// pair every workflow consumes.
//
// Two responsibilities:
//
//   1. Wire the dispatch — provision the sandbox (or skip when bundled),
//      mount each resource through the right channel (env vars to
//      Provider.configureEnv, filesystem mounts to Sandbox.mount),
//      build the prompt, and fire `Provider.sendPrompt`.
//
//   2. Close the pull-only-action footgun — return a paired report atom
//      whose body kicks the dispatch action via `get(...)` so hylo
//      actually fires it. Without this, an action with no downstream
//      reader silently never executes.

import {
  type Action,
  type Atom,
  action,
  atom,
  type DeferredInput,
  type Get,
  type Handle,
  isHandle,
} from "@workflow/core";
import { defaultAppBaseUrl } from "@workflow/integrations-oauth";
import type {
  AgentProvider,
  Resource,
  Sandbox,
  SandboxHandle,
} from "./primitives";

// ---------------------------------------------------------------------

/**
 * Outcome of the dispatch action. Persisted in hylo run state under the
 * action's name so downstream atoms can read it for tracing (sessionId
 * is the hook into the provider's logs).
 */
export interface DispatchResult {
  providerId: string;
  sandboxId?: string;
  sessionId: string;
  dispatchedAt: string;
  status: "dispatched" | "completed" | "failed";
  /** Present only when the provider returns the envelope inline. */
  envelope?: unknown;
  /** Present only when status === "failed". */
  error?: string;
}

/**
 * Shape every webhook envelope must satisfy. The provider's webhook
 * resolves a deferred input that includes at minimum a `status`
 * discriminator and an optional `error`; everything else is workflow-
 * specific payload.
 */
export interface ManagedAgentResultEnvelope {
  status: "completed" | "failed";
  error?: string | null;
}

export interface PromptContext {
  /** The hylo run id that dispatched this turn — useful for tracing. */
  runId: string;
  /**
   * The webhook URL the agent inside the sandbox should curl with its
   * result envelope. Wires the agent back to the deferred input.
   */
  webhookUrl: string;
}

export interface ManagedAgentOptions<T extends ManagedAgentResultEnvelope> {
  /** Identifier shared by both the dispatch action and the report atom. */
  name: string;

  /** The brain. */
  provider: AgentProvider<T>;

  /**
   * The hands. Required iff `provider.bundledSandbox` is undefined.
   * When the provider IS bundled (cloud-claude with a workspace), the
   * composer rejects an explicit sandbox arg to avoid ambiguity.
   */
  sandbox?: Sandbox;
  sandboxSpec?: Record<string, unknown>;

  /**
   * Declarative inputs/outputs made available to the agent.
   *  - `secret` / `env` → forwarded to `Provider.configureEnv`
   *  - `git` / `file`   → forwarded to `Sandbox.mount`
   * Filesystem-mounting resources require a sandbox; the composer
   * throws at dispatch time if a `git` or `file` resource is passed
   * without one (or against a bundled provider that doesn't support it).
   */
  resources?: Resource[];

  /**
   * Build the prompt. `ctx` carries `runId` and `webhookUrl` — the
   * agent prompt should embed the webhook URL with instructions to
   * curl back the result envelope.
   */
  prompt: (get: Get, ctx: PromptContext) => string | Promise<string>;

  /**
   * The deferred input the agent's webhook resolves. Schema is
   * workflow-specific but must extend `ManagedAgentResultEnvelope`.
   */
  result: DeferredInput<T>;

  /**
   * Override the dispatch handoff window. Default 500 ms — under hylo's
   * queue lease serialization tolerance.
   */
  handoffMs?: number;

  /** Human-readable description for the run-state UI. */
  description?: string;
}

export interface ManagedAgent<T extends ManagedAgentResultEnvelope> {
  /** The action that fires the agent dispatch. */
  dispatch: Action<DispatchResult>;
  /**
   * The atom downstream code consumes — kicks the dispatch action and
   * resolves to the agent's result envelope (skips on failure).
   */
  report: Atom<T>;
}

// ---------------------------------------------------------------------

export function managedAgent<T extends ManagedAgentResultEnvelope>(
  opts: ManagedAgentOptions<T>,
): ManagedAgent<T> {
  validate(opts);

  const dispatch = action(
    async (get, _requestIntervention, ctx) => {
      const appBase = get(defaultAppBaseUrl).replace(/\/+$/, "");
      const webhookUrl = `${appBase}/api/workflow/webhooks`;

      const session = await opts.provider.prepareSession({
        runId: ctx.runId,
        webhookUrl,
      });

      let sandboxHandle: SandboxHandle | undefined;
      if (opts.sandbox && !opts.provider.bundledSandbox) {
        sandboxHandle = await opts.sandbox.provision(opts.sandboxSpec ?? {});
      }

      const resources = opts.resources ?? [];

      // Partition resources: env-shaped go to Provider.configureEnv,
      // filesystem-shaped go to Sandbox.mount. Optional secrets that
      // resolve to undefined are dropped silently.
      const envVars: Record<string, string> = {};
      for (const r of resources) {
        if (r.kind === "env") {
          envVars[r.name] = r.value;
        } else if (r.kind === "secret") {
          const value = isHandle(r.source)
            ? safeGet(get, r.source, r.optional ?? false)
            : undefined;
          if (typeof value === "string" && value.length > 0) {
            envVars[r.env] = value;
          } else if (!r.optional) {
            throw new Error(
              `managed-agent: secret resource "${r.env}" is required but the source resolved to empty/undefined`,
            );
          }
        } else {
          // git, file — must be mounted by a sandbox.
          if (!sandboxHandle) {
            throw new Error(
              `managed-agent: resource of kind "${r.kind}" requires a non-bundled Sandbox; provider "${opts.provider.id}" is bundled and a separate sandbox arg was not provided.`,
            );
          }
          await opts.sandbox?.mount(sandboxHandle, r);
        }
      }

      if (Object.keys(envVars).length > 0) {
        await opts.provider.configureEnv(session, envVars);
      }

      const promptText = await opts.prompt(get, {
        runId: ctx.runId,
        webhookUrl,
      });

      const outcome = await opts.provider.sendPrompt(session, promptText, {
        handoffMs: opts.handoffMs ?? DEFAULT_HANDOFF_MS,
      });

      const base: DispatchResult = {
        providerId: opts.provider.id,
        sandboxId: sandboxHandle?.sandboxId ?? opts.provider.bundledSandbox,
        sessionId: session.sessionId,
        dispatchedAt: outcome.dispatchedAt,
        status: outcome.kind,
      };
      if (outcome.kind === "completed") {
        return { ...base, envelope: outcome.envelope };
      }
      if (outcome.kind === "failed") {
        return { ...base, error: outcome.error };
      }
      return base;
    },
    {
      name: opts.name,
      description:
        opts.description ??
        `Managed-agent dispatch for provider "${opts.provider.id}"`,
    },
  );

  const report = atom<T>(
    (get) => {
      // Pull on the dispatch so hylo actually fires it. Hylo actions are
      // pull-only; an action with no downstream reader silently never
      // executes. This is the canonical fix for that footgun.
      const dispatched = get(dispatch);

      // Synchronous providers may have already produced the envelope
      // inline, in which case we short-circuit the deferred input.
      if (dispatched.status === "completed" && dispatched.envelope) {
        return dispatched.envelope as T;
      }
      if (dispatched.status === "failed") {
        return get.skip(dispatched.error ?? "managed-agent dispatch failed");
      }

      const envelope = get(opts.result);
      if (envelope.status === "failed") {
        return get.skip(envelope.error ?? "managed-agent investigation failed");
      }
      return envelope;
    },
    {
      name: `${opts.name}Report`,
      description: `Managed-agent result envelope for "${opts.name}".`,
    },
  );

  return { dispatch, report };
}

// ---------------------------------------------------------------------

const DEFAULT_HANDOFF_MS = 500;

function validate<T extends ManagedAgentResultEnvelope>(
  opts: ManagedAgentOptions<T>,
): void {
  if (opts.provider.bundledSandbox && opts.sandbox) {
    throw new Error(
      `managed-agent: provider "${opts.provider.id}" bundles its own sandbox ("${opts.provider.bundledSandbox}"); do not pass a separate \`sandbox:\` arg.`,
    );
  }
  if (!opts.provider.bundledSandbox && !opts.sandbox) {
    const fsKinds = (opts.resources ?? []).filter(
      (r) => r.kind === "git" || r.kind === "file",
    );
    if (fsKinds.length > 0) {
      throw new Error(
        `managed-agent: provider "${opts.provider.id}" is unbundled and resources include filesystem-shaped kinds (${fsKinds.map((r) => r.kind).join(", ")}); a \`sandbox:\` arg is required.`,
      );
    }
  }
}

function safeGet<T>(
  get: Get,
  source: Handle<T>,
  optional: boolean,
): T | undefined {
  if (
    optional &&
    typeof (get as unknown as { maybe?: unknown }).maybe === "function"
  ) {
    return (get as unknown as { maybe: (h: Handle<T>) => T | undefined }).maybe(
      source,
    );
  }
  return get(source);
}
