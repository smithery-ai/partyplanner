import type { ReactNode } from "react"
import type { ZodTypeAny } from "zod"
import { z } from "zod"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** Default value suitable for controlled form state (Zod parse may still refine). */
export function defaultForSchema(schema: ZodTypeAny): unknown {
  // Refinements / transforms / preprocess — defaults live on the inner schema
  if (schema instanceof z.ZodEffects) {
    return defaultForSchema(schema.innerType())
  }
  if (schema instanceof z.ZodObject) {
    const o: Record<string, unknown> = {}
    for (const key of Object.keys(schema.shape)) {
      o[key] = defaultForSchema(schema.shape[key] as ZodTypeAny)
    }
    return o
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as ZodTypeAny
    const d = defaultForSchema(inner)
    return d
  }
  if (schema instanceof z.ZodDefault) {
    const defVal = schema._def.defaultValue
    if (typeof defVal === "function") {
      try {
        return defVal()
      } catch {
        return defaultForSchema(schema._def.innerType as ZodTypeAny)
      }
    }
    return defVal ?? defaultForSchema(schema._def.innerType as ZodTypeAny)
  }
  if (schema instanceof z.ZodString) return ""
  if (schema instanceof z.ZodNumber) return 0
  if (schema instanceof z.ZodBigInt) return BigInt(0)
  if (schema instanceof z.ZodBoolean) return false
  if (schema instanceof z.ZodEnum) return schema.options[0]
  if (schema instanceof z.ZodLiteral) return schema.value
  if (schema instanceof z.ZodArray) {
    return []
  }
  if (schema instanceof z.ZodUnion) {
    return defaultForSchema(schema.options[0] as ZodTypeAny)
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const first = [...schema.options.values()][0] as ZodTypeAny | undefined
    return first ? defaultForSchema(first) : null
  }
  return null
}

function FieldLabel({
  id,
  children,
  optional,
}: {
  id: string
  children: ReactNode
  optional?: boolean
}) {
  return (
    <label
      htmlFor={id}
      className="mb-1 block text-[11px] font-medium text-foreground"
    >
      {children}
      {optional ? (
        <span className="font-normal text-muted-foreground"> (optional)</span>
      ) : null}
    </label>
  )
}

function ZodFieldInner({
  schema,
  value,
  onChange,
  path,
  optionalOuter,
}: {
  schema: ZodTypeAny
  value: unknown
  onChange: (v: unknown) => void
  path: string
  optionalOuter?: boolean
}) {
  if (schema instanceof z.ZodEffects) {
    return (
      <ZodFieldInner
        schema={schema.innerType()}
        value={value}
        onChange={onChange}
        path={path}
        optionalOuter={optionalOuter}
      />
    )
  }

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as ZodTypeAny
    return (
      <ZodFieldInner
        schema={inner}
        value={value === undefined || value === null ? defaultForSchema(inner) : value}
        onChange={(v) => onChange(v)}
        path={path}
        optionalOuter={true}
      />
    )
  }

  if (schema instanceof z.ZodDefault) {
    const inner = schema._def.innerType as ZodTypeAny
    return (
      <ZodFieldInner
        schema={inner}
        value={value ?? defaultForSchema(schema)}
        onChange={onChange}
        path={path}
        optionalOuter={optionalOuter}
      />
    )
  }

  if (schema instanceof z.ZodObject) {
    const obj = (value && typeof value === "object" ? value : defaultForSchema(schema)) as Record<
      string,
      unknown
    >
    return (
      <div className="space-y-3 rounded-md border border-border/80 bg-muted/20 p-3">
        {Object.keys(schema.shape).map((key) => {
          const sub = schema.shape[key] as ZodTypeAny
          return (
            <div key={key}>
              <ZodFieldInner
                schema={sub}
                value={obj[key]}
                onChange={(v) => onChange({ ...obj, [key]: v })}
                path={`${path}.${key}`}
              />
            </div>
          )
        })}
      </div>
    )
  }

  if (schema instanceof z.ZodString) {
    const id = path
    return (
      <div>
        <FieldLabel id={id} optional={optionalOuter}>
          {path.split(".").pop()}
        </FieldLabel>
        <Input
          id={id}
          className="h-8 font-mono text-xs"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }

  if (schema instanceof z.ZodNumber) {
    const id = path
    return (
      <div>
        <FieldLabel id={id} optional={optionalOuter}>
          {path.split(".").pop()}
        </FieldLabel>
        <Input
          id={id}
          type="number"
          className="h-8 font-mono text-xs"
          value={typeof value === "number" ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    )
  }

  if (schema instanceof z.ZodBoolean) {
    const id = path
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          className="size-4 rounded border border-input"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <FieldLabel id={id} optional={optionalOuter}>
          {path.split(".").pop()}
        </FieldLabel>
      </div>
    )
  }

  if (schema instanceof z.ZodEnum) {
    const id = path
    const opts = schema.options as string[]
    return (
      <div>
        <FieldLabel id={id} optional={optionalOuter}>
          {path.split(".").pop()}
        </FieldLabel>
        <select
          id={id}
          className={cn(
            "flex h-8 w-full rounded-lg border border-input bg-background px-2 text-xs",
          )}
          value={typeof value === "string" ? value : opts[0]}
          onChange={(e) => onChange(e.target.value)}
        >
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (schema instanceof z.ZodArray) {
    const elSchema = schema.element as ZodTypeAny
    const arr = Array.isArray(value) ? value : []
    if (elSchema instanceof z.ZodString) {
      return (
        <div>
          <FieldLabel id={path} optional={optionalOuter}>
            {path.split(".").pop()}
          </FieldLabel>
          <div className="space-y-1.5">
            {arr.length === 0 ? (
              <p className="text-muted-foreground text-[11px]">No items</p>
            ) : null}
            {arr.map((item, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  className="h-8 flex-1 font-mono text-xs"
                  value={typeof item === "string" ? item : ""}
                  onChange={(e) => {
                    const next = [...arr]
                    next[i] = e.target.value
                    onChange(next)
                  }}
                />
                <button
                  type="button"
                  className="text-muted-foreground text-xs underline"
                  onClick={() => {
                    const next = arr.filter((_, j) => j !== i)
                    onChange(next)
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-primary text-xs underline"
              onClick={() => onChange([...arr, ""])}
            >
              Add item
            </button>
          </div>
        </div>
      )
    }
  }

  return (
    <div className="rounded border border-dashed border-border p-2 text-[11px] text-muted-foreground">
      Unsupported field <code className="text-foreground">{path}</code> — use raw JSON in the
      Payload tab or extend ZodSchemaForm.
    </div>
  )
}

export function ZodSchemaForm({
  schema,
  value,
  onChange,
  idPrefix = "field",
}: {
  schema: ZodTypeAny
  value: unknown
  onChange: (value: unknown) => void
  idPrefix?: string
}) {
  return (
    <ZodFieldInner
      schema={schema}
      value={value}
      onChange={onChange}
      path={idPrefix}
    />
  )
}
