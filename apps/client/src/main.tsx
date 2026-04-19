import { RouterProvider } from "@tanstack/react-router";
import { WorkflowFrontendRoot } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import bugTriageRaw from "./workflows/bug-triage.ts?raw";
import contentCalendarRaw from "./workflows/content-calendar.ts?raw";
import customerSupportRaw from "./workflows/customer-support.ts?raw";
import dataQualityRaw from "./workflows/data-quality.ts?raw";
import employeeOnboardingRaw from "./workflows/employee-onboarding.ts?raw";
import featureLaunchRaw from "./workflows/feature-launch.ts?raw";
import incidentResponseRaw from "./workflows/incident-response.ts?raw";
import invoiceApprovalRaw from "./workflows/invoice-approval.ts?raw";
import procurementRequestRaw from "./workflows/procurement-request.ts?raw";
import salesLeadRaw from "./workflows/sales-lead.ts?raw";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <WorkflowFrontendRoot
    config={{
      apiBaseUrl: import.meta.env.VITE_BACKEND_URL ?? "/api",
      apiMode: "multi",
      defaultWorkflows: [
        {
          source: customerSupportRaw,
          workflowId: "customer-support",
          name: "Customer Support",
        },
        {
          source: incidentResponseRaw,
          workflowId: "incident-response",
          name: "Incident Response",
        },
        {
          source: salesLeadRaw,
          workflowId: "sales-lead",
          name: "Sales Lead",
        },
        {
          source: contentCalendarRaw,
          workflowId: "content-calendar",
          name: "Content Calendar",
        },
        {
          source: invoiceApprovalRaw,
          workflowId: "invoice-approval",
          name: "Invoice Approval",
        },
        {
          source: employeeOnboardingRaw,
          workflowId: "employee-onboarding",
          name: "Employee Onboarding",
        },
        {
          source: featureLaunchRaw,
          workflowId: "feature-launch",
          name: "Feature Launch",
        },
        {
          source: bugTriageRaw,
          workflowId: "bug-triage",
          name: "Bug Triage",
        },
        {
          source: procurementRequestRaw,
          workflowId: "procurement-request",
          name: "Procurement Request",
        },
        {
          source: dataQualityRaw,
          workflowId: "data-quality",
          name: "Data Quality",
        },
      ],
    }}
  >
    <RouterProvider router={router} />
  </WorkflowFrontendRoot>,
);
