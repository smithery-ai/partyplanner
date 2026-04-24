import {
  type WorkflowPostgresDb,
  workflowDeployments,
} from "@workflow/postgres";
import { desc, eq, sql } from "drizzle-orm";
import { PlatformApiError } from "../errors";
import { parseJsonArray } from "../utils";

export type WorkflowDeploymentRecord = {
  tenantId: string;
  deploymentId: string;
  label?: string;
  workflowApiUrl?: string;
  workflowTargetUrl?: string;
  dispatchNamespace: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

export type WorkflowDeploymentRegistry = {
  get(deploymentId: string): Promise<WorkflowDeploymentRecord | undefined>;
  list(tenantId: string): Promise<WorkflowDeploymentRecord[]>;
  upsert(
    deployment: Omit<WorkflowDeploymentRecord, "createdAt" | "updatedAt">,
  ): Promise<void>;
  delete(deploymentId: string): Promise<void>;
  deleteByTenant(tenantId: string): Promise<void>;
  deleteByTag(tag: string): Promise<void>;
};

export function createWorkflowDeploymentRegistry(
  db: WorkflowPostgresDb,
): WorkflowDeploymentRegistry {
  return {
    async get(
      deploymentId: string,
    ): Promise<WorkflowDeploymentRecord | undefined> {
      const rows = await asDb(db)
        .select()
        .from(workflowDeployments)
        .where(eq(workflowDeployments.deploymentId, deploymentId))
        .limit(1);
      const row = (rows as WorkflowDeploymentRow[])[0];
      return row ? workflowDeploymentFromRow(row) : undefined;
    },

    async list(tenantId: string): Promise<WorkflowDeploymentRecord[]> {
      const rows = await asDb(db)
        .select()
        .from(workflowDeployments)
        .where(eq(workflowDeployments.tenantId, tenantId))
        .orderBy(
          desc(workflowDeployments.updatedAt),
          workflowDeployments.deploymentId,
        );
      return (rows as WorkflowDeploymentRow[]).map(workflowDeploymentFromRow);
    },

    async upsert(
      deployment: Omit<WorkflowDeploymentRecord, "createdAt" | "updatedAt">,
    ): Promise<void> {
      const now = Date.now();
      await asDb(db)
        .insert(workflowDeployments)
        .values({
          deploymentId: deployment.deploymentId,
          tenantId: deployment.tenantId,
          label: deployment.label ?? null,
          workflowApiUrl: deployment.workflowApiUrl ?? null,
          workflowTargetUrl: deployment.workflowTargetUrl ?? null,
          dispatchNamespace: deployment.dispatchNamespace,
          tagsJson: JSON.stringify(deployment.tags),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: workflowDeployments.deploymentId,
          set: {
            tenantId: deployment.tenantId,
            label: deployment.label ?? null,
            workflowApiUrl: deployment.workflowApiUrl ?? null,
            workflowTargetUrl: deployment.workflowTargetUrl ?? null,
            dispatchNamespace: deployment.dispatchNamespace,
            tagsJson: JSON.stringify(deployment.tags),
            updatedAt: now,
          },
        });
    },

    async delete(deploymentId: string): Promise<void> {
      await asDb(db)
        .delete(workflowDeployments)
        .where(eq(workflowDeployments.deploymentId, deploymentId));
    },

    async deleteByTenant(tenantId: string): Promise<void> {
      await asDb(db)
        .delete(workflowDeployments)
        .where(eq(workflowDeployments.tenantId, tenantId));
    },

    async deleteByTag(tag: string): Promise<void> {
      await asDb(db)
        .delete(workflowDeployments)
        .where(
          sql`exists (
            select 1
            from jsonb_array_elements_text(${workflowDeployments.tagsJson}::jsonb) as tag(value)
            where tag.value = ${tag}
          )`,
        );
    },
  };
}

export function requireWorkflowDeploymentRegistry(
  registry: WorkflowDeploymentRegistry | undefined,
): WorkflowDeploymentRegistry {
  if (!registry) {
    throw new PlatformApiError(
      503,
      "workflow_deployment_registry_unavailable",
      "Workflow deployment registry storage is not configured.",
    );
  }
  return registry;
}

type WorkflowDeploymentRow = {
  tenantId?: string;
  tenant_id?: string;
  deploymentId?: string;
  deployment_id?: string;
  label: string | null;
  workflowApiUrl?: string | null;
  workflow_api_url?: string | null;
  workflowTargetUrl?: string | null;
  workflow_target_url?: string | null;
  dispatchNamespace?: string;
  dispatch_namespace?: string;
  tagsJson?: string;
  tags_json?: string;
  createdAt?: number;
  created_at?: number;
  updatedAt?: number;
  updated_at?: number;
};

function workflowDeploymentFromRow(
  row: WorkflowDeploymentRow,
): WorkflowDeploymentRecord {
  return {
    tenantId: row.tenantId ?? row.tenant_id ?? "",
    deploymentId: row.deploymentId ?? row.deployment_id ?? "",
    ...(row.label ? { label: row.label } : {}),
    ...(row.workflowApiUrl || row.workflow_api_url
      ? { workflowApiUrl: row.workflowApiUrl ?? row.workflow_api_url ?? "" }
      : {}),
    ...(row.workflowTargetUrl || row.workflow_target_url
      ? {
          workflowTargetUrl:
            row.workflowTargetUrl ?? row.workflow_target_url ?? "",
        }
      : {}),
    dispatchNamespace: row.dispatchNamespace ?? row.dispatch_namespace ?? "",
    tags: parseJsonArray(row.tagsJson ?? row.tags_json ?? "[]"),
    createdAt: row.createdAt ?? row.created_at ?? 0,
    updatedAt: row.updatedAt ?? row.updated_at ?? 0,
  };
}

function asDb(db: WorkflowPostgresDb) {
  return db as never as {
    select: (...args: unknown[]) => {
      from: (table: unknown) => QueryBuilder;
    };
    insert: (table: unknown) => InsertBuilder;
    delete: (table: unknown) => DeleteBuilder;
  };
}

type QueryBuilder = {
  where(condition: unknown): QueryBuilder;
  orderBy(...columns: unknown[]): Promise<unknown[]>;
  limit(limit: number): Promise<unknown[]>;
  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): PromiseLike<TResult1 | TResult2>;
};

type InsertBuilder = {
  values(value: unknown): InsertBuilder;
  onConflictDoUpdate(args: unknown): Promise<unknown>;
};

type DeleteBuilder = {
  where(condition: unknown): Promise<unknown>;
};
