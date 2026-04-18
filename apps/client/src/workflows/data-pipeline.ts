import { input, atom } from "@rxwf/core"
import { z } from "zod"

// ── Inputs ────────────────────────────────────────────────────

export const pipelineConfig = input(
  "pipelineConfig",
  z.object({
    source: z.enum(["s3", "postgres", "api"]).default("s3").describe("Data source type."),
    sourceUri: z.string().default("s3://data-lake/raw/events/").describe("URI of the data source."),
    targetTable: z.string().default("analytics.events_processed").describe("Destination table."),
    partitionKey: z.string().default("event_date").describe("Column used for partitioning."),
    dryRun: z.boolean().default(false).describe("Run validation only without writing."),
  }),
  { description: "Configuration for the ETL pipeline run." },
)

export const dataQualityOverride = input.deferred(
  "dataQualityOverride",
  z.object({
    proceed: z.boolean().describe("Whether to proceed despite quality warnings."),
    reason: z.string().describe("Justification for overriding quality checks."),
  }),
  { description: "Manual override when data quality checks flag issues." },
)

// ── Extract ──────────────────────────────────────────────────

export const extract = atom((get) => {
  const config = get(pipelineConfig)
  return { action: "extract", source: config.source, uri: config.sourceUri, rowsExtracted: 150000 }
}, { name: "extract" })

// ── Schema Validation ────────────────────────────────────────

export const validateSchema = atom((get) => {
  const extracted = get(extract)
  return { action: "validate-schema", rowsChecked: extracted.rowsExtracted, valid: true }
}, { name: "validateSchema" })

// ── Data Quality Checks ─────────────────────────────────────

export const qualityChecks = atom((get) => {
  get(validateSchema)
  const extracted = get(extract)
  const nullRate = 0.02
  const duplicateRate = 0.001
  const hasWarnings = nullRate > 0.05 || duplicateRate > 0.01
  if (hasWarnings) {
    const override = get(dataQualityOverride)
    if (!override.proceed) return get.skip()
  }
  return { action: "quality-checks", nullRate, duplicateRate, rows: extracted.rowsExtracted, passed: true }
}, { name: "qualityChecks" })

// ── Transform ────────────────────────────────────────────────

export const transform = atom((get) => {
  get(qualityChecks)
  const config = get(pipelineConfig)
  const extracted = get(extract)
  return {
    action: "transform",
    partitionKey: config.partitionKey,
    rowsTransformed: extracted.rowsExtracted,
  }
}, { name: "transform" })

// ── Deduplicate ──────────────────────────────────────────────

export const deduplicate = atom((get) => {
  const transformed = get(transform)
  return {
    action: "deduplicate",
    rowsBefore: transformed.rowsTransformed,
    rowsAfter: transformed.rowsTransformed - 150,
  }
}, { name: "deduplicate" })

// ── Load ─────────────────────────────────────────────────────

export const load = atom((get) => {
  const config = get(pipelineConfig)
  if (config.dryRun) return get.skip()
  const deduped = get(deduplicate)
  return { action: "load", target: config.targetTable, rowsLoaded: deduped.rowsAfter }
}, { name: "load" })

// ── Update Catalog ───────────────────────────────────────────

export const updateCatalog = atom((get) => {
  const loaded = get(load)
  const config = get(pipelineConfig)
  return { action: "update-catalog", table: config.targetTable, rows: loaded.rowsLoaded }
}, { name: "updateCatalog" })

// ── Notify ───────────────────────────────────────────────────

export const notifyComplete = atom((get) => {
  const config = get(pipelineConfig)
  if (config.dryRun) {
    get(deduplicate)
    return { action: "notify", status: "dry-run-complete", target: config.targetTable }
  }
  get(updateCatalog)
  return { action: "notify", status: "pipeline-complete", target: config.targetTable }
}, { name: "notifyComplete" })
