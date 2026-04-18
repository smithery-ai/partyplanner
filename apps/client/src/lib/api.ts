import { hc } from "hono/client"

import type {
  SubmitInputRequest,
  WorkflowSession,
} from "../../../server/src/contracts.ts"
import type { AppType } from "../../../server/src/rpc.ts"

const baseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (typeof window === "undefined" ? "http://localhost:3000" : window.location.origin)

const client = hc<AppType>(baseUrl)

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null

    throw new Error(payload?.error ?? `Request failed with status ${response.status}`)
  }

  return response.json() as Promise<T>
}

export async function loadWorkflowSession(): Promise<WorkflowSession> {
  const response = await client.api.session.$get()
  return parseResponse<WorkflowSession>(response)
}

export async function submitWorkflowInput(
  payload: SubmitInputRequest,
): Promise<WorkflowSession> {
  const response = await client.api.session.input.$post({
    json: payload,
  })

  return parseResponse<WorkflowSession>(response)
}

export async function resetWorkflowSession(): Promise<WorkflowSession> {
  const response = await client.api.session.reset.$post()
  return parseResponse<WorkflowSession>(response)
}
