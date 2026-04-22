import { createRuntime } from "@workflow/core";
import type {
  ExecuteRequest,
  ExecuteResult,
  Executor,
  RuntimeAtomValueStore,
  SecretResolver,
} from "./types";

export type RuntimeExecutorOptions = {
  secretResolver?: SecretResolver;
  atomValueStore?: RuntimeAtomValueStore;
};

export class RuntimeExecutor implements Executor {
  private readonly secretResolver?: SecretResolver;
  private readonly atomValueStore?: RuntimeAtomValueStore;

  constructor(options?: SecretResolver | RuntimeExecutorOptions) {
    if (options && "resolve" in options) {
      this.secretResolver = options;
    } else {
      this.secretResolver = options?.secretResolver;
      this.atomValueStore = options?.atomValueStore;
    }
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const runtime = createRuntime({
      registry: request.registry,
      secretValues: await this.resolveSecrets(request),
      ...(this.atomValueStore
        ? {
            atomPersistence: {
              context: {
                workflowId: request.workflow.workflowId,
                workflowVersion: request.workflow.version,
                workflowCodeHash: request.workflow.codeHash,
                organizationId: request.workflow.organizationId,
                userId: request.workflow.userId,
              },
              store: this.atomValueStore,
            },
          }
        : {}),
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
