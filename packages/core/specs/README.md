# @workflow/core Quint specs

`core-runtime.qnt` is a finite model of the runtime guarantees described in the
repo README. The model uses a larger graph than the unit-test examples:
Slack/email/GitHub/webhook source inputs, deferred approval, a dynamic
human-prompt response, a secret, multi-input extraction, GitHub review,
enrichment, a pull-only notify action, and two downstream consumers of that
action.

- input events start a run and fan out to atoms, not actions
- later input events dirty derived atoms so skipped/resolved branches can recover
- actions are pull-only and execute their side effect at most once
- missing normal inputs skip their branch, while deferred inputs wait and resume
- out-of-band human prompt callbacks only resume fresh waiting requests
- stale prompt callbacks after webhook/input re-entry do not authorize new state
- dependency reads block/wake downstream work
- unexpected atom errors become terminal and propagate to dependent work
- secrets are represented only as redacted state
- replayed input/webhook event IDs are no-ops

Commands:

```sh
pnpm --filter @workflow/core spec:check
pnpm --filter @workflow/core spec:run
pnpm --filter @workflow/core spec:verify
pnpm --filter @workflow/core spec:verify:deep
```

`spec:run` uses the Quint simulator and does not require Java. `spec:verify`
uses Apalache through Quint and requires a JDK 17+ runtime. The default
verification bound is intentionally shallow so it completes locally; the deep
script uses the larger bound and is suitable for slower CI or overnight checks.
