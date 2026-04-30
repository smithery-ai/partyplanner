// Managed-agent primitives — the abstract interfaces every adapter
// implements. Adopts the primitive selection from Anthropic's Managed
// Agents framework (https://www.anthropic.com/engineering/managed-agents) —
// Session, Orchestration, Harness, Sandbox, Resources, Tools — narrowed
// to what hylo workflows need to wire LLM execution against arbitrary
// brain (Provider) and hands (Sandbox) configurations.
//
// The interfaces here are protocol-neutral on purpose. Adapters live
// in `./providers/*` and `./sandboxes/*`; the composer in `./compose.ts`
// knits them together into the (Action, Atom) pair workflows consume.
//
// What this package does NOT enforce yet:
//   - a durable per-session event log
//   - claim-first execution / replay-safety
//   - a declared and frozen tool catalog
// Those are substrate-level concerns we expect hylo to grow into. Until
// then, hylo's `runId` doubles as the session id and the workflow's
// deferred input substitutes for the durable event log.

import type { Handle, Input } from "@workflow/core";

// ---------------------------------------------------------------------
// Provider — the brain. Owns the LLM execution plane (the harness loop)
// and, in some implementations (cloud-claude), also bundles a sandbox.
// ---------------------------------------------------------------------

/** Stable id for a provider (`"cloud-claude"`, `"anthropic"`, ...). */
export type ProviderId = string;

/** Stable id for a sandbox (`"daytona"`, `"local-fs"`, ...). */
export type SandboxId = string;

/**
 * Live handle returned by `provider.prepareSession`. Opaque to the
 * composer — adapters are free to carry whatever they need (session id,
 * container handle, tunnel descriptor, etc.).
 *
 * Provider handles are LIVE state, not durable truth — restart-safe
 * code MUST NOT depend on holding a handle across crashes. Anything the
 * composer needs across hylo runs (session id for tracing, sandbox id
 * for cleanup) is also returned in the composer's `DispatchResult` and
 * persisted in hylo's run state.
 */
export interface AgentSessionHandle {
  /** Session id from the provider; used in dispatch result + tracing. */
  readonly sessionId: string;
  /** Provider-specific bag of fields. Composer treats as opaque. */
  readonly providerData?: unknown;
}

/**
 * Context passed to `prepareSession` — pulled from hylo's run env at
 * dispatch time so adapters can wire URLs/ids without the composer
 * threading them through arg-by-arg.
 */
export interface PrepareContext {
  runId: string;
  webhookUrl: string;
}

/**
 * Outcome of `sendPrompt`. Most providers return `dispatched` — they
 * fire-and-forget into a session DO that completes the turn off-line.
 * `completed` and `failed` are reserved for synchronous providers that
 * can return the full envelope inline (e.g. Anthropic API direct).
 */
export type SendPromptOutcome =
  | { kind: "dispatched"; dispatchedAt: string }
  | { kind: "completed"; dispatchedAt: string; envelope: unknown }
  | { kind: "failed"; dispatchedAt: string; error: string };

export interface SendPromptOptions {
  /**
   * How long the dispatch fetch may block before the composer aborts.
   * Provider implementations SHOULD honor this — for fire-and-forget
   * providers, the session continues running after the abort.
   *
   * Default 500 ms aligns with hylo's queue-lease serialization
   * tolerance (longer holds collide on optimistic-locking version).
   */
  handoffMs: number;
}

/**
 * AgentProvider — the "brain" of a managed agent. Knows how to:
 *   1. Prepare a session for a given workflow run
 *   2. Inject env vars / configuration
 *   3. Send a prompt (and either complete inline or hand off)
 *   4. Optionally abort an in-flight turn
 *
 * `bundledSandbox` declares whether the provider co-manages its own
 * sandbox (cloud-claude bundles daytona / r2-path / etc) or expects the
 * composer to provision one separately (anthropic, claude-agent-sdk).
 * The composer reads this marker to decide whether a `sandbox:` arg is
 * required.
 */
export interface AgentProvider<TEnvelope = unknown> {
  readonly id: ProviderId;
  /**
   * When set, the provider's sandbox is co-managed via its own config
   * surface; the composer will not call a separate Sandbox.provision().
   * When undefined, the composer requires a Sandbox arg and threads
   * it into the provider's session prepare path.
   */
  readonly bundledSandbox?: SandboxId;

  prepareSession(ctx: PrepareContext): Promise<AgentSessionHandle>;
  configureEnv(
    handle: AgentSessionHandle,
    vars: Record<string, string>,
  ): Promise<void>;
  sendPrompt(
    handle: AgentSessionHandle,
    prompt: string,
    opts: SendPromptOptions,
  ): Promise<SendPromptOutcome>;
  abort?(handle: AgentSessionHandle): Promise<void>;

  /**
   * Phantom witness for the envelope type the provider's webhook
   * resolves with. Adapters typically expose this as `null as TEnvelope`
   * to keep TypeScript happy without runtime cost.
   */
  readonly _envelope?: TEnvelope;
}

// ---------------------------------------------------------------------
// Sandbox — the hands. The scoped execution environment where the
// agent's tool calls run (filesystem, env vars, optional network policy).
// May be local (a tmp dir) or remote (a Daytona VM, a Docker container).
// ---------------------------------------------------------------------

/**
 * Live handle to a provisioned sandbox. Opaque to the composer; adapters
 * carry whatever they need to mount/stop/cleanup.
 *
 * Same invariant as `AgentSessionHandle`: NOT durable truth. The
 * composer persists only the sandbox id + the provider session id in
 * hylo run state.
 */
export interface SandboxHandle {
  readonly sandboxId: string;
  readonly providerData?: unknown;
}

/**
 * Configuration bag for `Sandbox.provision`. Polymorphic on purpose —
 * each Sandbox adapter has its own concrete spec shape (region, image,
 * resource limits, etc.).
 */
export interface SandboxSpec {
  /** Optional friendly tag for logs; not load-bearing. */
  label?: string;
  /** Adapter-specific config. */
  [key: string]: unknown;
}

export interface MountResult {
  /** Where in the sandbox the resource is reachable (file path or env://NAME). */
  resolvedMount: string;
}

export type CleanupPolicy = "delete" | "retain" | "redact";

export interface Sandbox {
  readonly id: SandboxId;
  provision(spec: SandboxSpec): Promise<SandboxHandle>;
  mount(handle: SandboxHandle, resource: Resource): Promise<MountResult>;
  stop?(handle: SandboxHandle, reason: string): Promise<void>;
  cleanup?(handle: SandboxHandle, policy: CleanupPolicy): Promise<void>;
}

// ---------------------------------------------------------------------
// Resource — declarative inputs made available to the agent by reference.
// Each resource has a source reference and a mount path; the composer
// dispatches each kind to the right channel (env var, filesystem mount,
// or git clone).
// ---------------------------------------------------------------------

/**
 * Reference to a secret value, resolved at dispatch time via hylo's
 * dependency graph. Carrying a Handle here (rather than a literal
 * string) ensures secrets flow through hylo's bindings instead of being
 * captured at construction time.
 */
export type SecretRef = Handle<string> | Input<string>;

/**
 * Discriminated union of resource specs. The composer dispatches each
 * to either `Sandbox.mount()` (for filesystem-mountable kinds) or to
 * `Provider.configureEnv()` (for env-only kinds).
 *
 * `optional: true` on `secret` resources means: if the secret isn't
 * bound at dispatch time, drop the resource silently. Useful for
 * secrets like `LINEAR_API_KEY` that we don't want to require at deploy
 * but want to forward when present.
 */
export type Resource =
  | { kind: "git"; repo: string; ref?: string; mount: string }
  | { kind: "file"; source: string; mount: string }
  | {
      kind: "secret";
      source: SecretRef;
      env: string;
      optional?: boolean;
    }
  | { kind: "env"; name: string; value: string };

// ---------------------------------------------------------------------
// Tool — descriptor only. Tools are capabilities the agent can call by
// name; the descriptor is the contract the agent sees.
// ---------------------------------------------------------------------

/**
 * Tool descriptor as exposed to the agent. Only `name` / `description`
 * / `inputSchema` are agent-visible — transport, credentials, and
 * runtime ids MUST never appear in the descriptor.
 *
 * Most managed-agent providers (cloud-claude, anthropic, claude-agent-sdk)
 * expose tools natively to the model from their own catalogs. This
 * package's `Tool` type is reserved for cases where the workflow wants
 * to declare its own tool topology — currently future work.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
