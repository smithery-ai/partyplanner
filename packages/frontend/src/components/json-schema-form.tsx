import type { ReactNode } from "react";
import { Input } from "../components/ui/input";
import { useIsRunning } from "../hooks/workflow-run";
import type { JsonSchema } from "../types";

type JsonSchemaObject = JsonSchema & {
  anyOf?: JsonSchema[];
  const?: unknown;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string;
};

export function defaultForJsonSchema(schema: JsonSchema): unknown {
  const s = schema as JsonSchemaObject;
  if ("default" in s) return s.default;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];

  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const first =
      s.anyOf.find((option) => option.type !== "null") ?? s.anyOf[0];
    return defaultForJsonSchema(first);
  }

  if (s.type === "object" || s.properties) {
    const value: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(s.properties ?? {})) {
      value[key] = defaultForJsonSchema(property);
    }
    return value;
  }

  if (s.type === "array") return [];
  if (s.type === "number" || s.type === "integer") return 0;
  if (s.type === "boolean") return false;
  if (s.type === "null") return null;
  return "";
}

export function sanitizeJsonSchemaValue(
  schema: JsonSchema,
  value: unknown,
): unknown {
  const s = schema as JsonSchemaObject;

  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const nonNull = s.anyOf.find((option) => option.type !== "null");
    return sanitizeJsonSchemaValue(nonNull ?? s.anyOf[0], value);
  }

  if (s.type === "object" || s.properties) {
    const source =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const result: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(s.properties ?? {})) {
      result[key] = sanitizeJsonSchemaValue(property, source[key]);
    }
    return result;
  }

  if (s.type === "array") {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || value.trim() === "") return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to server-side schema validation
    }
    return value;
  }

  if (s.type === "number" || s.type === "integer") {
    if (typeof value === "number") return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }

  if (s.type === "boolean") return Boolean(value);
  if (s.type === "null") return null;
  return value ?? defaultForJsonSchema(schema);
}

export function JsonSchemaForm({
  schema,
  value,
  onChange,
  idPrefix,
  secret,
  disabled,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  idPrefix: string;
  secret?: boolean;
  disabled?: boolean;
}) {
  return (
    <JsonSchemaField
      schema={schema}
      value={value ?? defaultForJsonSchema(schema)}
      onChange={onChange}
      path={idPrefix}
      secret={secret}
      disabledOverride={disabled}
    />
  );
}

function JsonSchemaField({
  schema,
  value,
  onChange,
  path,
  secret,
  optional,
  disabledOverride,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  path: string;
  secret?: boolean;
  optional?: boolean;
  disabledOverride?: boolean;
}) {
  const isRunning = useIsRunning();
  const disabled = disabledOverride ?? isRunning;
  const s = schema as JsonSchemaObject;
  const description =
    typeof s.description === "string" ? s.description : undefined;

  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const nonNull = s.anyOf.find((option) => option.type !== "null");
    return (
      <JsonSchemaField
        schema={nonNull ?? s.anyOf[0]}
        value={value}
        onChange={onChange}
        path={path}
        secret={secret}
        optional={s.anyOf.some((option) => option.type === "null") || optional}
        disabledOverride={disabledOverride}
      />
    );
  }

  if (s.type === "object" || s.properties) {
    const source =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : (defaultForJsonSchema(schema) as Record<string, unknown>);
    const required = new Set(s.required ?? []);
    return (
      <div className="space-y-3 rounded-md border border-border/80 bg-muted/20 p-3">
        {description ? (
          <p className="text-muted-foreground text-[11px] leading-snug">
            {description}
          </p>
        ) : null}
        {Object.entries(s.properties ?? {}).map(([key, property]) => (
          <JsonSchemaField
            key={key}
            schema={property}
            value={source[key]}
            onChange={(next) => onChange({ ...source, [key]: next })}
            path={`${path}.${key}`}
            secret={secret}
            optional={!required.has(key)}
            disabledOverride={disabledOverride}
          />
        ))}
      </div>
    );
  }

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const id = path;
    return (
      <FieldLabel id={id} label={fieldLabel(path)} optional={optional}>
        <select
          id={id}
          className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60"
          value={String(value ?? s.enum[0])}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        >
          {s.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </FieldLabel>
    );
  }

  if (s.type === "boolean") {
    const id = path;
    return (
      <label
        htmlFor={id}
        className="flex items-center gap-2 text-[11px] font-medium text-foreground"
      >
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span>
          {fieldLabel(path)}
          {optional ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              (optional)
            </span>
          ) : null}
        </span>
      </label>
    );
  }

  if (s.type === "array") {
    const id = path;
    return (
      <FieldLabel
        id={id}
        label={fieldLabel(path)}
        optional={optional}
        description={description}
      >
        <textarea
          id={id}
          className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2 py-1 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60"
          value={JSON.stringify(Array.isArray(value) ? value : [], null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              onChange(e.target.value);
            }
          }}
          disabled={disabled}
        />
      </FieldLabel>
    );
  }

  const id = path;
  return (
    <FieldLabel
      id={id}
      label={fieldLabel(path)}
      optional={optional}
      description={description}
    >
      <Input
        id={id}
        type={secret ? "password" : s.type === "number" ? "number" : undefined}
        className="h-8 font-mono text-xs"
        value={
          typeof value === "string" || typeof value === "number" ? value : ""
        }
        onChange={(e) =>
          onChange(
            s.type === "number" ? Number(e.target.value) : e.target.value,
          )
        }
        disabled={disabled}
      />
    </FieldLabel>
  );
}

function FieldLabel({
  id,
  label,
  optional,
  description,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-[11px] font-medium text-foreground"
      >
        {label}
        {optional ? (
          <span className="font-normal text-muted-foreground"> (optional)</span>
        ) : null}
      </label>
      {description ? (
        <p className="text-muted-foreground text-[11px] leading-snug">
          {description}
        </p>
      ) : null}
      {children}
    </div>
  );
}

function fieldLabel(path: string): string {
  return path.split(".").pop() ?? path;
}
