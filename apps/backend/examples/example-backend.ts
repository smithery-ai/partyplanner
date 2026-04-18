import { readFile } from "node:fs/promises";
import { hc } from "hono/client";
import type { RunState } from "../../../packages/core/src/index";
import { createApp } from "../src/app";
import type { AppType, GraphRequest } from "../src/rpc";

function examplePriorState(): RunState {
  const providerPayload = {
    name: "DispatchCo",
    openapiUrl: "https://dispatchco.example/openapi.json",
  };

  return {
    runId: "run-graph-demo",
    startedAt: Date.now() - 1000,
    trigger: "provider",
    payload: providerPayload,
    inputs: {
      provider: providerPayload,
    },
    nodes: {
      provider: {
        status: "resolved",
        value: providerPayload,
        deps: [],
        duration_ms: 0,
        attempts: 1,
      },
      assess: {
        status: "resolved",
        value: "dispatch-worker",
        deps: ["provider"],
        duration_ms: 0,
        attempts: 1,
      },
      dcrProxy: {
        status: "skipped",
        deps: ["assess"],
        duration_ms: 0,
        attempts: 1,
      },
      oauthProxy: {
        status: "skipped",
        deps: ["assess"],
        duration_ms: 0,
        attempts: 1,
      },
      buildSpec: {
        status: "resolved",
        value: {
          action: "build-spec",
          provider: "DispatchCo",
          openapiUrl: "https://dispatchco.example/openapi.json",
        },
        deps: ["assess", "provider"],
        duration_ms: 0,
        attempts: 1,
      },
      applyOverlay: {
        status: "waiting",
        deps: ["buildSpec", "overlayReview"],
        duration_ms: 0,
        waitingOn: "overlayReview",
        attempts: 1,
      },
    },
    waiters: {
      overlayReview: ["applyOverlay"],
    },
    processedEventIds: {
      "provider-event": true,
    },
  };
}

const workflowSource = await readFile(
  new URL(
    "../../../packages/core/examples/example-workflow.ts",
    import.meta.url,
  ),
  "utf8",
);

const app = createApp();
const client = hc<AppType>("http://localhost", {
  fetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => app.request(input, init),
});

const response = await client.graph.$post({
  json: {
    workflowSource,
    state: examplePriorState(),
    inputs: {
      overlayReview: {
        approved: true,
        strippedPaths: ["/paths/~1admin", "/components/schemas/InternalOnly"],
      },
    },
  } satisfies GraphRequest,
});

if (!response.ok) {
  throw new Error(
    `Graph request failed: ${response.status} ${await response.text()}`,
  );
}

console.log(JSON.stringify(await response.json(), null, 2));
