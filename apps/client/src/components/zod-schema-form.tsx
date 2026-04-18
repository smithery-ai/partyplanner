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

function readDirectDescription(schema: ZodTypeAny): string | undefined {
  const pub = (schema as { description?: string }).description
  if (typeof pub === "string" && pub.length > 0) return pub
  const def = schema._def as { description?: string }
  if (typeof def.description === "string" && def.description.length > 0) return def.description
  return undefined
}

/**
 * Resolves `z.describe()` through common wrappers. Uses outer-first merge so chains like
 * `z.string().optional().describe("…")` work (description lives on the optional, not the inner string).
 */
export function descriptionForSchema(schema: ZodTypeAny): string | undefined {
  const own = readDirectDescription(schema)
  if (schema instanceof z.ZodEffects) {
    return own ?? descriptionForSchema(schema.innerType())
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return own ?? descriptionForSchema(schema.unwrap() as ZodTypeAny)
  }
  if (schema instanceof z.ZodDefault) {
    return own ?? descriptionForSchema(schema._def.innerType as ZodTypeAny)
  }
  return own
}

function fieldLabelText(path: string) {
  return path.split(".").pop() ?? path
}

function FieldLabelBlock({
  id,
  label,
  optional,
  description,
  children,
}: {
  id: string
  label: string
  optional?: boolean
  description?: string
  children: ReactNode
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
        <p className="text-muted-foreground text-[11px] leading-snug">{description}</p>
      ) : null}
      {children}
    </div>
  )
}

function ZodFieldInner({
  schema,
  value,
  onChange,
  path,
  optionalOuter,
  inheritedDescription,
}: {
  schema: ZodTypeAny
  value: unknown
  onChange: (v: unknown) => void
  path: string
  optionalOuter?: boolean
  /** Merged describe() from ancestor wrappers (optional/default/effects) before unwrapping. */
  inheritedDescription?: string
}) {
  const mergedFromThisWrapper = inheritedDescription ?? descriptionForSchema(schema)

  if (schema instanceof z.ZodEffects) {
    return (
      <ZodFieldInner
        schema={schema.innerType()}
        value={value}
        onChange={onChange}
        path={path}
        optionalOuter={optionalOuter}
        inheritedDescription={mergedFromThisWrapper}
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
        inheritedDescription={mergedFromThisWrapper}
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
        inheritedDescription={mergedFromThisWrapper}
      />
    )
  }

  if (schema instanceof z.ZodObject) {
    const objDesc = descriptionForSchema(schema)
    const obj = (value && typeof value === "object" ? value : defaultForSchema(schema)) as Record<
      string,
      unknown
    >
    return (
      <div className="space-y-3 rounded-md border border-border/80 bg-muted/20 p-3">
        {objDesc ? (
          <p className="text-muted-foreground text-[11px] leading-snug">{objDesc}</p>
        ) : null}
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
    const desc = mergedFromThisWrapper
    return (
      <FieldLabelBlock
        id={id}
        label={fieldLabelText(path)}
        optional={optionalOuter}
        description={desc}
      >
        <Input
          id={id}
          className="h-8 font-mono text-xs"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      </FieldLabelBlock>
    )
  }

  if (schema instanceof z.ZodNumber) {
    const id = path
    const desc = mergedFromThisWrapper
    return (
      <FieldLabelBlock
        id={id}
        label={fieldLabelText(path)}
        optional={optionalOuter}
        description={desc}
      >
        <Input
          id={id}
          type="number"
          className="h-8 font-mono text-xs"
          value={typeof value === "number" ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </FieldLabelBlock>
    )
  }

  if (schema instanceof z.ZodBoolean) {
    const id = path
    const desc = mergedFromThisWrapper
    const label = fieldLabelText(path)
    return (
      <div className="flex gap-2">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 rounded border border-input"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div className="min-w-0 space-y-1">
          <label
            htmlFor={id}
            className="block text-[11px] font-medium text-foreground"
          >
            {label}
            {optionalOuter ? (
              <span className="font-normal text-muted-foreground"> (optional)</span>
            ) : null}
          </label>
          {desc ? (
            <p className="text-muted-foreground text-[11px] leading-snug">{desc}</p>
          ) : null}
        </div>
      </div>
    )
  }

  if (schema instanceof z.ZodEnum) {
    const id = path
    const opts = schema.options as string[]
    const desc = mergedFromThisWrapper
    return (
      <FieldLabelBlock
        id={id}
        label={fieldLabelText(path)}
        optional={optionalOuter}
        description={desc}
      >
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
      </FieldLabelBlock>
    )
  }

  if (schema instanceof z.ZodArray) {
    const elSchema = schema.element as ZodTypeAny
    const arr = Array.isArray(value) ? value : []
    const arrDesc = mergedFromThisWrapper
    if (elSchema instanceof z.ZodString) {
      return (
        <FieldLabelBlock
          id={path}
          label={fieldLabelText(path)}
          optional={optionalOuter}
          description={arrDesc}
        >
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
        </FieldLabelBlock>
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
