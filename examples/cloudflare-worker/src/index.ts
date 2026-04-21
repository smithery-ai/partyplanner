import { getWorkflowApp } from "./workflow-app";

export interface Env {
  HYLO_BACKEND_URL?: string;
}

export default {
  fetch(request, env): Response | Promise<Response> {
    return getWorkflowApp({ backendApiUrl: env.HYLO_BACKEND_URL }).fetch(
      request,
    );
  },
} satisfies ExportedHandler<Env>;
