import { hc } from "hono/client"

import type {
  ProcessRequest,
  ProcessResponse,
  RunDetailResponse,
  RunListResponse,
  WorkflowFile,
  WorkflowFileList,
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

export async function fetchWorkflowFiles(): Promise<WorkflowFileList> {
  const response = await client.api.workflows.$get()
  return parseResponse<WorkflowFileList>(response)
}

export async function fetchWorkflowCode(filename: string): Promise<WorkflowFile> {
  const response = await client.api.workflows[":filename"].$get({
    param: { filename },
  })
  return parseResponse<WorkflowFile>(response)
}

export async function saveWorkflowCode(
  filename: string,
  code: string,
): Promise<WorkflowFile> {
  const response = await client.api.workflows[":filename"].$put({
    param: { filename },
    json: { code },
  })
  return parseResponse<WorkflowFile>(response)
}

export async function processWorkflow(
  filename: string,
  request: ProcessRequest,
): Promise<ProcessResponse> {
  const response = await client.api.workflows[":filename"].process.$post({
    param: { filename },
    json: request,
  })
  return parseResponse<ProcessResponse>(response)
}

export async function fetchRuns(filename: string): Promise<RunListResponse> {
  const response = await client.api.workflows[":filename"].runs.$get({
    param: { filename },
  })
  return parseResponse<RunListResponse>(response)
}

export async function fetchRunState(
  filename: string,
  runId: string,
): Promise<RunDetailResponse> {
  const response = await client.api.workflows[":filename"].runs[":runId"].$get({
    param: { filename, runId },
  })
  return parseResponse<RunDetailResponse>(response)
}
