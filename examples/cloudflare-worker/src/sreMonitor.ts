import { atom, input, schedule, secret } from "@workflow/core";
import { postMessage, slack } from "@workflow/integrations-slack";
import { z } from "zod";

// ServiceName values emitted by the workers via @microlabs/otel-cf-workers and
// stored in otel.otel_traces / otel.otel_logs on ClickHouse Cloud
// (woucf8396t.us-east-1.aws.clickhouse.cloud, db `otel`).
const SERVICE_NAMES: Record<"connect" | "gateway", string> = {
  connect: "smithery-connect",
  gateway: "smithery-gateway",
};

export const sreMonitorTrigger = input(
  "sreMonitorTrigger",
  z.object({
    service: z
      .enum(["connect", "gateway"])
      .describe("Hot-path worker to inspect."),
    windowMinutes: z
      .number()
      .int()
      .min(5)
      .max(360)
      .default(30)
      .describe("Lookback window for metrics + logs, in minutes."),
    baselineMinutes: z
      .number()
      .int()
      .min(15)
      .max(1440)
      .default(180)
      .describe("Baseline window ending at the start of the lookback."),
    p99RegressionPct: z
      .number()
      .min(1)
      .max(500)
      .default(25)
      .describe("Flag p99 latency regressions above this percent vs baseline."),
    errorRateThresholdPct: z
      .number()
      .min(0)
      .max(100)
      .default(2)
      .describe("Flag if error rate in the window exceeds this percent."),
    slackChannel: z
      .string()
      .min(1)
      .describe("Slack channel ID or name for the SRE report."),
    githubRepo: z
      .string()
      .regex(/^[^/]+\/[^/]+$/)
      .default("smithery-ai/mono")
      .describe("owner/name of the repo whose recent commits we correlate."),
  }),
  {
    title: "Run SRE monitoring sweep",
    description:
      "Query ClickHouse OTel data for connect/gateway, correlate against recent commits, and post findings to Slack.",
  },
);

// Secrets are supplied at runtime via Cloudflare bindings (--var in dev,
// `wrangler secret put` in prod). The UI prompts the user when running.
export const clickhouseHost = secret("CH_HOST", undefined, {
  description:
    "ClickHouse Cloud HTTPS endpoint for the otel database (e.g. https://<id>.us-east-1.aws.clickhouse.cloud:8443).",
  errorMessage: "CH_HOST is not bound to this worker.",
});

export const clickhouseUser = secret("CH_USER", undefined, {
  description: "ClickHouse user with read access to the otel database.",
  errorMessage: "CH_USER is not bound to this worker.",
});

export const clickhouseKey = secret("CH_KEY", undefined, {
  description: "ClickHouse password / API key for the read-only otel user.",
  errorMessage: "CH_KEY is not bound to this worker.",
});

export const githubToken = secret("GITHUB_TOKEN", undefined, {
  description:
    "GitHub token with read access to commits for regression correlation.",
  errorMessage: "GITHUB_TOKEN is not bound to this worker.",
});

type LatencyStats = {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  requests: number;
  errors: number;
};

type ChCreds = { host: string; user: string; key: string };

async function clickhouseQuery<Row>(
  creds: ChCreds,
  sql: string,
  params: Record<string, string | number> = {},
): Promise<Row[]> {
  const url = new URL(creds.host);
  url.searchParams.set("default_format", "JSONEachRow");
  url.searchParams.set("database", "otel");
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(`param_${name}`, String(value));
  }

  const auth = `Basic ${btoa(`${creds.user}:${creds.key}`)}`;
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "text/plain" },
    body: sql,
  });

  if (!response.ok) {
    throw new Error(
      `ClickHouse ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }

  const text = await response.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
}

const LATENCY_SQL = `
  SELECT
    count()                              AS requests,
    countIf(StatusCode = 'Error')        AS errors,
    quantile(0.50)(Duration) / 1e6       AS p50Ms,
    quantile(0.95)(Duration) / 1e6       AS p95Ms,
    quantile(0.99)(Duration) / 1e6       AS p99Ms
  FROM otel.otel_traces
  WHERE ServiceName  = {service:String}
    AND ParentSpanId = ''
    AND Timestamp >= now() - INTERVAL {lookback:UInt32} MINUTE
    AND Timestamp <  now() - INTERVAL {offset:UInt32} MINUTE
`;

const ERROR_LOGS_SQL = `
  SELECT
    toString(Timestamp)                     AS timestamp,
    SeverityText                            AS level,
    LogAttributes['exception.type']         AS exceptionType,
    LogAttributes['exception.message']      AS exceptionMessage,
    substring(Body, 1, 240)                 AS body
  FROM otel.otel_logs
  WHERE ServiceName    = {service:String}
    AND SeverityNumber >= 17
    AND Timestamp >= now() - INTERVAL {lookback:UInt32} MINUTE
  ORDER BY Timestamp DESC
  LIMIT 25
`;

type LatencyRow = {
  requests: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

type LogSample = {
  timestamp: string;
  level: string;
  exceptionType: string;
  exceptionMessage: string;
  body: string;
};

function emptyLatency(): LatencyStats {
  return { p50Ms: 0, p95Ms: 0, p99Ms: 0, requests: 0, errors: 0 };
}

async function queryServiceLatency(
  creds: ChCreds,
  service: string,
  lookbackMinutes: number,
  offsetMinutes: number,
): Promise<LatencyStats> {
  const rows = await clickhouseQuery<LatencyRow>(creds, LATENCY_SQL, {
    service,
    lookback: lookbackMinutes,
    offset: offsetMinutes,
  });
  const row = rows[0];
  if (!row) return emptyLatency();
  return {
    requests: Number(row.requests) || 0,
    errors: Number(row.errors) || 0,
    p50Ms: Number(row.p50Ms) || 0,
    p95Ms: Number(row.p95Ms) || 0,
    p99Ms: Number(row.p99Ms) || 0,
  };
}

async function queryServiceErrors(
  creds: ChCreds,
  service: string,
  lookbackMinutes: number,
): Promise<LogSample[]> {
  return clickhouseQuery<LogSample>(creds, ERROR_LOGS_SQL, {
    service,
    lookback: lookbackMinutes,
  });
}

type Commit = {
  sha: string;
  message: string;
  author: string;
  url: string;
  when: string;
};

async function queryRecentCommits(
  repo: string,
  token: string,
  since: Date,
): Promise<Commit[]> {
  const url = `https://api.github.com/repos/${repo}/commits?since=${since.toISOString()}&per_page=20`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "hylo-sre-monitor",
    },
  });
  if (!response.ok) return [];
  const body = (await response.json()) as Array<{
    sha: string;
    html_url: string;
    commit: { message: string; author: { name?: string; date?: string } };
  }>;
  return body.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: c.commit.message.split("\n")[0].slice(0, 120),
    author: c.commit.author?.name ?? "unknown",
    url: c.html_url,
    when: c.commit.author?.date ?? "",
  }));
}

export const sreMonitorMetrics = atom(
  async (get) => {
    const trigger = get.maybe(sreMonitorTrigger);
    if (!trigger) return get.skip("No SRE monitor run requested");

    const creds: ChCreds = {
      host: get(clickhouseHost),
      user: get(clickhouseUser),
      key: get(clickhouseKey),
    };
    const service = SERVICE_NAMES[trigger.service];

    const [current, baseline, errorLogs] = await Promise.all([
      queryServiceLatency(creds, service, trigger.windowMinutes, 0),
      queryServiceLatency(
        creds,
        service,
        trigger.baselineMinutes,
        trigger.windowMinutes,
      ),
      queryServiceErrors(creds, service, trigger.windowMinutes),
    ]);

    return {
      service: trigger.service,
      serviceName: service,
      window: {
        currentMinutes: trigger.windowMinutes,
        baselineMinutes: trigger.baselineMinutes,
      },
      current,
      baseline,
      errorLogs,
    };
  },
  {
    name: "sreMonitorMetrics",
    description:
      "Query ClickHouse otel_traces for current + baseline latency and otel_logs for recent error records.",
  },
);

export const sreMonitorCommits = atom(
  async (get) => {
    const trigger = get.maybe(sreMonitorTrigger);
    if (!trigger) return get.skip("No SRE monitor run requested");

    const token = get(githubToken);
    const since = new Date(Date.now() - trigger.windowMinutes * 60_000);
    const commits = await queryRecentCommits(trigger.githubRepo, token, since);
    return { repo: trigger.githubRepo, since: since.toISOString(), commits };
  },
  {
    name: "sreMonitorCommits",
    description: "List commits to the service repo within the lookback window.",
  },
);

type Severity = "ok" | "warn" | "regress";

export const sreMonitorAnalysis = atom(
  (get) => {
    const trigger = get(sreMonitorTrigger);
    const metrics = get(sreMonitorMetrics);
    const commits = get(sreMonitorCommits);

    const findings: string[] = [];
    let severity: Severity = "ok";

    const errorRate =
      metrics.current.requests > 0
        ? (metrics.current.errors / metrics.current.requests) * 100
        : 0;

    if (errorRate > trigger.errorRateThresholdPct) {
      severity = "regress";
      findings.push(
        `Error rate ${errorRate.toFixed(2)}% exceeds threshold ${trigger.errorRateThresholdPct}% (${metrics.current.errors}/${metrics.current.requests} server spans).`,
      );
    }

    const baselineP99 = metrics.baseline.p99Ms || 1;
    const p99DeltaPct =
      ((metrics.current.p99Ms - baselineP99) / baselineP99) * 100;
    if (p99DeltaPct > trigger.p99RegressionPct) {
      severity = severity === "regress" ? "regress" : "warn";
      findings.push(
        `p99 latency regressed ${p99DeltaPct.toFixed(1)}% vs baseline (${metrics.current.p99Ms.toFixed(1)}ms vs ${baselineP99.toFixed(1)}ms).`,
      );
    }

    if (metrics.errorLogs.length > 0) {
      const sample = metrics.errorLogs
        .slice(0, 3)
        .map(
          (e) =>
            `• ${e.exceptionType || e.level}: ${e.exceptionMessage || e.body}`,
        )
        .join("\n");
      findings.push(
        `${metrics.errorLogs.length} error logs in window. Samples:\n${sample}`,
      );
    }

    if (findings.length === 0) {
      findings.push("No regression signals detected in the current window.");
    }

    const suspectCommits = commits.commits.slice(0, 5);

    return {
      severity,
      service: metrics.service,
      serviceName: metrics.serviceName,
      window: metrics.window,
      errorRate,
      p99DeltaPct,
      currentP99Ms: metrics.current.p99Ms,
      baselineP99Ms: baselineP99,
      requests: metrics.current.requests,
      findings,
      suspectCommits,
      needsReview: severity !== "ok",
    };
  },
  {
    name: "sreMonitorAnalysis",
    description:
      "Compare current vs baseline metrics from ClickHouse, surface findings, and tag recent commits as suspects.",
  },
);

export const sreMonitorReportApproval = input.deferred(
  "sreMonitorReportApproval",
  z.object({
    approved: z
      .boolean()
      .default(true)
      .describe("Whether the SRE report should be posted to Slack."),
    note: z
      .string()
      .optional()
      .describe("Optional override note to prepend to the Slack message."),
  }),
  {
    title: "Approve SRE report posting",
    description:
      "Required when the analysis flags a regression. Skipped automatically when nothing is wrong.",
  },
);

const sreReportText = atom(
  (get) => {
    const analysis = get(sreMonitorAnalysis);

    const header =
      analysis.severity === "regress"
        ? `:rotating_light: *${analysis.service}* regression detected`
        : analysis.severity === "warn"
          ? `:warning: *${analysis.service}* warning`
          : `:white_check_mark: *${analysis.service}* healthy`;

    const summary = [
      `Service: ${analysis.serviceName}`,
      `Window: last ${analysis.window.currentMinutes}m vs ${analysis.window.baselineMinutes}m baseline`,
      `Requests: ${analysis.requests} | Error rate: ${analysis.errorRate.toFixed(2)}%`,
      `p99: ${analysis.currentP99Ms.toFixed(1)}ms (Δ ${analysis.p99DeltaPct.toFixed(1)}% vs ${analysis.baselineP99Ms.toFixed(1)}ms baseline)`,
    ].join("\n");

    const findings = analysis.findings.map((f) => `• ${f}`).join("\n");

    const commits = analysis.suspectCommits.length
      ? analysis.suspectCommits
          .map((c) => `• <${c.url}|${c.sha}> ${c.message} _(${c.author})_`)
          .join("\n")
      : "_No commits in window_";

    let prefix = "";
    if (analysis.needsReview) {
      const approval = get(sreMonitorReportApproval);
      if (!approval.approved) {
        return get.skip(approval.note ?? "SRE report posting was rejected");
      }
      if (approval.note) prefix = `> ${approval.note}\n\n`;
    }

    return `${prefix}${header}\n\n${summary}\n\n*Findings*\n${findings}\n\n*Recent commits*\n${commits}`;
  },
  {
    name: "sreReportText",
    description:
      "Build the Slack-formatted SRE report body, optionally gated on human approval.",
  },
);

const sreReportChannel = atom((get) => get(sreMonitorTrigger).slackChannel, {
  name: "sreReportChannel",
});

export const sreReportMessage = postMessage({
  auth: slack,
  channel: sreReportChannel,
  text: sreReportText,
  actionName: "sreReportMessage",
});

// Recurring sweeps. The schedule definitions travel with the workflow — the
// executing backend (any platform that drives /schedules/tick) picks them up.
schedule("sreMonitorSweepConnect", "*/15 * * * *", {
  trigger: sreMonitorTrigger,
  payload: {
    service: "connect",
    windowMinutes: 30,
    baselineMinutes: 180,
    p99RegressionPct: 25,
    errorRateThresholdPct: 2,
    slackChannel: "#sre",
    githubRepo: "smithery-ai/mono",
  },
  description: "Sweep smithery-connect every 15 minutes.",
});

schedule("sreMonitorSweepGateway", "*/15 * * * *", {
  trigger: sreMonitorTrigger,
  payload: {
    service: "gateway",
    windowMinutes: 30,
    baselineMinutes: 180,
    p99RegressionPct: 25,
    errorRateThresholdPct: 2,
    slackChannel: "#sre",
    githubRepo: "smithery-ai/mono",
  },
  description: "Sweep smithery-gateway every 15 minutes.",
});

export const sreMonitorResult = atom(
  (get) => {
    const analysis = get(sreMonitorAnalysis);
    const delivery = get(sreReportMessage);
    return {
      workflow: "sre-monitor",
      action: "post-report",
      service: analysis.service,
      severity: analysis.severity,
      requests: analysis.requests,
      errorRatePct: analysis.errorRate,
      p99DeltaPct: analysis.p99DeltaPct,
      findings: analysis.findings,
      suspectCommits: analysis.suspectCommits.map((c) => c.sha),
      slack: { channel: delivery.channel, ts: delivery.ts },
    };
  },
  {
    name: "sreMonitorResult",
    description:
      "Final SRE monitor outcome — severity, key metrics, suspect commits, and the Slack delivery handle.",
  },
);
