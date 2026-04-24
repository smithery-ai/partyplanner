import type { WorkflowPostgresDb } from "@workflow/postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackendApp } from "../src/app";
import { createCloudflareDeploymentBackend } from "../src/deployments/cloudflare-backend";
import { createLocalDeploymentBackend } from "../src/deployments/local-backend";
import type {
  WorkflowDeploymentRecord,
  WorkflowDeploymentRegistry,
} from "../src/deployments/registry";
import type { ProvisionDeploymentInput } from "../src/deployments/types";

const API_KEY = "test-api-key";

describe("deployment routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers local deployments with a backend worker URL and proxies to the portless workflow URL", async () => {
    const registry = new MemoryDeploymentRegistry();
    const app = createBackendApp({
      db: fakeDb(),
      env: { HYLO_API_KEY: API_KEY },
      deploymentRegistry: registry,
      deploymentBackend: createLocalDeploymentBackend(
        { HYLO_API_KEY: API_KEY },
        registry,
      ),
    });

    const createResponse = await app.request(
      "http://backend.test/deployments",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: "tenant-1",
          deploymentId: "workflow-cloudflare-worker-example-tenant1",
          label: "Cloudflare Worker Example",
          workflowId: "workflow-cloudflare-worker-example",
          moduleCode: "export default {};",
        }),
      },
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      workflowApiUrl?: string;
    };
    expect(created.workflowApiUrl).toBe(
      "/workers/workflow-cloudflare-worker-example-tenant1/api/workflow",
    );

    const registryResponse = await app.request(
      "http://backend.test/tenants/tenant-1/workflows",
      {
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    );
    expect(registryResponse.status).toBe(200);
    const tenantRegistry = (await registryResponse.json()) as {
      workflows: Record<string, { url: string }>;
    };
    expect(
      tenantRegistry.workflows["workflow-cloudflare-worker-example-tenant1"]
        ?.url,
    ).toBe("/workers/workflow-cloudflare-worker-example-tenant1/api/workflow");

    const fetchMock = vi.fn(async (request: Request) => {
      return Response.json({ url: request.url });
    });
    vi.stubGlobal("fetch", fetchMock);

    const workerResponse = await app.request(
      "http://backend.test/workers/workflow-cloudflare-worker-example-tenant1/api/workflow/runs?limit=1",
    );

    expect(workerResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await workerResponse.json()).toEqual({
      url: "https://workflow-cloudflare-worker-example.localhost/api/workflow/runs?limit=1",
    });
  });

  it("lets Cloudflare deployments derive their public worker URL from request origin", () => {
    const backend = createCloudflareDeploymentBackend({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_DISPATCH_NAMESPACE: "namespace",
    });

    expect(
      backend.resolveWorkflowApiUrl(
        provisionInput({ deploymentId: "customer-worker" }),
        "https://api.example.com",
      ),
    ).toBe("https://api.example.com/workers/customer-worker/api/workflow");
  });

  it("lets Cloudflare deployments prefer an explicit dispatch base URL", () => {
    const backend = createCloudflareDeploymentBackend({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_DISPATCH_NAMESPACE: "namespace",
      HYLO_WORKER_DISPATCH_BASE_URL: "https://workers.example.com",
    });

    expect(
      backend.resolveWorkflowApiUrl(
        provisionInput({ deploymentId: "customer-worker" }),
        "https://api.example.com",
      ),
    ).toBe("https://workers.example.com/customer-worker/api/workflow");
  });
});

class MemoryDeploymentRegistry implements WorkflowDeploymentRegistry {
  private readonly deployments = new Map<string, WorkflowDeploymentRecord>();

  async get(
    deploymentId: string,
  ): Promise<WorkflowDeploymentRecord | undefined> {
    return this.deployments.get(deploymentId);
  }

  async list(tenantId: string): Promise<WorkflowDeploymentRecord[]> {
    return Array.from(this.deployments.values()).filter(
      (deployment) => deployment.tenantId === tenantId,
    );
  }

  async upsert(
    deployment: Omit<WorkflowDeploymentRecord, "createdAt" | "updatedAt">,
  ): Promise<void> {
    const current = this.deployments.get(deployment.deploymentId);
    const now = Date.now();
    this.deployments.set(deployment.deploymentId, {
      ...deployment,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async delete(deploymentId: string): Promise<void> {
    this.deployments.delete(deploymentId);
  }

  async deleteByTenant(tenantId: string): Promise<void> {
    for (const deployment of this.deployments.values()) {
      if (deployment.tenantId === tenantId) {
        this.deployments.delete(deployment.deploymentId);
      }
    }
  }

  async deleteByTag(tag: string): Promise<void> {
    for (const deployment of this.deployments.values()) {
      if (deployment.tags.includes(tag)) {
        this.deployments.delete(deployment.deploymentId);
      }
    }
  }
}

function fakeDb(): WorkflowPostgresDb {
  return {} as WorkflowPostgresDb;
}

function provisionInput(
  overrides: Partial<ProvisionDeploymentInput> = {},
): ProvisionDeploymentInput {
  return {
    tenantId: "tenant-1",
    deploymentId: "workflow",
    moduleName: "index.mjs",
    moduleCode: "export default {};",
    compatibilityDate: "2026-04-19",
    tags: ["tenant:tenant-1"],
    ...overrides,
  };
}
