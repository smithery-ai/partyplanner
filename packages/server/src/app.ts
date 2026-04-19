import { Hono } from "hono";
import { z } from "zod";
import { WorkflowManager, type WorkflowManagerOptions } from "./manager";
import type {
  StartWorkflowRunRequest,
  SubmitWorkflowInputRequest,
} from "./types";

const StartWorkflowRunRequestSchema = z.object({
  inputId: z.string(),
  payload: z.any(),
  additionalInputs: z
    .array(z.object({ inputId: z.string(), payload: z.any() }))
    .optional(),
  runId: z.string().optional(),
  autoAdvance: z.boolean().optional(),
});

const SubmitWorkflowInputRequestSchema = z.object({
  inputId: z.string(),
  payload: z.any(),
  autoAdvance: z.boolean().optional(),
});

const SetWorkflowAutoAdvanceRequestSchema = z.object({
  autoAdvance: z.boolean(),
});

export type CreateWorkflowServerOptions = WorkflowManagerOptions & {
  basePath?: string;
};

export function createWorkflowServer(options: CreateWorkflowServerOptions) {
  const manager = new WorkflowManager(options);
  const app = new Hono();
  const basePath = normalizeBasePath(options.basePath);

  app.get(routePath(basePath, "/health"), (c) => c.json({ ok: true }));
  app.get(routePath(basePath, "/manifest"), (c) => c.json(manager.manifest()));
  app.get(routePath(basePath, "/runs"), async (c) =>
    c.json(await manager.listRuns()),
  );

  app.post(routePath(basePath, "/runs"), async (c) => {
    try {
      const body = StartWorkflowRunRequestSchema.parse(
        await readBody(c.req),
      ) as StartWorkflowRunRequest;
      return c.json(await manager.startRun(body));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get(routePath(basePath, "/runs/:runId"), async (c) => {
    const document = await manager.getRun(requireParam(c.req.param("runId")));
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(document);
  });

  app.get(routePath(basePath, "/state/:runId"), async (c) => {
    const document = await manager.getRun(requireParam(c.req.param("runId")));
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(document);
  });

  app.post(routePath(basePath, "/runs/:runId/inputs"), async (c) => {
    try {
      const body = SubmitWorkflowInputRequestSchema.parse(
        await readBody(c.req),
      ) as SubmitWorkflowInputRequest;
      return c.json(
        await manager.submitInput(requireParam(c.req.param("runId")), body),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post(routePath(basePath, "/runs/:runId/advance"), async (c) => {
    try {
      return c.json(
        await manager.advanceRun(requireParam(c.req.param("runId"))),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post(routePath(basePath, "/runs/:runId/auto-advance"), async (c) => {
    try {
      const body = SetWorkflowAutoAdvanceRequestSchema.parse(
        await readBody(c.req),
      );
      return c.json(
        await manager.setAutoAdvance(requireParam(c.req.param("runId")), body),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  return app;
}

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === "/") return "";
  return `/${basePath.replace(/^\/+|\/+$/g, "")}`;
}

function routePath(basePath: string, path: string): string {
  return `${basePath}${path}`;
}

function requireParam(value: string | undefined): string {
  if (value === undefined) throw new Error("Missing route parameter");
  return value;
}

async function readBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function errorResponse(
  c: { json(body: { message: string }, status: 400): Response },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ message }, 400);
}

export type WorkflowApp = ReturnType<typeof createWorkflowServer>;
