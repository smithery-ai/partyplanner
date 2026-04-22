# RFC: Host-Resolved Secrets and Credentials

Status: draft  
Branch: `rfc/step-capabilities-runtime-plugins`

## Summary

Partyplanner already has a useful `secret(...)` primitive for app-owned
secrets, but product integrations need a broader credential model:

- app secrets from env or a vault
- tenant-scoped API keys
- user-scoped OAuth connections
- redacted state and manifest visibility
- a UI flow for "this run is waiting on a credential"

This RFC proposes a host-resolved credential model built on Partyplanner's
existing handle semantics.

The core idea:

> secrets and credentials should be typed workflow dependencies, resolved by the
> host, redacted in state, and visible in the manifest.

That keeps the programming model familiar:

```ts
const notionAuth = credential(
  "notionAuth",
  notionAuthSchema,
  {
    provider: "notion",
    scope: "user",
    title: "Connect Notion",
  },
);

export const notionLogPage = createPage({
  auth: notionAuth,
  parentPageId: notionLogParent,
  title: notionLogTitle,
  body: notionLogBody,
});
```

The integration helper still receives a normal typed handle:

```ts
type CreatePageOptions = {
  auth: Handle<NotionAuth>;
  parentPageId: Handle<string>;
  title: Handle<string>;
  body?: Handle<string>;
};
```

No provider-client injection or new step constructor is required.

## Problem

The current secret model is useful but narrow.

Today, `secret(...)` works well for values like:

```ts
const notionClientSecret = secret(
  "NOTION_CLIENT_SECRET",
  process.env.NOTION_CLIENT_SECRET,
);
```

That covers app-owned environment secrets. It does not fully cover:

- "use this tenant's Slack webhook"
- "use the current user's saved Notion connection"
- "resolve this credential from a vault entry"
- "show the UI that this run is waiting for a credential"
- "record which credential binding was used without storing plaintext"

There are also partial APIs already present:

- server request types include `secretBindings`
- frontend code has secret vault hooks
- runtime has `SecretResolver`

But these pieces do not yet form a complete model.

## Proposal

Introduce a generalized credential requirement alongside `secret(...)`.

```ts
function credential<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: CredentialOpts,
): Credential<T>;

type CredentialOpts = {
  title?: string;
  description?: string;
  provider?: string;
  scope?: "app" | "organization" | "user";
  requiredScopes?: string[];
  errorMessage?: string;
};
```

`credential(...)` returns a typed handle, just like `input(...)`, `secret(...)`,
`atom(...)`, and `action(...)`.

When a step calls:

```ts
const auth = get(notionAuth);
```

the runtime behavior is:

- if the host resolved the credential, return the typed value
- if the credential is missing, mark the reading step as waiting
- if the credential is invalid or revoked, mark the reading step as errored or
  waiting depending on resolver response
- never store plaintext credential values in run state or traces

## Use Case 1: App Secret from Env or Vault

App-owned secrets should keep the current simple `secret(...)` API.

```ts
const slackWebhookUrl = secret("SLACK_WEBHOOK_URL", undefined, {
  title: "Slack webhook URL",
  description: "Incoming webhook used to post workflow notifications.",
  errorMessage: "Bind SLACK_WEBHOOK_URL before running Slack workflows.",
});

const postSlack = action(
  async (get) => {
    const webhookUrl = get(slackWebhookUrl);
    const message = get(slackMessage);
    return postSlackWebhook(webhookUrl, message);
  },
  {
    name: "postSlack",
    runtime: {
      retry: 3,
      timeoutMs: 5_000,
    },
  },
);
```

The host can resolve `SLACK_WEBHOOK_URL` from:

- environment variables
- a server-side vault
- a per-run secret binding

The workflow code does not change based on the source.

## Use Case 2: Tenant-Scoped Slack Credential

A multi-tenant app may need a different Slack credential for each organization.

```ts
const slackWebhook = credential(
  "slackWebhook",
  z.object({
    webhookUrl: z.string().url(),
    workspaceId: z.string().optional(),
  }),
  {
    provider: "slack",
    scope: "organization",
    title: "Slack workspace",
  },
);

const notifySlack = action(
  async (get) => {
    const slack = get(slackWebhook);
    const message = get(slackMessage);
    return postSlackWebhook(slack.webhookUrl, message);
  },
  {
    name: "notifySlack",
    runtime: {
      retry: 3,
      timeoutMs: 5_000,
    },
  },
);
```

The resolver receives run context and can bind the correct Slack credential for
the current organization.

Value:

- workflow code stays tenant-agnostic
- credential resolution is centralized
- run state can show that `slackWebhook` was resolved from an organization
  binding
- plaintext webhook URLs are never stored in state

## Use Case 3: User-Scoped Notion OAuth Connection

The current Notion integration has an in-run OAuth atom. That is useful for
examples, but a multi-tenant product usually wants users to connect Notion once
and reuse that connection across runs.

With `credential(...)`, a saved Notion connection can be represented as a typed
handle:

```ts
const notionAuth = credential("notionAuth", notionAuthSchema, {
  provider: "notion",
  scope: "user",
  title: "Notion account",
  requiredScopes: ["page:read", "page:write"],
});

export const notionLogPage = createPage({
  auth: notionAuth,
  parentPageId: notionLogParent,
  title: notionLogTitle,
  body: notionLogBody,
  actionName: "notionLogPage",
  runtime: {
    retry: 3,
    timeoutMs: 15_000,
  },
});
```

The integration helper does not need to know whether `auth` came from:

- in-run OAuth
- a saved user connection
- a vault-backed token
- a refreshed token resolved just before execution

It only requires a `Handle<NotionAuth>`.

## Type Safety

Credential values are typed by schema.

```ts
const notionAuth = credential("notionAuth", notionAuthSchema, {
  provider: "notion",
  scope: "user",
});
```

If `notionAuthSchema` parses to `NotionAuth`, then:

```ts
const auth = get(notionAuth);
```

has type `NotionAuth`.

This preserves Partyplanner's current type-safety story:

- inputs are typed handles
- atoms/actions are typed handles
- secrets are typed handles
- credentials become typed handles
- integration helpers compose typed handles

## Manifest Model

Expose credential requirements in the workflow manifest.

```ts
type WorkflowCredentialManifest = {
  id: string;
  kind: "secret" | "credential";
  title?: string;
  description?: string;
  provider?: string;
  scope?: "app" | "organization" | "user";
  requiredScopes?: string[];
  schema?: JsonSchema;
  errorMessage?: string;
};
```

This lets UI show:

- required app secrets
- required tenant/user connections
- missing credentials
- connect/bind actions

## Run State Model

Credential values should not be stored in plaintext. Run state should store
resolution status and binding metadata.

```ts
type CredentialResolutionRecord = {
  status: "resolved" | "missing" | "errored";
  kind: "secret" | "credential";
  provider?: string;
  scope?: "app" | "organization" | "user";
  binding?: {
    source: "env" | "vault" | "connection" | "run";
    vaultEntryId?: string;
    connectionId?: string;
    logicalName?: string;
  };
  error?: { message: string };
  resolvedAt?: number;
};

type RunState = {
  ...
  credentialResolutions?: Record<string, CredentialResolutionRecord>;
};
```

The existing `nodes` map can still show redacted dependency nodes, similar to
how `secret(...)` appears today:

```json
{
  "notionAuth": {
    "status": "resolved",
    "kind": "credential",
    "value": "[credential]",
    "deps": [],
    "duration_ms": 0,
    "attempts": 1
  }
}
```

This keeps dependency edges visible without leaking credential material.

## Resolver Model

Extend the current `SecretResolver` idea into a credential resolver.

```ts
type CredentialResolutionRequest = {
  workflow: WorkflowRef;
  runId: string;
  logicalName: string;
  provider?: string;
  scope?: "app" | "organization" | "user";
  requiredScopes?: string[];
  state: RunState;
};

type CredentialResolutionResult =
  | {
      status: "resolved";
      value: unknown;
      binding: CredentialResolutionRecord["binding"];
    }
  | {
      status: "missing";
      message?: string;
    }
  | {
      status: "errored";
      message: string;
    };

interface CredentialResolver {
  resolve(
    request: CredentialResolutionRequest,
  ): Promise<CredentialResolutionResult>;
}
```

The executor should resolve declared secrets/credentials before invoking the
core runtime, similar to how `RuntimeExecutor` resolves secrets today.

This preserves the synchronous `get(...)` contract inside steps.

## API Surface

The first implementation should expose:

```ts
secret(name, value, opts?) // existing API
credential(name, schema, opts?) // new API
```

and server APIs for binding missing credentials:

```txt
GET /vault/secrets
POST /vault/secrets
DELETE /vault/secrets/:id
PUT /runs/:runId/credential-bindings/:logicalName
```

The exact backing store can vary:

- local memory for examples
- Postgres/PGlite for local durable development
- external vault in production
- tenant/user connection store for OAuth integrations

## Implementation Plan

### Phase 1: Complete the existing secret binding path

The server already accepts `secretBindings`, and the frontend already has vault
hooks. Wire these through end to end:

- persist run secret bindings
- resolve `secret(...)` from bound vault entries
- show missing/resolved secret state in the manifest/run document
- avoid storing plaintext in run state

### Phase 2: Add typed `credential(...)`

Add:

- `credential(...)` handle constructor
- credential registry entries
- manifest entries
- redacted node representation
- credential resolver interface

### Phase 3: Add connection-backed resolvers

Support resolver backends for:

- app/env secrets
- vault entries
- organization credentials
- user OAuth connections

### Phase 4: Update integrations

Allow integrations to consume either current in-run OAuth atoms or saved
credential handles.

For example, Notion `createPage(...)` should continue accepting:

```ts
auth: Handle<NotionAuth>
```

so both of these work:

```ts
auth: notionOAuth(...)
auth: credential("notionAuth", notionAuthSchema, ...)
```

## Non-Goals

This RFC does not propose:

- provider-client injection into step context
- exposing raw credential values in manifests or run state
- replacing the current OAuth atoms immediately
- implementing a full account-connection product UI in the first phase
- changing `get(...)` dependency semantics

## Relationship To Runtime Policy RFC

This RFC complements `RFC-step-capabilities-and-runtime-plugins.md`.

- runtime policy handles **how a step executes**
- credential provisioning handles **what sensitive resources a step depends on**

They should remain separate API surfaces:

```ts
credential(...) // resource dependency
runtime: { retry, timeoutMs } // execution policy
```

The shared principle is that cross-cutting concerns should be declared in a
structured way and resolved/enforced by the runtime host.

## Open Questions

1. Should `credential(...)` be a new handle kind, or should it be implemented as
   a generalized secret input internally?
2. Should missing credentials always put dependent steps into `waiting`, or can
   resolvers choose between `waiting` and `errored`?
3. Should the first implementation support only `secret(...)` bindings and defer
   structured credentials until after vault support lands?
4. Should OAuth connection records live in Partyplanner's backend runtime, or in
   the host application database with only references stored in run state?
