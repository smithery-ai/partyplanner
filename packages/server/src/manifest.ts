import type { Registry } from "@workflow/core";
import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export type WorkflowInputManifest = {
  id: string;
  kind: "input" | "deferred_input";
  secret?: boolean;
  description?: string;
  schema: JsonSchema;
  resolved?: boolean;
  errorMessage?: string;
};

export type WorkflowManifest = {
  workflowId: string;
  organizationId?: string;
  version: string;
  codeHash?: string;
  name?: string;
  createdAt: number;
  inputs: WorkflowInputManifest[];
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
    })),
  };
}
