import type { Hono } from "hono";
import type { NodeStatus, RunState } from "@rxwf/core";

export type GraphPhase =
  | "resolved_previously"
  | "resolved_in_this_run"
  | "skipped_previously"
  | "skipped_in_this_run"
  | "waiting_previously"
  | "waiting_in_this_run"
  | "blocked_previously"
  | "blocked_in_this_run"
  | "errored_previously"
  | "errored_in_this_run"
  | "not_reached"
  | "skipped";

export type GraphRequest = {
  workflowSource: string;
  state?: RunState;
  nodeOutputs?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  stepIds?: string[];
};

export type GraphNode = {
  id: string;
  kind: "input" | "deferred_input" | "atom";
  description?: string;
  status: NodeStatus;
  phase: GraphPhase;
  label: string;
  value?: unknown;
  deps: string[];
  blockedOn?: string;
  waitingOn?: string;
  skipReason?: string;
  attempts: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
};

export type GraphResponse = {
  runId: string;
  evaluatedStepIds: string[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  state: RunState;
};

type GraphSchema = {
  "/graph": {
    $post: {
      input: {
        json: GraphRequest;
      };
      output: GraphResponse;
      outputFormat: "json";
      status: 200;
    };
  };
};

export type AppType = Hono<object, GraphSchema>;
