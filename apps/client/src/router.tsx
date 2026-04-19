import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { IndexApp, RunApp, WorkflowApp } from "./App";

const rootRoute = createRootRoute({
  component: Outlet,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexApp,
});

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$workflowId",
  component: WorkflowApp,
});

const workflowRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$workflowId/runs/$runId",
  component: RunApp,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  workflowRoute,
  workflowRunRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
