"use client";

import { WorkflowSinglePage } from "@workflow/frontend";
import "@/workflows";

export function WorkflowExamplePage() {
  return <WorkflowSinglePage apiBaseUrl="/api/workflow" />;
}
