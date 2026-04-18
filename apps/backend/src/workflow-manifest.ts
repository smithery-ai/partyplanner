import type { Registry } from "@rxwf/core";
import { type ZodTypeAny, z } from "zod";

export type JsonSchema = Record<string, unknown>;

export type WorkflowInputManifest = {
  id: string;
  kind: "input" | "deferred_input";
  description?: string;
  schema: JsonSchema;
};

export type WorkflowManifest = {
  workflowId: string;
  version: string;
  codeHash?: string;
  name?: string;
  createdAt: number;
  inputs: WorkflowInputManifest[];
};

export function buildWorkflowManifest(args: {
  workflowId: string;
  version: string;
  codeHash?: string;
  name?: string;
  createdAt: number;
  registry: Registry;
}): WorkflowManifest {
  return {
    workflowId: args.workflowId,
    version: args.version,
    codeHash: args.codeHash,
    name: args.name,
    createdAt: args.createdAt,
    inputs: args.registry.allInputs().map((input) => ({
      id: input.id,
      kind: input.kind,
      description: input.description,
      schema: zodToJsonSchema(input.schema as ZodTypeAny),
    })),
  };
}

function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const description = descriptionForSchema(schema);
  const json = zodToJsonSchemaInner(schema);
  if (description) json.description = description;
  return json;
}

function zodToJsonSchemaInner(schema: ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodEffects) {
    return zodToJsonSchema(schema.innerType());
  }

  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap() as ZodTypeAny);
  }

  if (schema instanceof z.ZodNullable) {
    return {
      anyOf: [zodToJsonSchema(schema.unwrap() as ZodTypeAny), { type: "null" }],
    };
  }

  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema._def.innerType as ZodTypeAny);
    const defaultValue = readDefaultValue(schema);
    if (defaultValue !== undefined) inner.default = defaultValue;
    return inner;
  }

  if (schema instanceof z.ZodObject) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, child] of Object.entries(schema.shape)) {
      const childSchema = child as ZodTypeAny;
      properties[key] = zodToJsonSchema(childSchema);
      if (!isOptionalProperty(childSchema)) required.push(key);
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodToJsonSchema(schema.element as ZodTypeAny),
    };
  }

  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBigInt) return { type: "integer" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodNull) return { type: "null" };
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) return {};

  if (schema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: [...schema.options],
    };
  }

  if (schema instanceof z.ZodLiteral) {
    const literal = schema.value;
    return {
      const: literal,
      type: literal === null ? "null" : typeof literal,
    };
  }

  if (schema instanceof z.ZodUnion) {
    return {
      anyOf: (schema.options as readonly ZodTypeAny[]).map((option) =>
        zodToJsonSchema(option as ZodTypeAny),
      ),
    };
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    return {
      anyOf: [...schema.options.values()].map((option) =>
        zodToJsonSchema(option as ZodTypeAny),
      ),
    };
  }

  return {};
}

function descriptionForSchema(schema: ZodTypeAny): string | undefined {
  const direct = readDirectDescription(schema);
  if (schema instanceof z.ZodEffects) {
    return direct ?? descriptionForSchema(schema.innerType());
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return direct ?? descriptionForSchema(schema.unwrap() as ZodTypeAny);
  }
  if (schema instanceof z.ZodDefault) {
    return direct ?? descriptionForSchema(schema._def.innerType as ZodTypeAny);
  }
  return direct;
}

function readDirectDescription(schema: ZodTypeAny): string | undefined {
  const publicDescription = (schema as { description?: string }).description;
  if (typeof publicDescription === "string" && publicDescription.length > 0) {
    return publicDescription;
  }

  const defDescription = (schema._def as { description?: string }).description;
  if (typeof defDescription === "string" && defDescription.length > 0) {
    return defDescription;
  }

  return undefined;
}

function isOptionalProperty(schema: ZodTypeAny): boolean {
  if (schema instanceof z.ZodEffects)
    return isOptionalProperty(schema.innerType());
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
}

function readDefaultValue(schema: z.ZodDefault<ZodTypeAny>): unknown {
  const defaultValue = schema._def.defaultValue;
  if (typeof defaultValue !== "function") return defaultValue;

  try {
    return defaultValue();
  } catch {
    return undefined;
  }
}
