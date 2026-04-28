import { action, atom, input, schedule, secret } from "@workflow/core";
import { defaultAppBaseUrl } from "@workflow/integrations-oauth";
import { postMessage, slack } from "@workflow/integrations-slack";
import { z } from "zod";

// Agentic variant of the SRE monitor: instead of running heuristic ClickHouse
// queries inline, dispatch a Flamecast cloud agent to do a deeper
// investigation, then resume the workflow when the agent posts its findings
// back to /webhooks.
//
//   sreAgentTrigger ──► sreAgentDispatch (action)  ──► flamecast.dev task
//                                                         │
//                       sreAgentInvestigation             │   Claude Code
//                       (deferred_input, paused) ◄────────┘   curl /webhooks
//                                       │
//                                       ▼
//                              sreAgentReport (atom)
//                                       │
//                                       ▼
//                              sreAgentSlackMessage (postMessage)

export const sreAgentTrigger = input(
  "sreAgentTrigger",
  z.object({
    service: z
      .enum(["connect", "gateway"])
      .describe("Hot-path worker the agent should investigate."),
    windowMinutes: z
      .number()
      .int()
      .min(5)
      .max(360)
      .default(30)
      .describe("Lookback window the agent should focus on."),
    slackChannel: z
      .string()
      .min(1)
      .describe("Slack channel for the final report."),
    githubRepo: z
      .string()
      .regex(/^[^/]+\/[^/]+$/)
      .default("smithery-ai/mono")
      .describe("Source repo for the agent's commit-correlation pass."),
    extraContext: z
      .string()
      .max(2_000)
      .optional()
      .describe(
        "Optional free-form notes to give the agent more context (e.g. ‘we just shipped #1234, pay attention to that’).",
      ),
  }),
  {
    title: "Run SRE monitoring sweep (agentic)",
    description:
      "Dispatch a Flamecast cloud agent to investigate connect or gateway and post a Slack report when it's done.",
  },
);

const SERVICE_NAMES: Record<"connect" | "gateway", string> = {
  connect: "smithery-connect",
  gateway: "smithery-gateway",
};

export const flamecastApiKey = secret("FLAMECAST_API_KEY", undefined, {
  description:
    "Flamecast organization API key (Authorization: Bearer). Mint via the `ff` CLI or WorkOS org API keys.",
  errorMessage: "FLAMECAST_API_KEY is not bound to this worker.",
});

export const flamecastWorkspaceId = secret(
  "FLAMECAST_WORKSPACE_ID",
  undefined,
  {
    description:
      "UUID of the Flamecast workspace that should host the dispatched task.",
    errorMessage: "FLAMECAST_WORKSPACE_ID is not bound to this worker.",
  },
);

// Flamecast API base URL. Hardcoded to the public hosted endpoint — override
// in code if you ever point at a self-hosted or local instance.
const FLAMECAST_API_BASE = "https://flamecast-backend.smithery.workers.dev";

// The deferred input the agent's webhook resolves. Schema deliberately mirrors
// what we tell the agent to POST in the prompt below — the webhook ingest
// matches incoming payloads against unresolved inputs by schema, so this is the
// contract.
export const sreAgentInvestigation = input.deferred(
  "sreAgentInvestigation",
  z.object({
    runId: z
      .string()
      .describe(
        "The hylo run id the agent was asked to resume. Echoed back from the dispatch payload.",
      ),
    status: z
      .enum(["completed", "failed"])
      .describe("Terminal outcome of the investigation."),
    severity: z
      .enum(["ok", "warn", "regress"])
      .default("ok")
      .describe("Agent's overall assessment."),
    summary: z
      .string()
      .min(1)
      .describe("One-paragraph summary of what the agent found."),
    findings: z
      .array(z.string())
      .default([])
      .describe("Bulleted list of specific findings, in agent priority order."),
    suspectCommits: z
      .array(
        z.object({
          sha: z.string(),
          message: z.string().optional(),
          url: z.string().optional(),
        }),
      )
      .default([])
      .describe("Commits the agent flagged as potentially regression-causing."),
    metrics: z
      .object({
        currentP99Ms: z.number().optional(),
        baselineP99Ms: z.number().optional(),
        errorRatePct: z.number().optional(),
        requests: z.number().optional(),
      })
      .optional()
      .describe("Numbers the agent pulled while investigating."),
    error: z
      .string()
      .optional()
      .describe("Populated when status === 'failed'."),
  }),
  {
    title: "Flamecast agent investigation",
    description:
      "Resolves when the dispatched cloud agent posts its findings back to the workflow's webhook ingest.",
  },
);

export const sreAgentDispatch = action(
  async (get, _requestIntervention, ctx) => {
    const trigger = get.maybe(sreAgentTrigger);
    if (!trigger) return get.skip("No SRE agent run requested");

    const apiKey = get(flamecastApiKey);
    const workspaceId = get(flamecastWorkspaceId);
    const apiBase = FLAMECAST_API_BASE;
    const appBase = get(defaultAppBaseUrl).replace(/\/+$/, "");

    const runId = ctx.runId;
    const webhookUrl = `${appBase}/api/workflow/webhooks`;
    const serviceName = SERVICE_NAMES[trigger.service];
    const prompt = buildPrompt({
      service: trigger.service,
      serviceName,
      windowMinutes: trigger.windowMinutes,
      githubRepo: trigger.githubRepo,
      extraContext: trigger.extraContext,
      webhookUrl,
      runId,
    });

    const response = await fetch(
      `${apiBase}/workspaces/${encodeURIComponent(workspaceId)}/tasks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          context: [{ source: "github_repo", source_id: trigger.githubRepo }],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Flamecast dispatch ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }

    const body = (await response.json()) as {
      id?: string;
      workflowRunId?: number | null;
      status?: string;
    };

    return {
      taskId: body.id,
      workflowRunId: body.workflowRunId ?? null,
      status: body.status ?? "submitted",
      webhookUrl,
      service: trigger.service,
      dispatchedAt: new Date().toISOString(),
    };
  },
  {
    name: "sreAgentDispatch",
    description:
      "Kick off a Flamecast cloud agent to investigate the requested service.",
  },
);

function buildPrompt(args: {
  service: "connect" | "gateway";
  serviceName: string;
  windowMinutes: number;
  githubRepo: string;
  extraContext: string | undefined;
  webhookUrl: string;
  runId: string;
}): string {
  return `You are an SRE on call for the smithery ${args.service} worker (ServiceName='${args.serviceName}').

Investigate the last ${args.windowMinutes} minutes of production traffic and report back.

**Bias: precision over recall.** This report goes to a human Slack channel. A noisy "warn" with weak attribution wastes attention and trains people to ignore us. Default to \`ok\`. Only escalate when you can defend the call.

1. Compare p99 / p95 / p50 wall-time and error rate against the prior baseline window. The OTel data lives in ClickHouse Cloud (database 'otel', tables otel_traces and otel_logs). Use the ClickHouse MCP if available, or run SQL against the cluster the workspace already has access to. Duration is in nanoseconds — divide by 1e6 for ms.
2. **Outlier sanity check.** Before declaring a p99 regression, count how many traces above the prior p99 occurred in the current window. If it's <5 traces in a 30-minute window and p95 + p50 are stable or improving and error rate didn't move, this is *outlier noise*, not a regression. Report \`ok\` with a one-line note ("p99 elevated due to N outlier traces; p95/p50 stable, no error rate change"). Do not flag commits.
3. **Severity bar (be strict):**
   - \`ok\`: nothing meaningfully changed, OR the only signal is tail-only outliers (see #2). This is the default.
   - \`warn\`: at least TWO of {p95 worse by ≥25%, error rate up ≥2pp, a *new* exception type in otel_logs} are true AND the regression appears across many traces (not a handful). And you can name a plausible cause.
   - \`regress\`: clear, sustained, multi-signal degradation — e.g., p95 + error rate both elevated AND a new exception fingerprint AND a plausible commit. Or any total outage / 5xx flood.
4. **Commit attribution gating.** Pull recent commits to ${args.githubRepo}. Only list a commit as a suspect if you can answer all three:
   - Does the regressed span/route actually traverse the code path the commit changed? (Check the diff. \`feat(SMI-1772)\` touching a new auth server doesn't explain a regression in a span that doesn't call that server.)
   - Is the changed code path *enabled in production* right now? (New endpoints behind a feature flag, gated routes, or code only mounted in non-prod environments are NOT suspects. When in doubt, grep the worker entrypoint to confirm the route is wired up.)
   - Did the commit deploy *before* the regression started? (Verify against deploy time / commit timestamp vs. the outlier trace times.)
   If you can't answer all three with a real signal, do not list the commit. An empty \`suspectCommits\` is the right answer most of the time.
5. Skim error logs in otel_logs (SeverityNumber >= 17) for the same window. Group by exception.type / fingerprint. Note any *new* fingerprints that didn't exist in the baseline window.
6. **Self-check before posting.** Re-read your summary. If a reader asked "what's the action item?", is the answer obvious? If the answer is "nothing, this is noise" — downgrade to \`ok\`.

${args.extraContext ? `Extra context from the operator:\n${args.extraContext}\n\n` : ""}When you are done — and only when you are done — POST the report back to hylo so the workflow can resume.

The Hylo runtime needs a few minutes after dispatch before its scheduler advances the run from \`running\` to \`waiting\`. Until it reaches \`waiting\`, the webhook endpoint will reply with HTTP 400 and \`{"message":"Webhook payloads can only be submitted to created or waiting runs. Current status: running"}\`. **This is expected.** Do not give up. Retry with backoff for up to ~10 minutes. Save the payload to a file first so you can keep retrying without rebuilding it:

  cat > /tmp/sre-webhook.json <<'EOF'
  {
    "runId": "${args.runId}",
    "payload": {
      "runId": "${args.runId}",
      "status": "completed",
      "severity": "<ok|warn|regress>",
      "summary": "<one-paragraph summary>",
      "findings": ["<finding 1>", "<finding 2>", "..."],
      "suspectCommits": [
        { "sha": "abc1234", "message": "...", "url": "https://github.com/${args.githubRepo}/commit/abc1234..." }
      ],
      "metrics": {
        "currentP99Ms": 123.4,
        "baselineP99Ms": 90.1,
        "errorRatePct": 0.5,
        "requests": 12345
      }
    }
  }
  EOF

  for i in $(seq 1 60); do
    BODY=$(curl -sS -w '\n%{http_code}' -X POST "${args.webhookUrl}" -H 'Content-Type: application/json' --data @/tmp/sre-webhook.json)
    CODE=$(echo "$BODY" | tail -1)
    echo "attempt $i: HTTP $CODE"
    if [ "$CODE" = "200" ]; then echo "webhook accepted"; break; fi
    sleep 10
  done

If you hit a fatal error you cannot recover from, POST the same envelope with \`status: "failed"\` and an \`error\` string. Do not omit the runId — the workflow run cannot resume without it.`;
}

export const sreAgentReport = atom(
  (get) => {
    const trigger = get(sreAgentTrigger);
    const dispatch = get(sreAgentDispatch);
    const investigation = get(sreAgentInvestigation);

    if (investigation.status === "failed") {
      return get.skip(investigation.error ?? "Agent investigation failed");
    }

    return {
      service: trigger.service,
      severity: investigation.severity,
      summary: investigation.summary,
      findings: investigation.findings,
      suspectCommits: investigation.suspectCommits,
      metrics: investigation.metrics ?? {},
      taskId: dispatch.taskId,
    };
  },
  {
    name: "sreAgentReport",
    description:
      "Combine the agent's findings with the original trigger context into a single Slack-ready payload.",
  },
);

const sreAgentReportText = atom(
  (get) => {
    const report = get(sreAgentReport);
    const header =
      report.severity === "regress"
        ? `:rotating_light: *${report.service}* regression (agent)`
        : report.severity === "warn"
          ? `:warning: *${report.service}* warning (agent)`
          : `:white_check_mark: *${report.service}* healthy (agent)`;

    const metrics = report.metrics;
    const metricLines: string[] = [];
    if (metrics.currentP99Ms !== undefined) {
      const baseline =
        metrics.baselineP99Ms !== undefined
          ? ` (baseline ${metrics.baselineP99Ms.toFixed(1)}ms)`
          : "";
      metricLines.push(`p99: ${metrics.currentP99Ms.toFixed(1)}ms${baseline}`);
    }
    if (metrics.errorRatePct !== undefined) {
      metricLines.push(`Error rate: ${metrics.errorRatePct.toFixed(2)}%`);
    }
    if (metrics.requests !== undefined) {
      metricLines.push(`Requests: ${metrics.requests}`);
    }

    const findings = report.findings.length
      ? report.findings.map((f) => `• ${f}`).join("\n")
      : "_(no specific findings)_";

    const commits = report.suspectCommits.length
      ? report.suspectCommits
          .map((c) =>
            c.url
              ? `• <${c.url}|${c.sha.slice(0, 7)}> ${c.message ?? ""}`.trim()
              : `• ${c.sha.slice(0, 7)} ${c.message ?? ""}`.trim(),
          )
          .join("\n")
      : "_No suspect commits flagged_";

    return [
      header,
      "",
      `> ${report.summary}`,
      "",
      ...(metricLines.length ? [metricLines.join(" | "), ""] : []),
      "*Findings*",
      findings,
      "",
      "*Suspect commits*",
      commits,
    ].join("\n");
  },
  { name: "sreAgentReportText" },
);

const sreAgentReportChannel = atom((get) => get(sreAgentTrigger).slackChannel, {
  name: "sreAgentReportChannel",
});

export const sreAgentSlackMessage = postMessage({
  auth: slack,
  channel: sreAgentReportChannel,
  text: sreAgentReportText,
  actionName: "sreAgentSlackMessage",
});

export const sreAgentResult = atom(
  (get) => {
    const report = get(sreAgentReport);
    const delivery = get(sreAgentSlackMessage);
    return {
      workflow: "sre-monitor-agent",
      action: "post-report",
      service: report.service,
      severity: report.severity,
      taskId: report.taskId,
      slack: { channel: delivery.channel, ts: delivery.ts },
    };
  },
  {
    name: "sreAgentResult",
    description:
      "Final agentic SRE outcome — task id, severity, and the Slack delivery handle.",
  },
);

// Cadence: every 30 minutes, dispatch agents for both hot-path workers. The
// schedule is intentionally less frequent than the heuristic version since each
// agent run is more expensive than a SQL query.
schedule("sreAgentSweepConnect", "*/30 * * * *", {
  trigger: sreAgentTrigger,
  payload: {
    service: "connect",
    windowMinutes: 30,
    slackChannel: "#bot-chat",
    githubRepo: "smithery-ai/mono",
  },
  description: "Agentic sweep of smithery-connect every 30 minutes.",
});

schedule("sreAgentSweepGateway", "*/30 * * * *", {
  trigger: sreAgentTrigger,
  payload: {
    service: "gateway",
    windowMinutes: 30,
    slackChannel: "#bot-chat",
    githubRepo: "smithery-ai/mono",
  },
  description: "Agentic sweep of smithery-gateway every 30 minutes.",
});
