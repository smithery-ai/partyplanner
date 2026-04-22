# RFC: Step Runtime Policy for Reliable Integrations

Status: draft  
Branch: `rfc/step-capabilities-runtime-plugins`

## Summary

Partyplanner has a clean model for workflow dataflow: `input`, `atom`,
`action`, and `get`. What it does not yet have is an equally clean abstraction
for **cross-cutting execution concerns** that should apply consistently across
many steps.

Examples of those concerns include:

- retry policy
- timeout policy
- attempt visibility
- future logging, tracing, metrics, redaction, and rate-limit hooks

Today, there is no standard place to attach this kind of policy to a step.

This RFC proposes a small, typed `runtime` option on `atom()` and `action()`:

```ts
const githubStarEvent = input(
  "githubStarEvent",
  z.object({
    sender: z.object({ login: z.string() }),
  }),
);

const slackMessage = atom(
  (get) => {
    const star = get(githubStarEvent);
    return {
      channel: "#general",
      text: `Got new star from ${star.sender.login}`,
    };
  },
  { name: "slackMessage" },
);

const sendSlackNotification = action(
  async (get) => {
    const message = get(slackMessage);
    return postSlackMessage(message);
  },
  {
    name: "sendSlackNotification",
    runtime: {
      retry: 3,
      timeoutMs: 10_000,
    },
  },
);
```

The goal is to support cross-cutting concerns without changing Partyplanner's
core programming model:

- workflow data still flows through `get(...)`
- integrations still export helpers that return atoms/actions
- runtime policy is declared once and enforced centrally
- policy is visible in manifests, run snapshots, and future UI surfaces

## Problem

Partyplanner is well suited for human-in-the-loop and integration-heavy
workflows, but the current step API only describes **what** a step does. It does
not give the runtime a structured place to attach cross-cutting execution
concerns.

That creates three practical issues.

### 1. Cross-cutting concerns do not have a home

The same concerns show up across unrelated steps:

- retry transient failures
- stop waiting after a reasonable amount of time
- expose attempts and failure state consistently
- later: emit traces, metrics, audit events, and redacted logs

Without a shared step-level policy surface, each concern has to be encoded in
ad hoc wrapper code, custom integration options, or runtime internals that are
not visible to workflow authors.

### 2. Workflow authors cannot see or configure policy

Given this workflow:

```ts
export const notionLogPage = createPage({
  auth: notionLogAuth,
  parentPageId: notionLogParent,
  title: notionLogTitle,
  body: notionLogBody,
  actionName: "notionLogPage",
});
```

There is no place to answer:

- is this action retried?
- how long can it run?
- how many attempts have happened?
- should the UI present it as an external call with runtime policy?

### 3. The runtime cannot enforce policy consistently

Partyplanner already records step attempts and node status. But because retry
and timeout policy are not part of step metadata, the scheduler cannot apply a
consistent cross-cutting policy across atoms, actions, and packaged
integrations.

## Proposal

Add typed runtime policy to step options.

```ts
type RetryPolicy =
  | number
  | {
      maxAttempts: number;
      backoffMs?: number;
    };

type StepRuntimePolicy = {
  retry?: RetryPolicy;
  timeoutMs?: number;
};

type AtomOpts = {
  name?: string;
  description?: string;
  runtime?: StepRuntimePolicy;
};

type ActionOpts = {
  name?: string;
  description?: string;
  runtime?: StepRuntimePolicy;
};
```

The first supported concerns are:

- `runtime.retry`: number of attempts or a simple retry policy
- `runtime.timeoutMs`: maximum time allowed for a step attempt before it is
  considered timed out

No new step constructor is introduced. The public API remains:

- `atom(fn, opts?)`
- `action(fn, opts?)`

## Use Case 1: Slack Notification Action

Slack notifications are external writes. They can fail transiently because of
network issues, rate limits, or Slack service errors.

```ts
const githubStarEvent = input(
  "githubStarEvent",
  z.object({
    sender: z.object({ login: z.string() }),
  }),
);

const slackMessage = atom(
  (get) => {
    const star = get(githubStarEvent);
    return {
      channel: "#general",
      text: `Got new star from ${star.sender.login}`,
    };
  },
  { name: "slackMessage" },
);

const sendSlackNotification = action(
  async (get) => {
    const message = get(slackMessage);
    return postSlackMessage(message);
  },
  {
    name: "sendSlackNotification",
    description: "Post the GitHub star notification to Slack.",
    runtime: {
      retry: 3,
      timeoutMs: 5_000,
    },
  },
);
```

Value:

- the action declares that Slack is allowed three attempts
- the runtime can retry the same step consistently
- the manifest can show that this external write has retry/timeout policy
- the workflow author does not wrap `postSlackMessage(...)` manually

## Use Case 2: Notion Integration Helper

Existing integration packages already export helpers that create atoms/actions.
Those helpers can accept `runtime` and forward it to the underlying step.

```ts
export type CreatePageOptions = {
  auth: Atom<NotionAuth>;
  parentPageId: Handle<string>;
  title: Handle<string>;
  body?: Handle<string>;
  actionName?: string;
  runtime?: StepRuntimePolicy;
};

export function createPage(opts: CreatePageOptions): Action<NotionPage> {
  return action(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const parentPageId = get(opts.parentPageId);
      const title = get(opts.title);
      const body = opts.body ? get(opts.body) : undefined;

      return createNotionPage({
        accessToken,
        parentPageId,
        title,
        body,
      });
    },
    {
      name: opts.actionName ?? "notionCreatePage",
      description: "Create a Notion page.",
      runtime: opts.runtime,
    },
  );
}
```

Workflow authors then opt into reliability policy at the integration boundary:

```ts
export const notionLogPage = createPage({
  auth: notionLogAuth,
  parentPageId: notionLogParent,
  title: notionLogTitle,
  body: notionLogBody,
  actionName: "notionLogPage",
  runtime: {
    retry: { maxAttempts: 3, backoffMs: 1_000 },
    timeoutMs: 15_000,
  },
});
```

Value:

- integration helpers stay idiomatic to Partyplanner
- reliability policy is typed and visible at call sites
- integration authors do not need to implement retry wrappers themselves
- future Notion helpers can expose the same policy consistently

## Use Case 3: Read Atom with External API

Not every external call is an action. Reads should be able to declare runtime
policy too.

```ts
const spotifyPlaylists = getCurrentUserPlaylists({
  auth: spotifyAuth,
  name: "spotifyPlaylists",
  runtime: {
    retry: 2,
    timeoutMs: 10_000,
  },
});
```

The helper can forward `runtime` into an `atom(...)`:

```ts
export type GetCurrentUserPlaylistsOptions = {
  auth: Atom<SpotifyAuth>;
  name?: string;
  runtime?: StepRuntimePolicy;
};

export function getCurrentUserPlaylists(
  opts: GetCurrentUserPlaylistsOptions,
): Atom<SpotifyPlaylistSummary[]> {
  return atom(
    async (get) => {
      const { accessToken } = get(opts.auth);
      return fetchSpotifyPlaylists(accessToken);
    },
    {
      name: opts.name ?? "spotifyGetCurrentUserPlaylists",
      description: "List the current Spotify user's playlists.",
      runtime: opts.runtime,
    },
  );
}
```

Value:

- read atoms and write actions share the same policy model
- the runtime can apply consistent attempt tracking
- integration packages do not need separate "reliable atom" and "reliable
  action" abstractions

## Type Safety

This proposal keeps type safety simple.

### Workflow values stay typed through handles

Existing integration helpers already use typed handles:

```ts
const auth = notionOAuth(...);        // Atom<NotionAuth>
const title = notionLogTitle;         // Atom<string>
const page = createPage({ auth, title, ... }); // Action<NotionPage>
```

`get(handle)` keeps returning the handle's TypeScript value. This RFC does not
change dependency discovery or handle typing.

### Runtime policy is a typed option object

Invalid policy is caught at compile time:

```ts
action(fn, {
  name: "badStep",
  runtime: {
    retry: "three", // TypeScript error
    timeoutMs: "10s", // TypeScript error
  },
});
```

Valid policy is explicit and small:

```ts
action(fn, {
  name: "goodStep",
  runtime: {
    retry: { maxAttempts: 3, backoffMs: 500 },
    timeoutMs: 10_000,
  },
});
```

### Integration options remain typed

Integration packages expose `runtime?: StepRuntimePolicy` as part of their
existing option types. This makes cross-cutting policy available without adding
a new public DSL.

## Runtime Semantics

### Retry

When a step errors and has retry attempts remaining, the scheduler should
re-enqueue the same step.

Initial semantics:

- retry applies to real errors
- retry does not apply to `SkipError`
- retry does not apply while a step is waiting or blocked
- retry count is step-local
- retry policy does not descend to downstream nodes

### Timeout

`timeoutMs` defines how long a single step attempt may run before the runtime
marks that attempt as timed out.

For the first implementation, timeout is an execution outcome:

- the runtime records that the attempt timed out
- the scheduler may retry if policy allows
- the public step context does not get a new cancellation primitive

This keeps the public API small. Active cancellation of underlying work can be
evaluated later if concrete integration code needs it.

### Attempts

`NodeRecord.attempts` already exists. Retry behavior should build on that
instead of introducing a separate attempt model.

If more visibility is needed, `NodeRecord` can be extended:

```ts
type NodeRecord = {
  ...
  attempts: number;
  maxAttempts?: number;
  timedOut?: boolean;
};
```

## Manifest

Expose runtime policy on step manifests.

```ts
type WorkflowStepManifest = {
  id: string;
  kind: "atom" | "action";
  description?: string;
  runtime?: StepRuntimePolicy;
};
```

This enables UI and tooling to show that a step is externally reliable:

- "Retries up to 3 times"
- "Timeout: 10s"
- "Attempt 2 of 3"

## Implementation Plan

### Phase 1: Types and registry metadata

Update:

- [`packages/core/src/atom.ts`](/Users/gnijor/gurdasnijor/partyplanner/packages/core/src/atom.ts)
- [`packages/core/src/action.ts`](/Users/gnijor/gurdasnijor/partyplanner/packages/core/src/action.ts)
- [`packages/core/src/registry.ts`](/Users/gnijor/gurdasnijor/partyplanner/packages/core/src/registry.ts)
- [`packages/core/src/types.ts`](/Users/gnijor/gurdasnijor/partyplanner/packages/core/src/types.ts)

Add:

- `StepRuntimePolicy`
- `runtime?: StepRuntimePolicy` on atom/action options
- `runtime?: StepRuntimePolicy` on registered step definitions

### Phase 2: Manifest exposure

Update:

- [`packages/server/src/manifest.ts`](/Users/gnijor/gurdasnijor/partyplanner/packages/server/src/manifest.ts)

Expose `runtime` for atoms and actions.

### Phase 3: Scheduler enforcement

Update:

- [`packages/runtime/src/executor.ts`](/Users/gnijor/gurdasnijor/partyplanner/packages/runtime/src/executor.ts)
- [`packages/runtime/src/scheduler.ts`](/Users/gnijor/gurdasnijor/partyplanner/packages/runtime/src/scheduler.ts)

Add:

- timeout detection
- retry decision logic
- re-enqueue on retryable step failure
- event publishing for retry/timeout if needed

### Phase 4: Integration adoption

Update existing integration helpers to accept and forward `runtime`:

- Notion `createPage(...)`
- Notion `getPage(...)`
- Spotify reads
- Spotify writes

This phase proves the value of the policy model in real package APIs.

## Non-Goals

This RFC does not propose:

- a public middleware system
- a new step constructor
- provider-client injection
- first-class tenant/user connection binding
- a public cancellation API

Those may be useful later, but they are not required to deliver retry, timeout,
typed integration options, and manifest visibility.

## Open Questions

1. Should retry be implemented entirely in the scheduler, or should core expose
   richer failure metadata?
2. Should default retry policy be `undefined` or should actions get a small
   default retry count?
3. Should timeout failures get a distinct node error shape, or is
   `error.message = "Step timed out"` sufficient for v1?
4. Should retry events be added to `RunEvent`, or is updated node attempt state
   enough initially?
