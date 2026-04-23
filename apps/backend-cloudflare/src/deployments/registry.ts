import { PlatformApiError } from "../errors";
import type { WorkflowDeploymentRegistryDb } from "../types";
import { parseJsonArray } from "../utils";

export type WorkflowDeploymentRecord = {
  tenantId: string;
  deploymentId: string;
  label?: string;
  workflowApiUrl?: string;
  dispatchNamespace: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

export function createWorkflowDeploymentRegistry(
  db: WorkflowDeploymentRegistryDb,
) {
  return {
    async get(
      deploymentId: string,
    ): Promise<WorkflowDeploymentRecord | undefined> {
      const result = await db
        .prepare(
          `select tenant_id, deployment_id, label, workflow_api_url, dispatch_namespace, tags_json, created_at, updated_at
           from workflow_deployments
           where deployment_id = ?`,
        )
        .bind(deploymentId)
        .first<WorkflowDeploymentRow>();
      return result ? workflowDeploymentFromRow(result) : undefined;
    },

    async list(tenantId: string): Promise<WorkflowDeploymentRecord[]> {
      const result = await db
        .prepare(
          `select tenant_id, deployment_id, label, workflow_api_url, dispatch_namespace, tags_json, created_at, updated_at
           from workflow_deployments
           where tenant_id = ?
           order by updated_at desc, deployment_id asc`,
        )
        .bind(tenantId)
        .all<WorkflowDeploymentRow>();
      return (result.results ?? []).map(workflowDeploymentFromRow);
    },

    async upsert(
      deployment: Omit<WorkflowDeploymentRecord, "createdAt" | "updatedAt">,
    ): Promise<void> {
      const now = Date.now();
      await db
        .prepare(
          `insert into workflow_deployments (
             deployment_id, tenant_id, label, workflow_api_url, dispatch_namespace, tags_json, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(deployment_id) do update set
             tenant_id = excluded.tenant_id,
             label = excluded.label,
             workflow_api_url = excluded.workflow_api_url,
             dispatch_namespace = excluded.dispatch_namespace,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          deployment.deploymentId,
          deployment.tenantId,
          deployment.label ?? null,
          deployment.workflowApiUrl ?? null,
          deployment.dispatchNamespace,
          JSON.stringify(deployment.tags),
          now,
          now,
        )
        .run();
    },

    async delete(deploymentId: string): Promise<void> {
      await db
        .prepare("delete from workflow_deployments where deployment_id = ?")
        .bind(deploymentId)
        .run();
    },

    async deleteByTenant(tenantId: string): Promise<void> {
      await db
        .prepare("delete from workflow_deployments where tenant_id = ?")
        .bind(tenantId)
        .run();
    },

    async deleteByTag(tag: string): Promise<void> {
      await db
        .prepare(
          `delete from workflow_deployments
           where exists (
             select 1 from json_each(workflow_deployments.tags_json)
             where json_each.value = ?
           )`,
        )
        .bind(tag)
        .run();
    },
  };
}

export function requireWorkflowDeploymentRegistry(
  db: WorkflowDeploymentRegistryDb | undefined,
) {
  if (!db) {
    throw new PlatformApiError(
      503,
      "workflow_deployment_registry_unavailable",
      "Workflow deployment registry storage is not configured.",
    );
  }
  return createWorkflowDeploymentRegistry(db);
}

type WorkflowDeploymentRow = {
  tenant_id: string;
  deployment_id: string;
  label: string | null;
  workflow_api_url: string | null;
  dispatch_namespace: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
};

function workflowDeploymentFromRow(
  row: WorkflowDeploymentRow,
): WorkflowDeploymentRecord {
  return {
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    ...(row.label ? { label: row.label } : {}),
    ...(row.workflow_api_url ? { workflowApiUrl: row.workflow_api_url } : {}),
    dispatchNamespace: row.dispatch_namespace,
    tags: parseJsonArray(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
