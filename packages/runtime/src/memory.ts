import type {
  AtomPersistenceKey,
  QueueEvent,
  RunState,
  StoredAtomValue,
} from "@workflow/core";
import type {
  EventSink,
  InspectableWorkQueue,
  QueueItem,
  QueueSnapshot,
  RunEvent,
  RuntimeAtomValueStore,
  SaveResult,
  StateStore,
  StoredRunState,
  WorkflowDefinition,
  WorkflowLoader,
  WorkflowRef,
} from "./types";

export class MemoryStateStore implements StateStore, RuntimeAtomValueStore {
  private readonly runs = new Map<string, StoredRunState>();
  private readonly atomValues = new Map<string, StoredAtomValue>();

  async load(runId: string): Promise<StoredRunState | undefined> {
    const stored = this.runs.get(runId);
    if (!stored) return undefined;
    return {
      version: stored.version,
      state: structuredClone(stored.state),
    };
  }

  async save(
    runId: string,
    state: RunState,
    expectedVersion?: number,
  ): Promise<SaveResult> {
    const current = this.runs.get(runId);
    if (
      expectedVersion !== undefined &&
      current &&
      current.version !== expectedVersion
    ) {
      return { ok: false, reason: "conflict" };
    }
    if (expectedVersion !== undefined && !current && expectedVersion !== 0) {
      return { ok: false, reason: "missing" };
    }

    const version = (current?.version ?? 0) + 1;
    this.runs.set(runId, {
      version,
      state: structuredClone(state),
    });
    return { ok: true, version };
  }

  async loadAtomValue(
    key: AtomPersistenceKey,
  ): Promise<StoredAtomValue | undefined> {
    const stored = this.atomValues.get(atomValueKey(key));
    return stored ? structuredClone(stored) : undefined;
  }

  async saveAtomValue(
    key: AtomPersistenceKey,
    value: Omit<StoredAtomValue, "createdAt" | "updatedAt">,
  ): Promise<void> {
    const cacheKey = atomValueKey(key);
    const current = this.atomValues.get(cacheKey);
    const now = Date.now();
    this.atomValues.set(cacheKey, {
      ...structuredClone(value),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

export class MemoryWorkQueue implements InspectableWorkQueue {
  private readonly items: QueueItem[] = [];

  async enqueue(event: QueueEvent): Promise<void> {
    this.items.push({
      event: structuredClone(event),
      status: "pending",
      enqueuedAt: Date.now(),
    });
  }

  async enqueueMany(events: QueueEvent[]): Promise<void> {
    for (const event of events) {
      await this.enqueue(event);
    }
  }

  async dequeue(): Promise<QueueItem | undefined> {
    const item = this.items.find((candidate) => candidate.status === "pending");
    if (!item) return undefined;
    item.status = "running";
    item.startedAt = Date.now();
    return structuredClone(item);
  }

  async complete(eventId: string): Promise<void> {
    const item = this.items.find(
      (candidate) => candidate.event.eventId === eventId,
    );
    if (!item) return;
    item.status = "completed";
    item.finishedAt = Date.now();
  }

  async fail(eventId: string, error: Error): Promise<void> {
    const item = this.items.find(
      (candidate) => candidate.event.eventId === eventId,
    );
    if (!item) return;
    item.status = "failed";
    item.finishedAt = Date.now();
    item.error = error.message;
  }

  async snapshot(): Promise<QueueSnapshot> {
    const clone = this.items.map((item) => structuredClone(item));
    return {
      pending: clone.filter((item) => item.status === "pending"),
      running: clone.filter((item) => item.status === "running"),
      completed: clone.filter((item) => item.status === "completed"),
      failed: clone.filter((item) => item.status === "failed"),
    };
  }

  async size(): Promise<number> {
    return this.items.filter((item) => item.status === "pending").length;
  }
}

export class MemoryEventSink implements EventSink {
  readonly events: RunEvent[] = [];

  async publish(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async publishMany(events: RunEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }
}

export class StaticWorkflowLoader implements WorkflowLoader {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  constructor(definitions: WorkflowDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: WorkflowDefinition): void {
    this.definitions.set(workflowKey(definition.ref), definition);
  }

  async load(ref: WorkflowRef): Promise<WorkflowDefinition> {
    const definition = this.definitions.get(workflowKey(ref));
    if (!definition) {
      throw new Error(`Unknown workflow: ${workflowKey(ref)}`);
    }
    return definition;
  }
}

function workflowKey(ref: WorkflowRef): string {
  return `${ref.workflowId}@${ref.version}${ref.codeHash ? `#${ref.codeHash}` : ""}`;
}

function atomValueKey(key: AtomPersistenceKey): string {
  return JSON.stringify([
    key.workflowId,
    key.workflowVersion,
    key.workflowCodeHash ?? "",
    key.atomId,
    key.scope,
    key.scopeId,
  ]);
}
