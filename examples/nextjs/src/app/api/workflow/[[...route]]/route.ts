import { getWorkflowApp } from "../workflow-app";

export function GET(request: Request): Response | Promise<Response> {
  return getWorkflowApp(request).fetch(request);
}

export function POST(request: Request): Response | Promise<Response> {
  return getWorkflowApp(request).fetch(request);
}

export const runtime = "nodejs";
