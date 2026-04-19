import { createRuntime } from "@workflow/core";
import type { ExecuteRequest, ExecuteResult, Executor } from "./types";

export class RuntimeExecutor implements Executor {
  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const runtime = createRuntime({
      registry: request.registry,
    });
    return runtime.process(request.event, structuredClone(request.state));
  }
}
