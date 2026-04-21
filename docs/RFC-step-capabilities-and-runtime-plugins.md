# RFC: Step Capabilities and Runtime Plugins

Status: draft  
Branch: `sdd/step-middleware-secrets-proxy`

## Summary

This RFC proposes a simple public API for host-resolved capabilities in
Partyplanner, backed by a pluggable runtime hook system.

The key idea is:

- keep the **workflow authoring API** extremely small and readable
- put advanced pluggability in the **runtime**, not in workflow definitions

### Proposed public API

```ts
const notionWrite = action(
  async ({ get, use, signal }) => {
    const req = get(notionLogRequest);
    const notion = await use.connection("notion");

    return createNotionPage({
      accessToken: notion.accessToken,
      parentPageId: req.parentPageId,
      title: req.title,
      body: req.body,
      signal,
    });
  },
  {
    name: "notionWrite",
    retry: 3,
    timeout: "10s",
  },
);
```

### Proposed runtime architecture

- `use.secret(name)` and `use.connection(name)` are resolved by the workflow
  runtime host, not by workflow code
- retries, timeout, redaction, logging, and metrics are implemented through
  runtime plugins/hooks
- workflow authors do not configure middleware stacks directly

This gives Partyplanner:

- a simple and ergonomic authoring model
- a path to multi-tenant credential resolution
- a pluggable runtime for platform concerns

## Why this RFC exists

The current codebase has the beginnings of a credential model, but not a clean
product abstraction:

- `secret(...)` in `@workflow/core`
- `secretValues` at run submission time
- `SecretResolver` in `@workflow/runtime`
- `secretBindings` types in `@workflow/server`

Relevant files:

- `packages/core/src/input.ts`
- `packages/core/src/runtime.ts`
- `packages/runtime/src/executor.ts`
- `packages/runtime/src/types.ts`
- `packages/server/src/manager.ts`

These pieces are enough for examples and host-owned env secrets. They are not
yet enough for a production multi-tenant app with:

- per-tenant API credentials
- per-user OAuth connections
- refresh token management
- host-side policy enforcement
- step-level retries and timeouts

## Objective

Enable Partyplanner workflows to use host-resolved capabilities cleanly, without
forcing workflow authors to hand-roll:

- secret lookup
- tenant-aware connection lookup
- per-step retry loops
- per-step timeout logic

The public API should be:

1. obvious to read
2. easy to teach
3. compatible with the existing `atom()` / `action()` model
4. powerful enough for multi-tenant SaaS products

## Pain Points in the Current Model

### 1. Secrets are either too static or too ad hoc

Today the normal shape is:

```ts
export const notionClientSecret = secret(
  "NOTION_CLIENT_SECRET",
  process.env.NOTION_CLIENT_SECRET,
);
```

This is fine for app-owned env vars. It does not model:

- "use the current user's Notion connection"
- "use the current tenant's Slack webhook"
- "use the refreshable OAuth token stored in our DB"

### 2. Workflow code is on track to absorb platform concerns

Without a better abstraction, workflow code ends up needing to understand:

- where credentials live
- which tenant or user to load them for
- how to handle timeouts
- how to handle retries

That pushes infrastructure concerns into step bodies.

### 3. Complex enhancement config gets hard to read quickly

One explored direction was a big step-enhancements config object. It is
powerful, but noisy:

```ts
action.with(
  {
    connections: { ... },
    logging: true,
    timeoutMs: 10_000,
    retry: { ... },
    redact: [ ... ],
    require: { ... },
  },
  async (...) => { ... },
  { name: "notionWrite" },
)
```

This is difficult to scan and mixes:

- dependencies
- execution policy
- instrumentation
- authorization constraints

### 4. Multi-tenant OAuth is not a first-class concept

The Notion example performs OAuth inside a workflow run:

- `examples/nextjs/src/workflows/notion.ts`
- `packages/integrations/notion/src/oauth.ts`

That is acceptable for a demo. It is not the right product abstraction for a
multi-tenant app where users connect Notion once and workflows use that saved
connection later.

## Design Principles

1. **Public API should stay small.**
2. **Runtime should handle platform concerns.**
3. **Capability resolution should be host-side.**
4. **Workflow code should focus on business logic.**
5. **Advanced pluggability should be internal-facing first.**

## Proposal

## 1. Add a Context-Based Step API

Keep existing `atom(fn, opts?)` and `action(fn, opts?)` support, but add a
context form:

```ts
type StepCtx = {
  get: Get;
  waitFor: RequestIntervention;
  use: {
    secret(name: string): Promise<string>;
    connection(name: string): Promise<ResolvedConnection>;
  };
  signal: AbortSignal;
  run: {
    id: string;
    step: string;
    workflowId?: string;
    organizationId?: string;
    userId?: string;
    attempt: number;
  };
};
```

Then allow:

```ts
atom(async (ctx) => { ... }, opts?)
action(async (ctx) => { ... }, opts?)
```

If preserving the current function signature is important, this can also be
introduced as:

```ts
atom.step(async (ctx) => { ... }, opts?)
action.step(async (ctx) => { ... }, opts?)
```

This RFC prefers the context form because it is easier to extend without adding
more positional arguments.

## 2. Add `use.secret(name)` and `use.connection(name)`

These are the only new capability lookups in the public API.

### `use.secret(name)`

Used for host-owned or tenant-scoped secret material.

```ts
const webhook = await use.secret("SLACK_INCOMING_WEBHOOK_URL");
```

### `use.connection(name)`

Used for user or tenant OAuth-backed connections.

```ts
const notion = await use.connection("notion");
```

The runtime decides how `notion` is resolved using:

- workflow context
- run context
- organization id
- user id
- host-side connection store

The workflow author does not manage lookup logic.

## 3. Add Minimal Step Policy in `opts`

The public policy surface should stay extremely small:

```ts
type StepOpts = {
  name?: string;
  retry?: number | RetryPolicy;
  timeout?: string | number;
};
```

Examples:

```ts
{ name: "postSlack", retry: 3, timeout: "5s" }
```

This is enough for a useful v1.

## 4. Add Runtime Plugins Internally

Borrow the **internal architecture idea** from Inngest: runtime middleware /
plugins can hook execution lifecycle and inject dependencies into step context.

Inngest explicitly uses middleware for lifecycle hooks and dependency injection.
That is a good fit for Partyplanner runtime internals.

However, Partyplanner should **not** expose a middleware-first authoring model
to workflow authors.

Instead:

- workflow authors use `get`, `use`, `signal`, `retry`, `timeout`
- runtime/platform authors use plugins/hooks

## Clear Code Examples

The examples below are written to be readable by a reviewer evaluating whether
this is worth building.

### Example A: Slack notification using a host-resolved secret

Current shape tends toward env-bound secrets:

```ts
const slackIncomingWebhookUrl = secret(
  "SLACK_INCOMING_WEBHOOK_URL",
  process.env.SLACK_INCOMING_WEBHOOK_URL,
);
```

Proposed shape:

```ts
const notifySlack = action(
  async ({ get, use, signal }) => {
    const draft = get(notificationDraft);
    const webhook = await use.secret("SLACK_INCOMING_WEBHOOK_URL");

    return postSlack(webhook, draft, { signal });
  },
  {
    name: "notifySlack",
    retry: 3,
    timeout: "5s",
  },
);
```

Why this is better:

- workflow code does not care whether the secret came from env, DB, vault, or
  tenant-scoped resolver
- retries and timeout are explicit and easy to read
- the step body stays focused on the actual business action

### Example B: Notion page creation using a user connection

This is the motivating multi-tenant use case.

```ts
const notionWrite = action(
  async ({ get, use, signal }) => {
    const req = get(notionLogRequest);
    const notion = await use.connection("notion");

    return createNotionPage({
      accessToken: notion.accessToken,
      parentPageId: req.parentPageId,
      title: req.title,
      body: req.body,
      signal,
    });
  },
  {
    name: "notionWrite",
    retry: 3,
    timeout: "10s",
  },
);
```

Why this is better:

- this reads like business logic, not infrastructure config
- the workflow does not know how to load the correct Notion connection
- the same code works whether the connection is user-scoped or tenant-scoped,
  as long as the runtime resolver knows how to find it

### Example C: A pure read atom using a connection

```ts
const notionProfile = atom(
  async ({ use, signal }) => {
    const notion = await use.connection("notion");
    return fetchNotionProfile(notion.accessToken, { signal });
  },
  {
    name: "notionProfile",
    timeout: "5s",
  },
);
```

Why this is useful:

- shows that `use.connection(...)` is not only for actions
- keeps the same model across reads and writes

### Example D: OAuth bootstrap remains possible

This RFC does not remove run-local OAuth flows. It just stops treating them as
the only model.

There are now two valid patterns:

1. **demo / bootstrap flow**
   - run does live OAuth
   - run uses token immediately
2. **product flow**
   - app stores connection
   - workflow later calls `use.connection("notion")`

That separation is important.

## What `signal` Means

`signal` is an `AbortSignal`.

It is the standard JavaScript cancellation primitive used by APIs such as
`fetch`. The runtime uses it to enforce step timeout and cancellation.

Example:

```ts
await fetch(url, { signal });
```

If the step exceeds its configured timeout, the runtime aborts the signal.

## Inheritance Model

Step policy should **not** descend to descendant nodes.

For example, if one step has:

```ts
{ retry: 3, timeout: "10s" }
```

that should not automatically apply to downstream steps.

Reason:

- each step should be readable in isolation
- ancestor-based policy inheritance becomes difficult to reason about
- Partyplanner steps execute independently through the queue

If shared defaults are needed, they should come from:

1. runtime defaults
2. workflow defaults
3. explicit step overrides

Not parent-step inheritance.

## Runtime Plugins: What They Would Do

These plugins are **internal-facing**. They are not the primary workflow
authoring mechanism.

Potential runtime plugin responsibilities:

- resolve `use.secret(name)`
- resolve `use.connection(name)`
- apply retry behavior
- apply timeout / abort behavior
- redact sensitive values from logs and error surfaces
- emit metrics
- emit structured logs
- enforce org/user requirements when capability resolution requires them

Conceptually, this is similar to Inngest's middleware lifecycle, where hooks can
run during function execution and dependency injection can add values to
function context.

That is the right thing to borrow from Inngest.

## What Not to Expose Publicly Yet

The following should remain runtime internals or future work:

- user-authored middleware stacks
- explicit logging configuration on every step
- explicit redaction config on every step
- metrics APIs in the workflow authoring surface
- large enhancement/config objects

Those all make the public API noisier without materially improving the main use
cases.

## Objectives Achieved by This Design

If implemented, this RFC gives Partyplanner:

### Better ergonomics

Workflow authors write:

```ts
const notion = await use.connection("notion");
```

instead of:

- env lookups
- manual DB fetches
- giant enhancement config

### Better multi-tenant fit

The runtime can resolve:

- current user's Notion connection
- current tenant's Slack secret
- future provider-specific policies

without changing workflow code.

### Better separation of concerns

- workflow code handles business logic
- runtime handles platform logic

### Better extensibility

The runtime plugin layer can grow over time without turning the public API into
an orchestration DSL.

## Implementation Sketch

### Phase 1

- add context-based step API
- add `use.secret(name)`
- add timeout + retry in opts
- add runtime support for `signal`

### Phase 2

- add `use.connection(name)`
- add `ConnectionResolver`
- thread `organizationId` / `userId` through runtime execution context

### Phase 3

- add runtime plugin system internally
- migrate secret resolution / retry / timeout into plugins
- keep public authoring API unchanged

## Alternatives Considered

### 1. Big step-enhancements config object

Rejected as primary design because it becomes too noisy and hard to scan.

### 2. Explicit public middleware API

Rejected as primary design because it is too heavy for Partyplanner's current
authoring model.

### 3. Keep only `secret(...)`

Rejected because it does not solve multi-tenant connection resolution cleanly.

## Recommendation

Build:

- a **small context-based step API**
- a **host-resolved capability model**
- an **internal runtime plugin system**

Do **not** build:

- a middleware-heavy public authoring model
- a large enhancement DSL

The clearest public API is:

```ts
const step = action(
  async ({ get, use, signal }) => {
    const conn = await use.connection("notion");
    ...
  },
  { name: "stepName", retry: 3, timeout: "10s" },
);
```

That is easy to understand, easy to explain, and strong enough to justify the
runtime work behind it.
