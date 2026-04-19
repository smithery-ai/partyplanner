import { useNavigate, useParams } from "@tanstack/react-router";
import {
  SecretVaultApp,
  WorkflowIndexApp,
  type WorkflowNavigation,
  WorkflowRunnerApp,
} from "@workflow/frontend";

function useWorkflowNavigation(): WorkflowNavigation {
  const navigate = useNavigate();

  return {
    home: () => void navigate({ to: "/" }),
    vault: () => void navigate({ to: "/vault" }),
    workflow: (workflowId, options) =>
      void navigate({
        to: "/workflows/$workflowId",
        params: { workflowId },
        replace: options?.replace,
      }),
    run: (workflowId, runId) =>
      void navigate({
        to: "/workflows/$workflowId/runs/$runId",
        params: { workflowId, runId },
      }),
  };
}

export function IndexApp() {
  return <WorkflowIndexApp navigation={useWorkflowNavigation()} />;
}

export function VaultApp() {
  return <SecretVaultApp navigation={useWorkflowNavigation()} />;
}

export function WorkflowApp() {
  const { workflowId } = useParams({ from: "/workflows/$workflowId" });
  return (
    <WorkflowRunnerApp
      workflowId={workflowId}
      navigation={useWorkflowNavigation()}
    />
  );
}

export function RunApp() {
  const { workflowId, runId } = useParams({
    from: "/workflows/$workflowId/runs/$runId",
  });
  return (
    <WorkflowRunnerApp
      workflowId={workflowId}
      runId={runId}
      navigation={useWorkflowNavigation()}
    />
  );
}
