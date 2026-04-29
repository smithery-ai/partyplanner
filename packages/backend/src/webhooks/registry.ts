import {
  providerInstallations,
  type WorkflowPostgresDb,
} from "@workflow/postgres";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { isRecord, safeJsonParse } from "../utils";

export type ProviderInstallationRecord = {
  installationKey: string;
  providerId: string;
  // Informational: the deployment that owns this install. May be undefined
  // when we couldn't derive it from the runtime URL (e.g. dev subdomains).
  // Webhook routing uses runtimeHandoffUrl, not this field.
  deploymentId?: string;
  identity: Record<string, string>;
  // Standalone installs (e.g. "Add to Slack" with no workflow) leave this
  // undefined. The webhook dispatcher logs incoming events as
  // "installation_unresolved" and 200s instead of forwarding.
  runtimeHandoffUrl?: string;
  createdAt: number;
  updatedAt: number;
};

export type ProviderInstallationLookup = {
  providerId: string;
  // Any of these `identity_json -> key = value` claims must match.
  anyOf: Record<string, string>;
  // All of these claims must additionally match (used for narrowing,
  // e.g. Slack's optional appId on top of team/enterprise identity).
  allOf?: Record<string, string>;
};

export type ProviderInstallationRegistry = {
  find(
    lookup: ProviderInstallationLookup,
  ): Promise<ProviderInstallationRecord | undefined>;
  upsert(
    installation: Omit<ProviderInstallationRecord, "createdAt" | "updatedAt">,
  ): Promise<void>;
  list(providerId: string): Promise<ProviderInstallationRecord[]>;
  deleteByKey(installationKey: string): Promise<boolean>;
};

export function createProviderInstallationRegistry(
  db: WorkflowPostgresDb,
): ProviderInstallationRegistry {
  return {
    async find(
      lookup: ProviderInstallationLookup,
    ): Promise<ProviderInstallationRecord | undefined> {
      const anyOfClauses = Object.entries(lookup.anyOf)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => identityEquals(key, value));
      if (anyOfClauses.length === 0) return undefined;

      const allOfClauses = Object.entries(lookup.allOf ?? {})
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => identityEquals(key, value));

      const conditions = [
        eq(providerInstallations.providerId, lookup.providerId),
        or(...anyOfClauses),
        ...allOfClauses,
      ];

      const rows = await asDb(db)
        .select()
        .from(providerInstallations)
        .where(and(...conditions))
        .orderBy(desc(providerInstallations.updatedAt))
        .limit(1);

      const row = (rows as ProviderInstallationRow[])[0];
      return row ? installationFromRow(row) : undefined;
    },

    async list(providerId: string): Promise<ProviderInstallationRecord[]> {
      const rows = await asDb(db)
        .select()
        .from(providerInstallations)
        .where(eq(providerInstallations.providerId, providerId))
        .orderBy(desc(providerInstallations.updatedAt))
        .limit(100);
      return (rows as ProviderInstallationRow[]).map(installationFromRow);
    },

    async deleteByKey(installationKey: string): Promise<boolean> {
      const rows = await asDb(db)
        .delete(providerInstallations)
        .where(eq(providerInstallations.installationKey, installationKey))
        .returning();
      return Array.isArray(rows) && rows.length > 0;
    },

    async upsert(
      installation: Omit<ProviderInstallationRecord, "createdAt" | "updatedAt">,
    ): Promise<void> {
      const now = Date.now();
      const identityJson = JSON.stringify(installation.identity);
      await asDb(db)
        .insert(providerInstallations)
        .values({
          installationKey: installation.installationKey,
          providerId: installation.providerId,
          deploymentId: installation.deploymentId ?? null,
          identityJson,
          runtimeHandoffUrl: installation.runtimeHandoffUrl ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: providerInstallations.installationKey,
          set: {
            providerId: installation.providerId,
            deploymentId: installation.deploymentId ?? null,
            identityJson,
            runtimeHandoffUrl: installation.runtimeHandoffUrl ?? null,
            updatedAt: now,
          },
        });
    },
  };
}

function identityEquals(key: string, value: string) {
  return sql`${providerInstallations.identityJson}::jsonb ->> ${key} = ${value}`;
}

function installationFromRow(
  row: ProviderInstallationRow,
): ProviderInstallationRecord {
  const identitySource = row.identityJson ?? row.identity_json ?? "{}";
  const parsed = safeJsonParse(identitySource);
  const identity: Record<string, string> = {};
  if (isRecord(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") identity[key] = value;
    }
  }
  const deploymentId = row.deploymentId ?? row.deployment_id ?? undefined;
  const runtimeHandoffUrl =
    row.runtimeHandoffUrl ?? row.runtime_handoff_url ?? undefined;
  return {
    installationKey: row.installationKey ?? row.installation_key ?? "",
    providerId: row.providerId ?? row.provider_id ?? "",
    ...(deploymentId ? { deploymentId } : {}),
    identity,
    ...(runtimeHandoffUrl ? { runtimeHandoffUrl } : {}),
    createdAt: row.createdAt ?? row.created_at ?? 0,
    updatedAt: row.updatedAt ?? row.updated_at ?? 0,
  };
}

type ProviderInstallationRow = {
  installationKey?: string;
  installation_key?: string;
  providerId?: string;
  provider_id?: string;
  deploymentId?: string | null;
  deployment_id?: string | null;
  identityJson?: string;
  identity_json?: string;
  runtimeHandoffUrl?: string;
  runtime_handoff_url?: string;
  createdAt?: number;
  created_at?: number;
  updatedAt?: number;
  updated_at?: number;
};

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
  orderBy(...columns: unknown[]): QueryBuilder;
  limit(limit: number): Promise<unknown[]>;
};

type InsertBuilder = {
  values(value: unknown): InsertBuilder;
  onConflictDoUpdate(args: unknown): Promise<unknown>;
};

type DeleteBuilder = {
  where(condition: unknown): {
    returning(): Promise<unknown[]>;
  };
};
