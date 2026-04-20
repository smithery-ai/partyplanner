import { createRuntime } from "@workflow/core";
import type {
  ExecuteRequest,
  ExecuteResult,
  Executor,
  SecretResolver,
} from "./types";

export class RuntimeExecutor implements Executor {
  constructor(private readonly secretResolver?: SecretResolver) {}

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const runtime = createRuntime({
      registry: request.registry,
      secretValues: await this.resolveSecrets(request),
    });
    return runtime.process(request.event, structuredClone(request.state));
  }

  private async resolveSecrets(
    request: ExecuteRequest,
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const input of request.registry.allInputs()) {
      if (!input.secret) continue;
      if (
        typeof input.secretValue === "string" &&
        input.secretValue.length > 0
      ) {
        values[input.id] = input.secretValue;
        continue;
      }
      if (!this.secretResolver) continue;
      const value = await this.secretResolver.resolve({
        ...request,
        logicalName: input.id,
      });
      if (value !== undefined) values[input.id] = value;
    }
    return values;
  }
}
