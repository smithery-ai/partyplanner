import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

export const brief = input(
  "brief",
  z.object({
    title: z.string(),
    channel: z.enum(["blog", "newsletter", "social"]).default("blog"),
    audience: z.string().default("developers"),
    launchWeek: z.string().describe("Target launch week."),
    needsLegal: z.boolean().default(false),
  }),
  { description: "Content request brief." },
);

export const legalReview = input.deferred(
  "legalReview",
  z.object({
    approved: z.boolean(),
    caveats: z.array(z.string()).optional(),
  }),
  { description: "Legal review for sensitive content." },
);

export const cmsApiKey = secret("CMS_API_KEY", {
  description: "CMS API key used to schedule approved content.",
});

export const draftOutline = atom(
  (get) => {
    const b = get(brief);
    return {
      title: b.title,
      sections: ["problem", "approach", "example", "next steps"],
      audience: b.audience,
    };
  },
  { name: "draftOutline" },
);

export const chooseFormat = atom(
  (get) => {
    const b = get(brief);
    if (b.channel === "social") return "short-thread";
    if (b.channel === "newsletter") return "editorial-note";
    return "long-form";
  },
  { name: "chooseFormat" },
);

export const approveLegal = atom(
  (get) => {
    const b = get(brief);
    if (!b.needsLegal) return get.skip("Legal review is not required.");
    const review = get(legalReview);
    if (!review.approved) return get.skip("Legal review blocked publishing.");
    return { approved: true, caveats: review.caveats ?? [] };
  },
  { name: "approveLegal" },
);

export const schedulePublish = atom(
  (get) => {
    const b = get(brief);
    const legal = get.maybe(approveLegal);
    if (b.needsLegal && !legal) return get.skip("Waiting on legal approval.");
    const cmsKey = get(cmsApiKey);
    return {
      title: b.title,
      format: get(chooseFormat),
      launchWeek: b.launchWeek,
      outline: get(draftOutline),
      credential: cmsKey.length > 0 ? "CMS_API_KEY" : undefined,
    };
  },
  { name: "schedulePublish" },
);
