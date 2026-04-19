import { atom, input } from "@workflow/core";
import { z } from "zod";

export const hire = input(
  "hire",
  z.object({
    name: z.string(),
    role: z.string(),
    department: z.string(),
    startDate: z.string(),
    needsHardware: z.boolean().default(true),
  }),
  { description: "New hire onboarding request." },
);

export const managerChecklist = input.deferred(
  "managerChecklist",
  z.object({
    buddy: z.string(),
    firstProject: z.string(),
    approved: z.boolean(),
  }),
  { description: "Manager onboarding plan." },
);

export const createAccounts = atom(
  (get) => {
    const h = get(hire);
    return {
      email: `${h.name.toLowerCase().replace(" ", ".")}@example.com`,
      groups: [h.department, "all-hands"],
      role: h.role,
    };
  },
  { name: "createAccounts" },
);

export const shipHardware = atom(
  (get) => {
    const h = get(hire);
    if (!h.needsHardware) return get.skip("Hardware is not required.");
    return {
      recipient: h.name,
      kit: h.department === "Engineering" ? "developer-kit" : "standard-kit",
      shipBy: h.startDate,
    };
  },
  { name: "shipHardware" },
);

export const scheduleOrientation = atom(
  (get) => {
    const h = get(hire);
    const checklist = get(managerChecklist);
    if (!checklist.approved) return get.skip("Manager checklist not approved.");
    return {
      employee: h.name,
      buddy: checklist.buddy,
      firstProject: checklist.firstProject,
      accounts: get(createAccounts),
      hardware: get.maybe(shipHardware),
    };
  },
  { name: "scheduleOrientation" },
);
