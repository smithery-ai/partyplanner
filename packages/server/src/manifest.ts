import type { ManagedConnectionRequirement, Registry } from "@workflow/core";
import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export type WorkflowInputManifest = {
  id: string;
  kind: "input" | "deferred_input";
  title?: string;
  secret?: boolean;
  description?: string;
  schema: JsonSchema;
  resolved?: boolean;
  errorMessage?: string;
  internal?: boolean;
};

export type WorkflowStepManifest = {
  id: string;
  kind: "atom" | "action";
  description?: string;
  internal?: boolean;
};

export type WorkflowManagedConnectionManifest = {
  id: string;
  kind: "oauth";
  providerId: string;
  requirement: ManagedConnectionRequirement;
  title?: string;
  description?: string;
  scopes?: string[];
  internal?: boolean;
};

export type WorkflowScheduleManifest = {
  id: string;
  cron: string;
  inputId: string;
  description?: string;
};

export type WorkflowManifest = {
  workflowId: string;
  organizationId?: string;
  version: string;
  codeHash?: string;
  name?: string;
  createdAt: number;
  inputs: WorkflowInputManifest[];
  managedConnections: WorkflowManagedConnectionManifest[];
  atoms: WorkflowStepManifest[];
  actions: WorkflowStepManifest[];
  schedules: WorkflowScheduleManifest[];
};

export function buildWorkflowManifest(args: {
  workflowId: string;
  organizationId?: string;
  version: string;
  codeHash?: string;
  name?: string;
  createdAt: number;
  registry: Registry;
}): WorkflowManifest {
  return {
    workflowId: args.workflowId,
    organizationId: args.organizationId,
    version: args.version,
    codeHash: args.codeHash,
    name: args.name,
    createdAt: args.createdAt,
    inputs: args.registry.allInputs().map((input) => ({
      id: input.id,
      kind: input.kind,
      title: input.title,
      secret: input.secret,
      description: input.description,
      schema: z.toJSONSchema(input.schema),
      ...(input.secret
        ? {
            resolved:
              typeof input.secretValue === "string" &&
              input.secretValue.length > 0,
            errorMessage: input.errorMessage,
          }
        : {}),
      ...(input.internal ? { internal: true } : {}),
    })),
    managedConnections: args.registry.allAtoms().flatMap((atom) =>
      atom.managedConnection
        ? [
            {
              id: atom.id,
              kind: atom.managedConnection.kind,
              providerId: atom.managedConnection.providerId,
              requirement: atom.managedConnection.requirement,
              title: atom.managedConnection.title,
              description: atom.description,
              scopes: atom.managedConnection.scopes,
              ...(atom.internal ? { internal: true } : {}),
            },
          ]
        : [],
    ),
    atoms: args.registry.allAtoms().map((a) => ({
      id: a.id,
      kind: "atom",
      description: a.description,
      ...(a.internal ? { internal: true } : {}),
    })),
    actions: args.registry.allActions().map((a) => ({
      id: a.id,
      kind: "action",
      description: a.description,
      ...(a.internal ? { internal: true } : {}),
    })),
    schedules: args.registry.allSchedules().map((s) => ({
      id: s.id,
      cron: s.cron,
      inputId: s.inputId,
      description: s.description,
    })),
  };
}
