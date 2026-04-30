# Flamecast SRE monitor — handoff for next session

**Snapshot date:** 2026-04-28
**Status:** Wired end-to-end and deployed (`sre-monitor-dme06d0hw0`), but not reliable yet — schedule tick sometimes doesn't fire, and the auto-pump race fix is unmerged.

---

## Pick up here, in this order

### 1. Land PR #114 (auto-pump fix) — blocker

- Branch: `auto-advance-runs-after-startrun`
- URL: https://github.com/smithery-ai/hylo/pull/114
- What it does: adds opt-in `manager.advanceUntilSettled(runId)` and calls it from HTTP route handlers in `packages/server/src/app.ts` for `startRun`, `submitInput`, `submitWebhook`, `submitIntervention`, `runScheduleNow`, and `tickSchedules` (per firing). `WorkflowManager` itself stays step-at-a-time — no contract change.
- Tests: 15/15 server tests + full workspace suite green; biome clean.
- Why it's needed: without this, every other `*/30` cron tick gets stuck in `running`. The Cloudflare/Node tenant workers are reactive and don't auto-pump the queue between HTTP requests, so `sreAgentDispatch` resolves but the run sits in `running` until something pokes `/advance`. The dispatched cloud agent then gets HTTP 400 (`"Current status: running"`) when it tries to post the webhook, and gives up.
- Verify after merge: watch at least one full cron tick — both `connect` and `gateway` runs should reach `waiting` without manual `/advance` pokes, and the agent's webhook should land cleanly.

### 2. Diagnose why the schedule didn't actually run

User observed runs not appearing on the expected cadence. Possible causes, in order of likelihood:

1. **CF cron precedence regression.** `[triggers]` at the top level of `wrangler.toml` is silently ignored when a named environment exists (PR #112 fixed this once already). Confirm `[env.production.triggers] crons = ["* * * * *"]` is present in `apps/backend-cloudflare/wrangler.toml` and live in the deployed worker.
2. **Tenant filtering in `deploymentRegistry.listAll()`** (added in PR #111). Confirm it's actually returning `sre-monitor-dme06d0hw0` and that the deployment's `tenantId` matches a real WorkOS org row. If filtering by org membership is silently excluding it, the tick never reaches the worker.
3. **`/schedules/tick` not reaching the tenant.** Look for `"scope":"schedule_dispatch"` error logs in the backend worker.
4. **Cron parser timezone.** `*/30 * * * *` evaluates UTC. Sanity-check `at` is UTC at the parser boundary; `cron.test.ts` covers this but worth confirming end-to-end.

Look at recent runs via:
```bash
curl -sS https://hylo-backend.smithery.workers.dev/workers/sre-monitor-dme06d0hw0/api/workflow/runs \
  | python3 -m json.tool
```

Compare to expected fire times (`*/30 * * * *` UTC).

### 3. Add a backend-root `/webhooks` proxy that routes by `runId`

Right now the agent must know `${HYLO_APP_URL}/api/workflow/webhooks` (the per-worker URL with the `/workers/<deploymentId>/` prefix). If `defaultAppBaseUrl` ever resolves oddly, the agent's webhook 404s and there's no graceful recovery. A backend-level `POST /webhooks` that finds the worker by `runId` from the body and forwards would be:

- A more robust public contract (no per-worker prefix leaking out)
- Resilient to URL drift
- A single place to add rate limiting, auth, etc.

Implementation: add the route in `packages/backend/src/app.ts` (or wherever the backend's Hono app lives), look up the deployment by `runId` (the run's `workflowId` is on the document), and forward the request to the tenant worker via `env.DISPATCHER`.

### 4. Tune severity bar from observed Slack traffic

The calibrated prompt (`apps/sre-monitor/src/sreMonitorAgent.ts`, `buildPrompt()`) currently enforces:

- Outlier sanity check (<5 outlier traces + stable p95/p50 + flat error rate → `ok` with note)
- Two-of-three rule for `warn` (need at least two of {p95 +25%, error rate +2pp, new exception fingerprint})
- Three-question commit attribution gate

After ~a week of fires, look at what landed in `#bot-chat` and adjust thresholds against actual on-call response patterns. If `warn`s are being ignored, raise the bar; if `regress`-worthy issues slipped through as `ok`, lower it.

### 5. Lower-priority cleanup

- **Lint hook scoping.** `posttooluse-validate` fires false positives on `fetch()` inside action bodies (allowed) and on `createWorkflow()` from `@workflow/server` (different SDK than the lint targets). Noisy but harmless.
- **Slack channel discovery hint.** Initial deploy went to `#sre` (didn't exist) before being changed to `#bot-chat`. Could surface "channels available to this bot" when configuring schedules.
- **Bake CF dispatch wiring into `@hylo/backend/cloudflare`.** The `DispatchFetch` signature, path-prefix stripping, and `[env.production.triggers]` requirement are all tribal knowledge right now. Future tenants of the dispatch namespace shouldn't need to rediscover them.

---

## What's already shipped (don't redo)

| Item | Where |
|---|---|
| `schedule()` primitive | PR #106 (merged) |
| Cron dispatcher hardening | PRs #111, #112, #113 (merged) |
| Internal SRE monitor app | PR #110 (merged) — deployed as `sre-monitor-dme06d0hw0` |
| Webhook URL fix using `defaultAppBaseUrl` | In PR #110 |
| Calibrated prompt (precision over recall) | In PR #110 |
| Auto-pump fix | **PR #114 (open)** ← merge first |
| Stainless SDK shim | `flamecast-mono` scaffold scripts |
| GH Actions OIDC + ClickHouse secrets | `gurdasnijor/flamecast-sre-monitor` |
| Flamecast backend deployed in smithery CF account | Required manual SQL inserts in `flamecast.user_organizations` and `flamecast.github_oauth_tokens` — if redeploying from scratch this will bite again |

---

## Key files to read first

- `apps/sre-monitor/src/sreMonitorAgent.ts` — the workflow itself + the agent prompt
- `apps/backend-cloudflare/src/index.ts` — cron handler + dispatch routing
- `apps/backend-cloudflare/wrangler.toml` — confirm `[env.production.triggers]` still present
- `packages/server/src/manager.ts` — `advanceUntilSettled` (in PR #114) lives here
- `packages/server/src/app.ts` — route handlers where the drain is wired (in PR #114)
- `packages/backend/src/scheduling/dispatcher.ts` — `dispatchTickToDeployments` + `DispatchFetch`
- `packages/backend/src/deployments/registry.ts` — `listAll()` for tenant fan-out
- `flamecast-integration-trip-report.md` (in repo root) — full context on every bump faced

---

## Reference URLs and IDs

- Hylo backend: `https://hylo-backend.smithery.workers.dev`
- Deployed SRE worker: `sre-monitor-dme06d0hw0`
- UI: `https://hylo-client.vercel.app/?worker=sre-monitor-dme06d0hw0`
- Flamecast backend: `https://flamecast-backend.smithery.workers.dev`
- Flamecast SRE GH Actions repo: `gurdasnijor/flamecast-sre-monitor`
- Hylo org id: `org_01KNJCYBKK9VHTF2DME06D0HW0`
