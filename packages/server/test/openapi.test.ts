import { globalRegistry, input } from "@workflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkflow } from "../src";

describe("workflow OpenAPI routes", () => {
  beforeEach(() => {
    globalRegistry.clear();
  });

  afterEach(() => {
    globalRegistry.clear();
  });

  it("exposes generated OpenAPI JSON and Swagger UI under the workflow base path", async () => {
    input(
      "lead",
      z.object({
        name: z.string(),
        plan: z.enum(["free", "enterprise"]),
      }),
      { title: "Lead", description: "Lead payload" },
    );

    const app = createWorkflow({
      basePath: "/api/workflow",
      backendApi: "http://backend.test",
      workflow: {
        id: "nextjs-example",
        version: "v1",
        name: "Next.js Example",
      },
    });

    const response = await app.request("/api/workflow/openapi.json");
    expect(response.status).toBe(200);

    const document = asRecord(await response.json());
    expect(asRecord(document.info).title).toBe("Next.js Example Workflow API");
    expect(asRecord(document.info).version).toBe("v1");

    const paths = asRecord(document.paths);
    expect(asRecord(paths["/api/workflow/runs"]).post).toBeTruthy();
    expect(
      asRecord(paths["/api/workflow/runs/{runId}/inputs"]).post,
    ).toBeTruthy();
    expect(paths["/api/workflow/runs/{runId}/auto-advance"]).toBeUndefined();

    const components = asRecord(document.components);
    const schemas = asRecord(components.schemas);
    expect(JSON.stringify(schemas.WorkflowInputRequest)).toContain("lead");
    expect(JSON.stringify(schemas.WorkflowInputRequest)).toContain(
      "enterprise",
    );
    expect(JSON.stringify(schemas.WorkflowRunDocument)).not.toContain(
      "autoAdvance",
    );

    const swagger = await app.request("/api/workflow/swagger");
    expect(swagger.status).toBe(200);
    expect(await swagger.text()).toContain("/api/workflow/openapi.json");
  });

  it("can disable OpenAPI routes", async () => {
    const app = createWorkflow({
      backendApi: "http://backend.test",
      openApi: false,
    });

    const response = await app.request("/openapi.json");
    expect(response.status).toBe(404);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}
