import { input, atom } from "@rxwf/core"
import { z } from "zod"

// ── Inputs ────────────────────────────────────────────────────

export const article = input(
  "article",
  z.object({
    title: z.string().default("Getting Started with RxWF").describe("Article title."),
    author: z.string().default("engineering@acme.dev").describe("Author email."),
    category: z.enum(["blog", "docs", "changelog"]).default("blog").describe("Content type."),
    draft: z.string().default("# Hello World\n\nThis is the article body.").describe("Markdown content."),
  }),
  { description: "Article draft to publish." },
)

export const editorialReview = input.deferred(
  "editorialReview",
  z.object({
    approved: z.boolean().describe("Whether the editor approves the content."),
    feedback: z.string().optional().describe("Editor feedback or revision notes."),
  }),
  { description: "Editorial review gate before publishing." },
)

export const legalReview = input.deferred(
  "legalReview",
  z.object({
    cleared: z.boolean().describe("Whether legal has cleared the content."),
    redactions: z.array(z.string()).optional().describe("Sections that must be removed."),
  }),
  { description: "Legal clearance for external-facing content." },
)

// ── Parse & Validate ─────────────────────────────────────────

export const validateContent = atom((get) => {
  const a = get(article)
  const wordCount = (a.draft ?? "").split(/\s+/).length
  return { action: "validate", title: a.title, wordCount, valid: wordCount > 5 }
}, { name: "validateContent" })

// ── Generate Assets ──────────────────────────────────────────

export const generateOgImage = atom((get) => {
  const a = get(article)
  get(validateContent)
  return { action: "generate-og-image", title: a.title, category: a.category }
}, { name: "generateOgImage" })

export const generateSlug = atom((get) => {
  const a = get(article)
  get(validateContent)
  const slug = (a.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
  return { action: "generate-slug", slug }
}, { name: "generateSlug" })

// ── Legal Check ──────────────────────────────────────────────

export const legalGate = atom((get) => {
  const a = get(article)
  if (a.category !== "blog") return get.skip()
  get(validateContent)
  const review = get(legalReview)
  if (!review.cleared) return get.skip()
  return { action: "legal-cleared", redactions: review.redactions ?? [] }
}, { name: "legalGate" })

// ── Editorial Review ─────────────────────────────────────────

export const editorialGate = atom((get) => {
  get(validateContent)
  const review = get(editorialReview)
  if (!review.approved) return get.skip()
  return { action: "editorial-approved", feedback: review.feedback }
}, { name: "editorialGate" })

// ── Publish ──────────────────────────────────────────────────

export const publish = atom((get) => {
  const a = get(article)
  get(editorialGate)
  const slug = get(generateSlug)
  get(generateOgImage)

  // Legal gate only required for blog posts
  if (a.category === "blog") get(legalGate)

  return { action: "publish", slug: slug.slug, category: a.category }
}, { name: "publish" })

// ── Distribute ───────────────────────────────────────────────

export const distribute = atom((get) => {
  const published = get(publish)
  return { action: "distribute", channels: ["twitter", "newsletter", "slack"], slug: published.slug }
}, { name: "distribute" })
