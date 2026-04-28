import { sql } from "drizzle-orm";
import type { WorkflowPostgresDb } from "./adapter";

export type DeletePostgresTenantDataResult = {
  tenantId: string;
  deleted: {
    workflowDeployments: number;
    workflowRunDocuments: number;
    workflowRunStates: number;
    workflowEvents: number;
    workflowQueueItems: number;
    oauthPending: number;
    oauthHandoffs: number;
    oauthRefreshTokens: number;
    providerInstallations: number;
  };
};

export type DeletePostgresDatabaseDataResult = {
  deleted: DeletePostgresTenantDataResult["deleted"];
};

const emptyDeletedCounts: DeletePostgresTenantDataResult["deleted"] = {
  workflowDeployments: 0,
  workflowRunDocuments: 0,
  workflowRunStates: 0,
  workflowEvents: 0,
  workflowQueueItems: 0,
  oauthPending: 0,
  oauthHandoffs: 0,
  oauthRefreshTokens: 0,
  providerInstallations: 0,
};

export async function deletePostgresDatabaseData(
  db: WorkflowPostgresDb,
): Promise<DeletePostgresDatabaseDataResult> {
  const rows = (await asDb(db).execute(sql`
    with deleted_provider_installations as (
      delete from provider_installations returning 1
    ),
    deleted_oauth_refresh_tokens as (
      delete from oauth_refresh_tokens returning 1
    ),
    deleted_oauth_handoffs as (
      delete from oauth_handoffs returning 1
    ),
    deleted_oauth_pending as (
      delete from oauth_pending returning 1
    ),
    deleted_queue_items as (
      delete from workflow_queue_items returning 1
    ),
    deleted_events as (
      delete from workflow_events returning 1
    ),
    deleted_run_states as (
      delete from workflow_run_states returning 1
    ),
    deleted_run_documents as (
      delete from workflow_run_documents returning 1
    ),
    deleted_deployments as (
      delete from workflow_deployments returning 1
    )
    select
      (select count(*) from deleted_deployments)::int as "workflowDeployments",
      (select count(*) from deleted_run_documents)::int as "workflowRunDocuments",
      (select count(*) from deleted_run_states)::int as "workflowRunStates",
      (select count(*) from deleted_events)::int as "workflowEvents",
      (select count(*) from deleted_queue_items)::int as "workflowQueueItems",
      (select count(*) from deleted_oauth_pending)::int as "oauthPending",
      (select count(*) from deleted_oauth_handoffs)::int as "oauthHandoffs",
      (select count(*) from deleted_oauth_refresh_tokens)::int as "oauthRefreshTokens",
      (select count(*) from deleted_provider_installations)::int as "providerInstallations"
  `)) as Array<DeletePostgresDatabaseDataResult["deleted"]>;

  return { deleted: rows[0] ?? emptyDeletedCounts };
}

export async function deletePostgresTenantData(
  db: WorkflowPostgresDb,
  tenantId: string,
): Promise<DeletePostgresTenantDataResult> {
  const rows = (await asDb(db).execute(sql`
    with tenant_deployments as (
      select
        deployment_id,
        coalesce(workflow_id, nullif(label, ''), deployment_id) as workflow_id,
        workflow_api_url,
        workflow_target_url
      from workflow_deployments
      where tenant_id = ${tenantId}
    ),
    target_run_ids as (
      select run_id
      from workflow_run_documents
      where workflow_id in (select workflow_id from tenant_deployments)
         or workflow_id in (select deployment_id from tenant_deployments)
         or document_json::jsonb #>> '{workflow,organizationId}' = ${tenantId}
      union
      select concat('@configuration/', workflow_id)
      from tenant_deployments
      where workflow_id is not null and workflow_id <> ''
      union
      select concat('@configuration/', deployment_id)
      from tenant_deployments
    ),
    deleted_refresh_tokens as (
      delete from oauth_refresh_tokens refresh
      where exists (
        select 1
        from workflow_run_documents documents
        join target_run_ids target on target.run_id = documents.run_id
        where documents.document_json like concat('%', refresh.session_id, '%')
      )
      or exists (
        select 1
        from workflow_run_states states
        join target_run_ids target on target.run_id = states.run_id
        where states.state_json like concat('%', refresh.session_id, '%')
      )
      returning 1
    ),
    deleted_oauth_pending as (
      delete from oauth_pending pending
      where pending.value_json::jsonb ->> 'runId' in (select run_id from target_run_ids)
      or exists (
        select 1
        from tenant_deployments deployments
        where deployments.deployment_id <> ''
          and pending.value_json::jsonb ->> 'runtimeHandoffUrl' like concat('%', deployments.deployment_id, '%')
      )
      returning 1
    ),
    deleted_oauth_handoffs as (
      delete from oauth_handoffs handoffs
      where handoffs.value_json::jsonb ->> 'runId' in (select run_id from target_run_ids)
      returning 1
    ),
    deleted_provider_installations as (
      delete from provider_installations installations
      where installations.deployment_id in (select deployment_id from tenant_deployments)
      or exists (
        select 1
        from tenant_deployments deployments
        where deployments.deployment_id <> ''
          and installations.runtime_handoff_url like concat('%', deployments.deployment_id, '%')
      )
      returning 1
    ),
    deleted_queue_items as (
      delete from workflow_queue_items queue
      where queue.run_id in (select run_id from target_run_ids)
      returning 1
    ),
    deleted_events as (
      delete from workflow_events events
      where events.run_id in (select run_id from target_run_ids)
      returning 1
    ),
    deleted_run_states as (
      delete from workflow_run_states states
      where states.run_id in (select run_id from target_run_ids)
      returning 1
    ),
    deleted_run_documents as (
      delete from workflow_run_documents documents
      where documents.run_id in (select run_id from target_run_ids)
      returning 1
    ),
    deleted_deployments as (
      delete from workflow_deployments deployments
      where deployments.tenant_id = ${tenantId}
      returning 1
    )
    select
      (select count(*) from deleted_deployments)::int as "workflowDeployments",
      (select count(*) from deleted_run_documents)::int as "workflowRunDocuments",
      (select count(*) from deleted_run_states)::int as "workflowRunStates",
      (select count(*) from deleted_events)::int as "workflowEvents",
      (select count(*) from deleted_queue_items)::int as "workflowQueueItems",
      (select count(*) from deleted_oauth_pending)::int as "oauthPending",
      (select count(*) from deleted_oauth_handoffs)::int as "oauthHandoffs",
      (select count(*) from deleted_refresh_tokens)::int as "oauthRefreshTokens",
      (select count(*) from deleted_provider_installations)::int as "providerInstallations"
  `)) as Array<DeletePostgresTenantDataResult["deleted"]>;

  return {
    tenantId,
    deleted: rows[0] ?? emptyDeletedCounts,
  };
}

function asDb(db: WorkflowPostgresDb) {
  return db as never as {
    execute: (query: unknown) => Promise<unknown[]>;
  };
}
