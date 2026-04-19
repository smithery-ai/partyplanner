import { atom, input } from "@workflow/core";
import { z } from "zod";

export const report = input(
  "report",
  z.object({
    title: z.string(),
    area: z.enum(["frontend", "backend", "infra", "docs"]).default("backend"),
    reproduces: z.boolean().default(false),
    affectedUsers: z.number().default(1),
    workaround: z.boolean().default(false),
  }),
  { description: "Bug report submitted by a user or teammate." },
);

export const maintainerReview = input.deferred(
  "maintainerReview",
  z.object({
    accepted: z.boolean(),
    milestone: z.string().optional(),
  }),
  { description: "Maintainer review for high-priority bugs." },
);

export const severity = atom(
  (get) => {
    const r = get(report);
    const affectedUsers = r.affectedUsers ?? 1;
    if (affectedUsers >= 100 && !r.workaround) return "p0";
    if (affectedUsers >= 10 || !r.reproduces) return "p1";
    return "p2";
  },
  { name: "severity" },
);

export const assignOwner = atom(
  (get) => {
    const r = get(report);
    return {
      area: r.area,
      team:
        r.area === "frontend"
          ? "web"
          : r.area === "infra"
            ? "platform"
            : r.area,
    };
  },
  { name: "assignOwner" },
);

export const scheduleFix = atom(
  (get) => {
    const sev = get(severity);
    if (sev === "p2") return get.skip("Bug can stay in backlog.");
    const review = get(maintainerReview);
    if (!review.accepted) return get.skip("Maintainer rejected the bug.");
    return {
      priority: sev,
      owner: get(assignOwner),
      milestone: review.milestone ?? "next-patch",
    };
  },
  { name: "scheduleFix" },
);
