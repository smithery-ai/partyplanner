import { action, atom, input, schedule, secret } from "@workflow/core";
import { defaultBroker } from "@workflow/integrations-oauth";
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

export const flamecastApiUrl = secret("FLAMECAST_API_URL", undefined, {
  description:
    "Flamecast API base URL. Defaults to https://api.flamecast.dev when bound to the literal string 'default'.",
  errorMessage: "FLAMECAST_API_URL is not bound to this worker.",
});

// The hylo backend URL is already declared (internal) by the OAuth integration
// as a shared secret. Re-declaring it would collide. We derive the base URL
// from the already-exported defaultBroker atom (which is `${HYLO_BACKEND_URL}
// /oauth`) by stripping the trailing path.
const hyloBackendBaseUrl = atom(
  (get) => get(defaultBroker).url.replace(/\/oauth\/?$/, ""),
  {
    name: "hyloBackendBaseUrl",
    description:
      "Base URL of the hylo backend, used to build the agent's webhook callback.",
    internal: true,
  },
);

const FLAMECAST_DEFAULT_BASE = "https://api.flamecast.dev";

function resolveFlamecastBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "default") return FLAMECAST_DEFAULT_BASE;
  return trimmed.replace(/\/+$/, "");
}

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
    const apiBase = resolveFlamecastBase(get(flamecastApiUrl));
    const backendBase = get(hyloBackendBaseUrl).replace(/\/+$/, "");

    const runId = ctx.runId;
    const webhookUrl = `${backendBase}/webhooks`;
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

Investigate the last ${args.windowMinutes} minutes of production traffic and report back. Specifically:

1. Compare p99 / p95 / p50 wall-time and error rate against the prior baseline window. The OTel data lives in ClickHouse Cloud (database 'otel', tables otel_traces and otel_logs). Use the ClickHouse MCP if available, or run SQL against the cluster the workspace already has access to. Duration is in nanoseconds — divide by 1e6 for ms.
2. Pull recent commits to ${args.githubRepo} that landed in or just before the window. Reason about whether any of them could have caused a regression.
3. Skim error logs in otel_logs (SeverityNumber >= 17) for the same window. Group by exception.type / fingerprint. Note any new errors that didn't exist before this window.
4. Decide a severity: 'ok' (nothing notable), 'warn' (degradation worth watching), or 'regress' (clear regression that needs human action).

${args.extraContext ? `Extra context from the operator:\n${args.extraContext}\n\n` : ""}When you are done — and only when you are done — POST the report back to hylo so the workflow can resume:

  curl -X POST "${args.webhookUrl}" \\
    -H 'Content-Type: application/json' \\
    -d '{
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
    }'

If you hit a fatal error you cannot recover from, POST the same envelope with status: "failed" and an error string. Do not omit the runId — the workflow run cannot resume without it.`;
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
    slackChannel: "#sre",
    githubRepo: "smithery-ai/mono",
  },
  description: "Agentic sweep of smithery-connect every 30 minutes.",
});

schedule("sreAgentSweepGateway", "*/30 * * * *", {
  trigger: sreAgentTrigger,
  payload: {
    service: "gateway",
    windowMinutes: 30,
    slackChannel: "#sre",
    githubRepo: "smithery-ai/mono",
  },
  description: "Agentic sweep of smithery-gateway every 30 minutes.",
});
