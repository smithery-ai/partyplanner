import { EventEmitter } from "node:events";

export type RunDocument = {
  runId: string;
  status: string;
  queue?: { pending?: unknown[]; running?: unknown[] };
  [key: string]: unknown;
};

export type RunAdvancerEvents = {
  snapshot: [{ runId: string; document: RunDocument }];
  error: [{ runId: string; message: string }];
  stopped: [{ runId: string }];
};

interface ActiveLoop {
  controller: AbortController;
  workflowApiUrl: string;
}

export interface StartAdvanceOptions {
  workflowApiUrl: string;
  secretValues?: Record<string, string>;
  headers?: Record<string, string>;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "waiting"]);

export class RunAdvancer extends EventEmitter<RunAdvancerEvents> {
  private readonly loops = new Map<string, ActiveLoop>();

  start(runId: string, options: StartAdvanceOptions): { started: boolean } {
    if (this.loops.has(runId)) {
      return { started: false };
    }
    const controller = new AbortController();
    this.loops.set(runId, {
      controller,
      workflowApiUrl: options.workflowApiUrl,
    });
    void this.run(runId, options, controller.signal);
    return { started: true };
  }

  stop(runId: string): { stopped: boolean } {
    const loop = this.loops.get(runId);
    if (!loop) return { stopped: false };
    loop.controller.abort();
    this.loops.delete(runId);
    this.emit("stopped", { runId });
    return { stopped: true };
  }

  list(): string[] {
    return Array.from(this.loops.keys());
  }

  private async run(
    runId: string,
    options: StartAdvanceOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const advanceUrl = joinWorkflowUrl(
      options.workflowApiUrl,
      `/runs/${encodeURIComponent(runId)}/advance`,
    );
    const body = JSON.stringify({ secretValues: options.secretValues });

    try {
      while (!signal.aborted) {
        const res = await fetch(advanceUrl, {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body,
          signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`advance ${res.status}: ${text || res.statusText}`);
        }

        const document = (await res.json()) as RunDocument;
        if (signal.aborted) return;

        this.emit("snapshot", { runId, document });

        if (!shouldContinue(document)) return;
      }
    } catch (err) {
      if (signal.aborted) return;
      this.emit("error", {
        runId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const current = this.loops.get(runId);
      if (current && current.controller.signal === signal) {
        this.loops.delete(runId);
      }
    }
  }
}

function shouldContinue(document: RunDocument): boolean {
  if (TERMINAL_STATUSES.has(document.status)) return false;
  const pending = document.queue?.pending?.length ?? 0;
  const running = document.queue?.running?.length ?? 0;
  return pending + running > 0;
}

function joinWorkflowUrl(workflowApiUrl: string, path: string): string {
  const suffixIndex = workflowApiUrl.search(/[?#]/);
  if (suffixIndex !== -1) {
    const base = workflowApiUrl.slice(0, suffixIndex).replace(/\/+$/, "");
    const suffix = workflowApiUrl.slice(suffixIndex);
    return `${base}${path}${suffix}`;
  }
  return `${workflowApiUrl.replace(/\/+$/, "")}${path}`;
}
