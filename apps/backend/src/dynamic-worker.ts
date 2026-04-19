import { Registry } from "@workflow/core";
import type {
  ExecuteRequest,
  ExecuteResult,
  Executor,
  SecretResolver,
} from "@workflow/runtime";
import type { WorkflowApiManifest } from "@workflow/server";
import { z } from "zod";

export type StoredWorkflowAtom = {
  id: string;
  description?: string;
};

export type StoredWorkflow = {
  workflowId: string;
  organizationId?: string;
  name?: string;
  source: string;
  manifest: WorkflowApiManifest;
  atoms: StoredWorkflowAtom[];
  createdAt: number;
};

type DynamicWorkflowDescription = {
  inputs: WorkflowApiManifest["inputs"];
  atoms: StoredWorkflowAtom[];
};

export type CreateStoredDynamicWorkflowRequest = {
  workflowId: string;
  organizationId?: string;
  name?: string;
  source: string;
};

export async function createStoredDynamicWorkflow(
  loader: WorkerLoader,
  request: CreateStoredDynamicWorkflowRequest,
): Promise<StoredWorkflow> {
  const codeHash = hashString(request.source);
  const worker = dynamicWorker(loader, request.workflowId, codeHash, () =>
    buildDynamicWorkerCode(request.source),
  );
  const description = await describeDynamicWorkflow(worker);
  const createdAt = Date.now();
  return {
    workflowId: request.workflowId,
    organizationId: request.organizationId,
    name: request.name,
    source: request.source,
    atoms: description.atoms,
    createdAt,
    manifest: {
      workflowId: request.workflowId,
      organizationId: request.organizationId,
      version: codeHash,
      codeHash,
      name: request.name,
      createdAt,
      inputs: description.inputs,
      source: request.source,
    },
  };
}

export class DynamicWorkerExecutor implements Executor {
  constructor(
    private readonly loader: WorkerLoader,
    private readonly loadWorkflow: (
      workflowId: string,
    ) => Promise<StoredWorkflow | undefined>,
    private readonly secretResolver?: SecretResolver,
  ) {}

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const workflow = await this.loadWorkflow(request.workflow.workflowId);
    if (!workflow) {
      throw new Error(`Unknown workflow: ${request.workflow.workflowId}`);
    }

    const worker = dynamicWorker(
      this.loader,
      workflow.workflowId,
      workflow.manifest.codeHash ?? workflow.manifest.version,
      () => buildDynamicWorkerCode(workflow.source),
    );
    const response = await worker
      .getEntrypoint()
      .fetch("https://workflow.internal/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: request.event,
          state: request.state,
          secretValues: await this.resolveSecrets(request),
        }),
      });
    if (!response.ok) throw new Error(await errorMessage(response));
    return (await response.json()) as ExecuteResult;
  }

  private async resolveSecrets(
    request: ExecuteRequest,
  ): Promise<Record<string, string>> {
    if (!this.secretResolver) return {};

    const values: Record<string, string> = {};
    for (const input of request.registry.allInputs()) {
      if (!input.secret) continue;
      const value = await this.secretResolver.resolve({
        ...request,
        logicalName: input.id,
      });
      if (value !== undefined) values[input.id] = value;
    }
    return values;
  }
}

export function registryFromStoredWorkflow(workflow: StoredWorkflow): Registry {
  const registry = new Registry();
  for (const input of workflow.manifest.inputs) {
    registry.registerInput({
      kind: input.kind,
      id: input.id,
      schema: z.any(),
      description: input.description,
      secret: input.secret,
    });
  }
  for (const atom of workflow.atoms) {
    registry.registerAtom({
      kind: "atom",
      id: atom.id,
      fn: () => {
        throw new Error("Dynamic workflow atoms execute in a Worker Loader.");
      },
      description: atom.description,
    });
  }
  return registry;
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function describeDynamicWorkflow(
  worker: WorkerStub,
): Promise<DynamicWorkflowDescription> {
  const response = await worker
    .getEntrypoint()
    .fetch("https://workflow.internal/describe", {
      method: "POST",
    });
  if (!response.ok) throw new Error(await errorMessage(response));
  return validateDescription(await response.json());
}

function dynamicWorker(
  loader: WorkerLoader,
  workflowId: string,
  codeHash: string,
  getCode: () => WorkerLoaderWorkerCode,
): WorkerStub {
  return loader.get(`workflow:${workflowId}:${codeHash}`, getCode);
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Dynamic Worker failed with ${response.status}`;
}

function validateDescription(value: unknown): DynamicWorkflowDescription {
  if (!value || typeof value !== "object") {
    throw new Error("Dynamic Worker returned an invalid workflow description.");
  }
  const body = value as {
    inputs?: unknown;
    atoms?: unknown;
  };
  if (!Array.isArray(body.inputs) || !Array.isArray(body.atoms)) {
    throw new Error(
      "Dynamic Worker returned an incomplete workflow description.",
    );
  }
  return {
    inputs: body.inputs.map((input) => validateInput(input)),
    atoms: body.atoms.map((atom) => validateAtom(atom)),
  };
}

function validateInput(value: unknown): WorkflowApiManifest["inputs"][number] {
  if (!value || typeof value !== "object") {
    throw new Error("Dynamic Worker returned an invalid input.");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string") {
    throw new Error("Dynamic Worker returned an input without an id.");
  }
  if (input.kind !== "input" && input.kind !== "deferred_input") {
    throw new Error(
      `Dynamic Worker returned invalid input kind for ${input.id}.`,
    );
  }
  return {
    id: input.id,
    kind: input.kind,
    secret: input.secret === true ? true : undefined,
    description:
      typeof input.description === "string" ? input.description : undefined,
    schema:
      input.schema && typeof input.schema === "object"
        ? (input.schema as Record<string, unknown>)
        : {},
  };
}

function validateAtom(value: unknown): StoredWorkflowAtom {
  if (!value || typeof value !== "object") {
    throw new Error("Dynamic Worker returned an invalid atom.");
  }
  const atom = value as Record<string, unknown>;
  if (typeof atom.id !== "string") {
    throw new Error("Dynamic Worker returned an atom without an id.");
  }
  return {
    id: atom.id,
    description:
      typeof atom.description === "string" ? atom.description : undefined,
  };
}

function buildDynamicWorkerCode(source: string): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: "2026-04-19",
    mainModule: "entry.js",
    modules: {
      "entry.js": { js: ENTRY_MODULE },
      "workflow-api.js": { js: WORKFLOW_API_MODULE },
      "workflow.js": { js: transformWorkflowSource(source) },
    },
  };
}

function transformWorkflowSource(source: string): string {
  const packagePattern = "(?:@workflow\\/core|zod|@hono\\/zod-openapi)";
  const body = source
    .replace(
      new RegExp(
        `^\\s*import\\s+(?:type\\s+)?[^;\\n]*\\s+from\\s+["']${packagePattern}["'];?\\s*$`,
        "gm",
      ),
      "",
    )
    .replace(
      new RegExp(
        `^\\s*import\\s+(?:type\\s+)?\\{[\\s\\S]*?\\}\\s+from\\s+["']${packagePattern}["'];?\\s*$`,
        "gm",
      ),
      "",
    );
  return `import { atom, input, secret, z } from "./workflow-api.js";\n${body}`;
}

const ENTRY_MODULE = `
import "./workflow.js";
import { createRuntime, describeRegistry, globalRegistry } from "./workflow-api.js";

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/describe") {
        return json(describeRegistry(globalRegistry));
      }
      if (url.pathname === "/execute") {
        const body = await request.json();
        const runtime = createRuntime({
          registry: globalRegistry,
          secretValues: body.secretValues || {}
        });
        return json(await runtime.process(body.event, body.state));
      }
      return json({ message: "Not found" }, 404);
    } catch (error) {
      return json({
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : undefined
      }, 500);
    }
  }
};
`;

const WORKFLOW_API_MODULE = `
class Registry {
  constructor() {
    this.inputs = new Map();
    this.atoms = new Map();
  }
  registerInput(def) {
    if (this.inputs.has(def.id) || this.atoms.has(def.id)) {
      throw new Error("Duplicate registry ID: " + def.id);
    }
    this.inputs.set(def.id, def);
  }
  registerAtom(def) {
    if (this.atoms.has(def.id) || this.inputs.has(def.id)) {
      throw new Error("Duplicate registry ID: " + def.id);
    }
    this.atoms.set(def.id, def);
  }
  getInput(id) {
    return this.inputs.get(id);
  }
  getAtom(id) {
    return this.atoms.get(id);
  }
  allInputs() {
    return Array.from(this.inputs.values());
  }
  allAtoms() {
    return Array.from(this.atoms.values());
  }
  allIds() {
    return Array.from(this.inputs.keys()).concat(Array.from(this.atoms.keys()));
  }
  clear() {
    this.inputs.clear();
    this.atoms.clear();
  }
}

export { Registry };
export const globalRegistry = new Registry();

function makeHandle(kind, id) {
  return { __workflowHandle: true, __kind: kind, __id: id };
}

function isHandle(value) {
  return Boolean(value && value.__workflowHandle === true && typeof value.__id === "string");
}

class Schema {
  constructor(kind, options) {
    this.kind = kind;
    this.options = options || {};
    this.description = undefined;
    this.defaultValue = undefined;
    this.isOptional = false;
  }
  optional() {
    const clone = this.clone();
    clone.isOptional = true;
    return clone;
  }
  nullable() {
    const clone = this.clone();
    clone.nullableValue = true;
    return clone;
  }
  default(value) {
    const clone = this.clone();
    clone.defaultValue = value;
    return clone;
  }
  describe(description) {
    const clone = this.clone();
    clone.description = description;
    return clone;
  }
  clone() {
    const clone = new this.constructor(this.options);
    clone.description = this.description;
    clone.defaultValue = this.defaultValue;
    clone.isOptional = this.isOptional;
    clone.nullableValue = this.nullableValue;
    return clone;
  }
  parse(value) {
    if (value === undefined) {
      if (this.defaultValue !== undefined) {
        return typeof this.defaultValue === "function" ? this.defaultValue() : this.defaultValue;
      }
      if (this.isOptional) return undefined;
    }
    if (value === null && this.nullableValue) return null;
    return this.parseValue(value);
  }
  parseValue(value) {
    return value;
  }
  jsonSchema() {
    const schema = this.schemaValue();
    if (this.description) schema.description = this.description;
    if (this.defaultValue !== undefined && typeof this.defaultValue !== "function") {
      schema.default = this.defaultValue;
    }
    return schema;
  }
  schemaValue() {
    return {};
  }
}

class StringSchema extends Schema {
  constructor(options) {
    super("string", options);
    this.minimum = options && options.minimum;
  }
  min(length, message) {
    const clone = this.clone();
    clone.minimum = length;
    clone.minimumMessage = message;
    return clone;
  }
  clone() {
    const clone = new StringSchema({});
    clone.description = this.description;
    clone.defaultValue = this.defaultValue;
    clone.isOptional = this.isOptional;
    clone.nullableValue = this.nullableValue;
    clone.minimum = this.minimum;
    clone.minimumMessage = this.minimumMessage;
    return clone;
  }
  parseValue(value) {
    if (typeof value !== "string") throw new Error("Expected string");
    if (this.minimum !== undefined && value.length < this.minimum) {
      throw new Error(this.minimumMessage || "String is too short");
    }
    return value;
  }
  schemaValue() {
    return { type: "string" };
  }
}

class BooleanSchema extends Schema {
  parseValue(value) {
    if (typeof value !== "boolean") throw new Error("Expected boolean");
    return value;
  }
  schemaValue() {
    return { type: "boolean" };
  }
}

class NumberSchema extends Schema {
  parseValue(value) {
    if (typeof value !== "number") throw new Error("Expected number");
    return value;
  }
  schemaValue() {
    return { type: "number" };
  }
}

class AnySchema extends Schema {
  parseValue(value) {
    return value;
  }
  schemaValue() {
    return {};
  }
}

class ArraySchema extends Schema {
  constructor(element) {
    super("array", {});
    this.element = element;
  }
  clone() {
    const clone = new ArraySchema(this.element);
    clone.description = this.description;
    clone.defaultValue = this.defaultValue;
    clone.isOptional = this.isOptional;
    clone.nullableValue = this.nullableValue;
    return clone;
  }
  parseValue(value) {
    if (!Array.isArray(value)) throw new Error("Expected array");
    return value.map((item) => this.element.parse(item));
  }
  schemaValue() {
    return { type: "array", items: toJsonSchema(this.element) };
  }
}

class ObjectSchema extends Schema {
  constructor(shape) {
    super("object", {});
    this.shape = shape;
  }
  clone() {
    const clone = new ObjectSchema(this.shape);
    clone.description = this.description;
    clone.defaultValue = this.defaultValue;
    clone.isOptional = this.isOptional;
    clone.nullableValue = this.nullableValue;
    return clone;
  }
  parseValue(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected object");
    }
    const output = {};
    for (const key of Object.keys(this.shape)) {
      const parsed = this.shape[key].parse(value[key]);
      if (parsed !== undefined || Object.prototype.hasOwnProperty.call(value, key)) {
        output[key] = parsed;
      }
    }
    return output;
  }
  schemaValue() {
    const properties = {};
    const required = [];
    for (const key of Object.keys(this.shape)) {
      const child = this.shape[key];
      properties[key] = toJsonSchema(child);
      if (!child.isOptional && child.defaultValue === undefined) required.push(key);
    }
    const schema = { type: "object", properties };
    if (required.length > 0) schema.required = required;
    return schema;
  }
}

class EnumSchema extends Schema {
  constructor(values) {
    super("enum", {});
    this.values = values;
  }
  parseValue(value) {
    if (!this.values.includes(value)) throw new Error("Expected enum value");
    return value;
  }
  clone() {
    const clone = new EnumSchema(this.values);
    clone.description = this.description;
    clone.defaultValue = this.defaultValue;
    clone.isOptional = this.isOptional;
    clone.nullableValue = this.nullableValue;
    return clone;
  }
  schemaValue() {
    return { type: "string", enum: this.values };
  }
}

class LiteralSchema extends Schema {
  constructor(value) {
    super("literal", {});
    this.value = value;
  }
  parseValue(value) {
    if (value !== this.value) throw new Error("Expected literal value");
    return value;
  }
  clone() {
    const clone = new LiteralSchema(this.value);
    clone.description = this.description;
    clone.defaultValue = this.defaultValue;
    clone.isOptional = this.isOptional;
    clone.nullableValue = this.nullableValue;
    return clone;
  }
  schemaValue() {
    return { const: this.value, type: this.value === null ? "null" : typeof this.value };
  }
}

function toJsonSchema(schema) {
  return schema && typeof schema.jsonSchema === "function" ? schema.jsonSchema() : {};
}

export const z = {
  string: () => new StringSchema({}),
  boolean: () => new BooleanSchema("boolean", {}),
  number: () => new NumberSchema("number", {}),
  any: () => new AnySchema("any", {}),
  unknown: () => new AnySchema("unknown", {}),
  object: (shape) => new ObjectSchema(shape),
  array: (element) => new ArraySchema(element),
  enum: (values) => new EnumSchema(values),
  literal: (value) => new LiteralSchema(value)
};

export function input(name, schema, opts) {
  globalRegistry.registerInput({
    kind: "input",
    id: name,
    schema,
    description: opts && opts.description
  });
  return makeHandle("input", name);
}

input.deferred = function deferred(name, schema, opts) {
  globalRegistry.registerInput({
    kind: "deferred_input",
    id: name,
    schema,
    description: opts && opts.description
  });
  return makeHandle("deferred_input", name);
};

export function secret(name, opts) {
  globalRegistry.registerInput({
    kind: "input",
    id: name,
    schema: z.string().min(1, "Secret must not be empty."),
    description: opts && opts.description,
    secret: true
  });
  return makeHandle("input", name);
}

function hashString(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function atom(fn, opts) {
  const id = opts && opts.name ? opts.name : "atom_" + hashString(fn.toString());
  globalRegistry.registerAtom({
    kind: "atom",
    id,
    fn,
    description: opts && opts.description
  });
  return makeHandle("atom", id);
}

export function describeRegistry(registry) {
  return {
    inputs: registry.allInputs().map((item) => ({
      id: item.id,
      kind: item.kind,
      secret: item.secret === true ? true : undefined,
      description: item.description,
      schema: toJsonSchema(item.schema)
    })),
    atoms: registry.allAtoms().map((item) => ({
      id: item.id,
      description: item.description
    }))
  };
}

class SkipError extends Error {
  constructor(stepId, reason) {
    super(reason || "Step skipped: " + stepId);
    this.stepId = stepId;
    this.reason = reason;
  }
}

class WaitError extends Error {
  constructor(inputId) {
    super("Waiting on input: " + inputId);
    this.inputId = inputId;
  }
}

class NotReadyError extends Error {
  constructor(dependencyId) {
    super("Dependency not ready: " + dependencyId);
    this.dependencyId = dependencyId;
  }
}

export function createRuntime(opts) {
  return {
    async process(event, state) {
      const registry = opts && opts.registry ? opts.registry : globalRegistry;
      const session = new RunSession(registry, opts || {}, state || makeEmptyRunState(event.runId));
      if (session.hasProcessed(event.eventId)) {
        return { state: session.snapshot(), emitted: [], trace: session.buildTrace() };
      }
      const emitted = event.kind === "input"
        ? session.handleInputEvent(event)
        : await session.handleStepEvent(event);
      session.markProcessed(event.eventId);
      return { state: session.snapshot(), emitted, trace: session.buildTrace() };
    }
  };
}

class RunSession {
  constructor(registry, opts, state) {
    this.registry = registry;
    this.opts = opts;
    this.state = state;
  }
  hasProcessed(eventId) {
    return this.state.processedEventIds[eventId] === true;
  }
  markProcessed(eventId) {
    this.state.processedEventIds[eventId] = true;
  }
  handleInputEvent(event) {
    const inputDef = this.registry.getInput(event.inputId);
    if (!inputDef) throw new Error("Unknown input: " + event.inputId);
    const validated = inputDef.schema.parse(event.payload);
    const storedValue = inputDef.secret ? "[secret]" : validated;
    if (this.state.trigger === undefined) this.state.trigger = event.inputId;
    if (this.state.payload === undefined) this.state.payload = storedValue;
    if (!inputDef.secret) this.state.inputs[event.inputId] = validated;
    this.state.nodes[event.inputId] = {
      status: "resolved",
      value: storedValue,
      deps: [],
      duration_ms: 0,
      attempts: 1
    };
    const targeted = this.state.waiters[event.inputId] || [];
    if (targeted.length > 0) {
      delete this.state.waiters[event.inputId];
      return targeted.flatMap((stepId) => this.emitStep(stepId));
    }
    return this.registry.allAtoms().flatMap((step) => this.emitStep(step.id));
  }
  async handleStepEvent(event) {
    const existing = this.state.nodes[event.stepId];
    if (existing && (existing.status === "resolved" || existing.status === "skipped" || existing.status === "errored")) {
      return [];
    }
    const atomDef = this.registry.getAtom(event.stepId);
    if (!atomDef) throw new Error("Unknown step: " + event.stepId);
    try {
      await this.runAtom(atomDef);
      return this.wakeWaiters(event.stepId);
    } catch (error) {
      if (error instanceof NotReadyError) return this.emitStep(error.dependencyId);
      return this.wakeWaiters(event.stepId);
    }
  }
  async runAtom(def) {
    const start = Date.now();
    const deps = [];
    const previous = this.state.nodes[def.id];
    const getValue = (source) => {
      if (!isHandle(source)) throw new Error("get() called with non-handle value");
      deps.push(source.__id);
      return this.readValue(def.id, source.__id);
    };
    getValue.maybe = (source) => {
      if (!isHandle(source)) throw new Error("get.maybe() called with non-handle value");
      deps.push(source.__id);
      try {
        return this.readValue(def.id, source.__id);
      } catch (error) {
        if (error instanceof SkipError || error instanceof WaitError) return undefined;
        throw error;
      }
    };
    getValue.skip = (reason) => {
      throw new SkipError(def.id, reason);
    };
    try {
      const value = await def.fn(getValue);
      this.state.nodes[def.id] = {
        status: "resolved",
        value,
        deps,
        duration_ms: Date.now() - start,
        attempts: (previous && previous.attempts ? previous.attempts : 0) + 1
      };
      return value;
    } catch (error) {
      const duration_ms = Date.now() - start;
      if (error instanceof SkipError) {
        this.state.nodes[def.id] = {
          status: "skipped",
          deps,
          duration_ms,
          skipReason: error.reason,
          attempts: (previous && previous.attempts ? previous.attempts : 0) + 1
        };
        throw error;
      }
      if (error instanceof WaitError) {
        this.state.nodes[def.id] = {
          status: "waiting",
          deps,
          duration_ms,
          waitingOn: error.inputId,
          attempts: (previous && previous.attempts ? previous.attempts : 0) + 1
        };
        throw error;
      }
      if (error instanceof NotReadyError) {
        this.state.nodes[def.id] = {
          status: "blocked",
          deps,
          duration_ms,
          blockedOn: error.dependencyId,
          attempts: (previous && previous.attempts ? previous.attempts : 0) + 1
        };
        throw error;
      }
      this.state.nodes[def.id] = {
        status: "errored",
        deps,
        duration_ms,
        attempts: (previous && previous.attempts ? previous.attempts : 0) + 1,
        error: { message: error && error.message ? error.message : String(error), stack: error && error.stack }
      };
      throw error;
    }
  }
  readValue(readerStepId, depId) {
    const inputDef = this.registry.getInput(depId);
    if (inputDef && inputDef.secret) {
      const secretValues = this.opts && this.opts.secretValues ? this.opts.secretValues : {};
      if (Object.prototype.hasOwnProperty.call(secretValues, depId)) {
        if (!this.state.nodes[depId]) {
          this.state.nodes[depId] = {
            status: "resolved",
            value: "[secret]",
            deps: [],
            duration_ms: 0,
            attempts: 1
          };
        }
        return secretValues[depId];
      }
      this.registerWaiter(depId, readerStepId);
      throw new WaitError(depId);
    }
    if (inputDef && Object.prototype.hasOwnProperty.call(this.state.inputs, depId)) {
      return this.state.inputs[depId];
    }
    const existing = this.state.nodes[depId];
    if (existing && existing.status === "resolved") return existing.value;
    if (existing && existing.status === "skipped") throw new SkipError(depId, existing.skipReason);
    if (existing && existing.status === "waiting") throw new WaitError(existing.waitingOn);
    if (existing && existing.status === "errored") throw new Error(existing.error && existing.error.message);
    if (existing && existing.status === "blocked") {
      this.registerWaiter(depId, readerStepId);
      throw new NotReadyError(depId);
    }
    if (inputDef) {
      if (inputDef.kind === "deferred_input") {
        this.registerWaiter(depId, readerStepId);
        throw new WaitError(depId);
      }
      throw new SkipError(depId);
    }
    const atomDef = this.registry.getAtom(depId);
    if (!atomDef) throw new Error("Unknown id: " + depId);
    this.registerWaiter(depId, readerStepId);
    throw new NotReadyError(depId);
  }
  registerWaiter(depId, stepId) {
    const list = this.state.waiters[depId] || [];
    if (!list.includes(stepId)) list.push(stepId);
    this.state.waiters[depId] = list;
  }
  wakeWaiters(depId) {
    const waiters = this.state.waiters[depId] || [];
    delete this.state.waiters[depId];
    return waiters.flatMap((stepId) => this.emitStep(stepId));
  }
  emitStep(stepId) {
    const record = this.state.nodes[stepId];
    if (record && (record.status === "resolved" || record.status === "skipped" || record.status === "errored")) {
      return [];
    }
    return [{ kind: "step", eventId: crypto.randomUUID(), runId: this.state.runId, stepId }];
  }
  snapshot() {
    return structuredClone(this.state);
  }
  buildTrace() {
    const nodes = {};
    for (const id of this.registry.allIds()) {
      const record = this.state.nodes[id];
      if (record) {
        nodes[id] = Object.assign({}, record);
      } else {
        const inputDef = this.registry.getInput(id);
        nodes[id] = {
          status: inputDef && inputDef.kind === "input" ? "skipped" : "not_reached",
          deps: [],
          duration_ms: 0,
          attempts: 0
        };
      }
    }
    return {
      runId: this.state.runId,
      trigger: this.state.trigger,
      payload: this.state.payload,
      startedAt: this.state.startedAt,
      completedAt: Date.now(),
      nodes
    };
  }
}

function makeEmptyRunState(runId) {
  return {
    runId,
    startedAt: Date.now(),
    inputs: {},
    nodes: {},
    waiters: {},
    processedEventIds: {}
  };
}
`;
