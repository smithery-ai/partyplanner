import { atom, input } from "@workflow/core";
import { z } from "zod";

export const dataset = input(
  "dataset",
  z.object({
    name: z.string(),
    rowCount: z.number(),
    nullRate: z.number().describe("Percent of values that are null."),
    duplicateRate: z.number().describe("Percent of duplicate rows."),
    owner: z.string(),
  }),
  { description: "Dataset quality scan result." },
);

export const ownerDecision = input.deferred(
  "ownerDecision",
  z.object({
    accepted: z.boolean(),
    remediation: z.string().optional(),
  }),
  { description: "Dataset owner decision for failed quality checks." },
);

export const gradeDataset = atom(
  (get) => {
    const d = get(dataset);
    if (d.nullRate > 10 || d.duplicateRate > 5) return "fail";
    if (d.nullRate > 3 || d.duplicateRate > 1) return "warn";
    return "pass";
  },
  { name: "gradeDataset" },
);

export const publishReport = atom(
  (get) => {
    const d = get(dataset);
    return {
      dataset: d.name,
      owner: d.owner,
      grade: get(gradeDataset),
      sampleRows: Math.min(d.rowCount, 1000),
    };
  },
  { name: "publishReport" },
);

export const openRemediation = atom(
  (get) => {
    const grade = get(gradeDataset);
    if (grade === "pass") return get.skip("Dataset passed quality checks.");
    const decision = get(ownerDecision);
    if (!decision.accepted) return get.skip("Owner accepted the current risk.");
    const d = get(dataset);
    return {
      dataset: d.name,
      owner: d.owner,
      remediation: decision.remediation ?? "clean-and-rescan",
    };
  },
  { name: "openRemediation" },
);
