# RFC: Typed Step Capabilities and Runtime Plugins

Status: draft  
Branch: `rfc/step-capabilities-runtime-plugins`

## Summary

This RFC proposes a type-safe capability model for Partyplanner based on
**typed provider contracts** bound directly to steps.

The public API should pivot away from string-based runtime capability lookup
like `use.connection("notion")` and instead move toward:

```ts
import { notion } from "@workflow/integrations-notion";

const notionWrite = action.using(
  { notion },
  async ({ get, notion, signal }) => {
    const req = get(notionLogRequest);

    return notion.pages.create({
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

Under the hood, the runtime remains pluggable and middleware-like. But the
workflow authoring API should stay:

- small
- declarative
- strongly typed
- consistent with `atom()` / `action()`

The core idea is:

> **Do not inject raw secrets. Inject typed provider clients.**

## Why this RFC exists

Partyplanner currently has the beginnings of a credential model, but not a
strong product abstraction for typed integrations or multi-tenant credential
resolution.

Current pieces include:

- `secret(...)` in `@workflow/core`
- `secretValues` at run submission time
- `SecretResolver` in `@workflow/runtime`
- `secretBindings` types in `@workflow/server`

Relevant files:

- `packages/core/src/input.ts`
- `packages/core/src/runtime.ts`
- `packages/core/src/atom.ts`
- `packages/core/src/action.ts`
- `packages/runtime/src/executor.ts`
- `packages/runtime/src/types.ts`
- `packages/server/src/manager.ts`

These are sufficient for:

- app-owned env secrets
- examples
- manual per-run secret injection

They are not sufficient for a production multi-tenant app with:

- per-user Notion connections
- per-tenant Slack credentials
- refreshable OAuth tokens
- provider-specific client contracts
- typed access to integration features

## Objective

Provide the most understandable and type-safe model possible for external
capabilities in Partyplanner, while preserving the clarity of the existing
workflow model.

Specifically, Partyplanner should:

1. let steps declare external capabilities in a typed way
2. let the runtime resolve those capabilities host-side using run/user/org
   context
3. keep workflow dataflow semantics centered on `get(...)`
4. support retries and timeout without cluttering the public API
5. remain compatible with the core principles in
   [SPEC.md](/Users/gnijor/gurdasnijor/partyplanner/SPEC.md)

## Current Pain Points

### 1. `secret(...)` is too low-level for product integrations

Today the common shape is:

```ts
export const notionClientSecret = secret(
  "NOTION_CLIENT_SECRET",
  process.env.NOTION_CLIENT_SECRET,
);
```

This is fine for app-owned env vars. It does not model:

- "use the current user's Notion account"
- "use the current tenant's Slack connection"
- "inject a typed Notion client with page APIs"

### 2. String-based capability lookup is ergonomic but weakly typed

A model like:

```ts
const notion = await use.connection("notion");
```

is simple, but it is still:

- stringly typed
- runtime-only validated
- weakly discoverable in editors
- too generic for provider-specific client behavior

### 3. Large enhancement config objects are hard to reason about

Another explored direction was a large per-step enhancement object. That is
powerful, but busy. It mixes:

- runtime policy
- capability declaration
- instrumentation
- authorization constraints

That makes the code harder to scan than the current `atom()` / `action()` API.

### 4. Workflow code risks absorbing platform concerns

Without a strong capability contract, workflow code tends to drift toward:

- secret lookup
- connection lookup
- provider-specific auth logic
- retry wrappers
- timeout wrappers

Those concerns belong in the runtime host and integration layer, not in each
workflow step.

## Design Principles

1. **Workflow dataflow stays in `get(...)`.**
2. **External capabilities are not workflow nodes.**
3. **Public API should be typed and compact.**
4. **Runtime should stay pluggable internally.**
5. **Provider packages should define typed client contracts.**

## Alignment with `SPEC.md`

This RFC is intended to stay aligned with the core semantics described in
[SPEC.md](/Users/gnijor/gurdasnijor/partyplanner/SPEC.md).

Important invariants to preserve:

### 1. `get(...)` remains the workflow dependency mechanism

The spec is explicit that:

- dependencies are discovered at runtime
- `get()` reads already-materialized workflow values
- blocked dependencies lead to `NotReadyError`

This RFC preserves that.

Typed capabilities such as `notion` are **not** accessed via `get(...)`.

### 2. External capabilities do not create workflow graph edges

The proposed capability model is separate from workflow handles.

That means:

- `get(notionLogRequest)` creates workflow dependency semantics
- `notion.pages.create(...)` does not create workflow graph edges

This preserves the runtime’s ability to reason clearly about workflow structure.

### 3. Side effects remain the user’s responsibility

The spec already states:

> Side effects in user code are the user's problem.

This RFC does not change that. It only gives steps a better way to access
typed external clients and small runtime policy like `retry` and `timeout`.

## Proposal

## 1. Add `atom.using(...)` and `action.using(...)`

The main public API addition is:

```ts
atom.using(capabilities, fn, opts?)
action.using(capabilities, fn, opts?)
```

This is the preferred authoring model for steps that need external
capabilities.

### Example

```ts
import { notion } from "@workflow/integrations-notion";

const notionWrite = action.using(
  { notion },
  async ({ get, notion, signal }) => {
    const req = get(notionLogRequest);

    return notion.pages.create({
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

This keeps the authoring shape close to the current API:

- step declaration
- step function
- small opts object

## 2. Add Typed Capability Tokens

Provider packages export typed capability tokens, not raw string names.

### Core type

```ts
export interface CapabilityToken<T> {
  readonly kind: "capability";
  readonly id: string;
  readonly __type?: T;
}
```

Helper:

```ts
export function capability<T>(id: string): CapabilityToken<T>;
```

### Example provider export

```ts
export type NotionClient = {
  pages: {
    create(input: {
      parentPageId: string;
      title: string;
      body: string;
      signal?: AbortSignal;
    }): Promise<{ id: string; url?: string }>;
    get(input: {
      pageId: string;
      signal?: AbortSignal;
    }): Promise<NotionPage>;
  };
};

export const notion = capability<NotionClient>("integration:notion");
```

This is the main type-safety win:

- provider contracts are explicit
- step context is inferred from declared capabilities
- workflow authors get typed methods instead of bags of credentials

## 3. Add Typed Step Context

Given:

```ts
action.using(
  { notion, slack },
  async (ctx) => { ... }
)
```

the handler context should be inferred as:

```ts
type StepCtx<TCapabilities> = {
  get: Get;
  waitFor: RequestIntervention;
  signal: AbortSignal;
  run: {
    id: string;
    step: string;
    workflowId?: string;
    organizationId?: string;
    userId?: string;
    attempt: number;
  };
} & InferCapabilities<TCapabilities>;
```

For example:

```ts
async ({ get, notion, signal }) => { ... }
```

should infer `notion` as `NotionClient`.

## 4. Keep `opts` Small

The public options object should stay minimal:

```ts
type StepOpts = {
  name?: string;
  retry?: number | RetryPolicy;
  timeout?: string | number;
};
```

This is enough for a useful first version.

## Clear Code Examples

The examples below are the clearest way to explain why this is worth building.

### Example A: Notion write using a typed capability

```ts
import { notion } from "@workflow/integrations-notion";

const notionWrite = action.using(
  { notion },
  async ({ get, notion, signal }) => {
    const req = get(notionLogRequest);

    return notion.pages.create({
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

Why this makes sense:

- no raw access token handling in workflow code
- no string capability lookup
- typed contract is obvious to the reader
- retry and timeout remain visible and small

### Example B: Notion read atom using the same typed capability

```ts
import { notion } from "@workflow/integrations-notion";

const notionProfile = atom.using(
  { notion },
  async ({ notion, signal }) => {
    return notion.users.me({ signal });
  },
  {
    name: "notionProfile",
    timeout: "5s",
  },
);
```

Why this matters:

- capability binding should not be restricted to `action()`
- typed provider clients are useful for reads and writes
- the API is consistent across step kinds

### Example C: Slack notification with a typed integration

```ts
import { slack } from "@workflow/integrations-slack";

const notifySlack = action.using(
  { slack },
  async ({ get, slack, signal }) => {
    const msg = get(notificationDraft);

    return slack.messages.post({
      channel: msg.channel,
      text: msg.text,
      signal,
    });
  },
  {
    name: "notifySlack",
    retry: 3,
    timeout: "5s",
  },
);
```

Why this is better than secrets-only resolution:

- workflow code consumes the domain client, not raw webhook/token details
- runtime remains free to resolve Slack however it wants
- provider-specific typing is visible where it matters

### Example D: Generic host-owned secret capability, if needed

Most integrations should prefer typed clients. But there may still be cases
where a raw secret is useful.

```ts
const rawWebhook = capability<string>("secret:SLACK_INCOMING_WEBHOOK_URL");

const notifySlack = action.using(
  { rawWebhook },
  async ({ get, rawWebhook, signal }) => {
    const draft = get(notificationDraft);
    return postSlack(rawWebhook, draft, { signal });
  },
  {
    name: "notifySlack",
    retry: 3,
    timeout: "5s",
  },
);
```

This should be the lower-level escape hatch, not the main user path.

## Why This Is Better Than `use.connection("notion")`

`use.connection("notion")` is attractive, but weaker because:

- it is string-based
- it requires runtime lookup inside the step body
- it hides available capabilities from the step signature
- it gives weaker editor/autocomplete support

By contrast, `action.using({ notion }, ...)`:

- makes capability requirements explicit
- enables strong inference in the step context
- moves capability wiring closer to the step declaration
- better matches Partyplanner’s declarative workflow style

## Runtime Architecture

This RFC still recommends a pluggable runtime model internally.

Borrow from Inngest:

- runtime lifecycle hooks
- dependency injection into handler context
- layered composition of plugins

Do not borrow:

- middleware-heavy workflow authoring

The runtime should support internal plugins that can:

- resolve typed capability tokens
- enforce timeout
- implement retry
- redact sensitive values in logs/errors
- emit metrics/tracing
- enforce org/user context requirements during capability binding

Workflow authors should not have to configure these directly in most cases.

## Capability Resolution

When a step declares:

```ts
action.using({ notion }, ...)
```

the runtime should:

1. inspect the step’s declared capability tokens
2. resolve them using host-side binders/resolvers
3. inject the resolved typed clients into the handler context

That means the runtime needs a capability resolver interface.

### Resolver shape

```ts
type CapabilityResolutionRequest = {
  workflowId?: string;
  runId: string;
  stepId: string;
  organizationId?: string;
  userId?: string;
  capabilityId: string;
};

interface CapabilityResolver {
  resolve<T>(request: CapabilityResolutionRequest): Promise<T>;
}
```

The host implementation decides whether `integration:notion` resolves to:

- a tenant-scoped Notion client
- a user-scoped Notion client
- a bootstrap/live-OAuth client

That is a runtime concern, not a workflow concern.

## Multi-Tenant OAuth Model

This RFC does not propose that workflows should keep performing OAuth inside the
run as their main product model.

Instead, the long-term product path should be:

1. user connects Notion through the app
2. app stores a durable connection record
3. runtime resolves the `notion` capability for the current user/org
4. steps consume the typed Notion client

This separates:

- connection lifecycle
- workflow execution lifecycle

That is the correct product boundary for multi-tenant SaaS.

## What `signal` Means

`signal` is an `AbortSignal`.

It is the standard JavaScript cancellation primitive used by APIs like
`fetch(...)`. The runtime uses it to enforce timeout and cancellation.

Example:

```ts
await fetch(url, { signal });
```

If the step exceeds its configured timeout, the runtime aborts the signal.

## Inheritance Model

Step configuration should **not** descend to descendant nodes.

For example:

```ts
{ retry: 3, timeout: "10s" }
```

on one step should not automatically affect downstream steps.

Reason:

- each step should be readable in isolation
- Partyplanner steps are independently scheduled
- ancestor-based policy inheritance is difficult to reason about

If shared defaults are needed, prefer:

1. runtime defaults
2. workflow-level defaults
3. explicit step overrides

Not parent-step inheritance.

## Compatibility with `atom()` / `action()`

This proposal does not require replacing existing APIs.

Additive shape:

- `atom(fn, opts?)`
- `action(fn, opts?)`
- `atom.using(capabilities, fn, opts?)`
- `action.using(capabilities, fn, opts?)`

This keeps the current model intact for simple steps while providing a stronger
typed contract for integration-heavy steps.

## Alternatives Considered

### 1. Keep `use.secret(...)` / `use.connection(...)`

Pros:

- simple
- small API

Cons:

- string-based
- weaker typing
- less declarative

Rejected as the final design direction.

### 2. Large step enhancement objects

Pros:

- powerful
- highly configurable

Cons:

- noisy
- hard to scan
- too much framework surface

Rejected as the primary authoring model.

### 3. Public middleware stacks

Pros:

- maximum flexibility

Cons:

- too abstract for most workflow authors
- drifts away from the current Partyplanner ergonomics

Rejected as the public API, though recommended internally for runtime
pluggability.

## Implementation Sketch

### Phase 1

- add `CapabilityToken<T>`
- add `atom.using(...)` / `action.using(...)`
- add typed context inference from capability declarations
- add `timeout` and `retry` support in opts

### Phase 2

- add runtime capability resolver
- add integration packages exporting typed capability tokens
- convert Notion example to use typed capability contracts

### Phase 3

- add internal runtime plugins for:
  - capability resolution
  - timeout
  - retry
  - redaction
  - metrics/logging

### Phase 4

- add workflow-level defaults if needed
- add product-level account connection model that backs capability resolution

## Recommendation

Build:

- a typed capability token model
- `atom.using(...)` / `action.using(...)`
- runtime-side capability resolution
- small step opts with `retry` and `timeout`
- internal plugin architecture for platform concerns

Do not build:

- a public middleware-heavy authoring surface
- a string-based `use.connection("...")` API as the final design
- large enhancement config objects

The clearest and most type-safe Partyplanner model is:

> **Steps declare typed provider capabilities; the runtime resolves them; step
> code receives typed clients.**

That is easier for reviewers to understand, stronger for TypeScript users, and
more productizable for multi-tenant SaaS than the alternatives explored so far.
