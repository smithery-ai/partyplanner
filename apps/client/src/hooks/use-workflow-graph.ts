import { useMutation } from "@tanstack/react-query";
import { hc } from "hono/client";

import type {
  AppType,
  GraphRequest,
  GraphResponse,
} from "../../../backend/src/rpc";

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "";
const client = hc<AppType>(backendUrl);

export function useWorkflowGraphMutation() {
  return useMutation<GraphResponse, Error, GraphRequest>({
    mutationFn: async (json) => {
      const response = await client.graph.$post({ json });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Graph request failed: ${response.status}`);
      }
      return response.json();
    },
  });
}
