import type { ZodSchema } from "zod";
import type { RouteHandler } from "./route";
import type { AtomRuntimeContext, Get, RequestIntervention } from "./types";

export type InputDef = {
  kind: "input" | "deferred_input";
  id: string;
  title?: string;
  schema: ZodSchema<unknown>;
  description?: string;
  secret?: boolean;
  secretValue?: string;
  errorMessage?: string;
  internal?: boolean;
};

export type ManagedConnectionRequirement = "lazy" | "preflight";

export type ManagedConnectionDef = {
  kind: "oauth";
  providerId: string;
  requirement: ManagedConnectionRequirement;
  title?: string;
  scopes?: string[];
};

type StepFn = (
  get: Get,
  requestIntervention: RequestIntervention,
  context: AtomRuntimeContext,
) => unknown;

export type AtomDef = {
  kind: "atom";
  id: string;
  fn: StepFn;
  description?: string;
  managedConnection?: ManagedConnectionDef;
  internal?: boolean;
};

export type ActionDef = {
  kind: "action";
  id: string;
  fn: StepFn;
  description?: string;
  internal?: boolean;
};

export type StepDef = AtomDef | ActionDef;

export type ScheduleDef = {
  id: string;
  cron: string;
  inputId: string;
  payload: unknown;
  description?: string;
};

export type RouteDef = {
  id: string;
  path: string;
  method: string;
  handler: RouteHandler;
  description?: string;
};

export class Registry {
  private _inputs = new Map<string, InputDef>();
  private _atoms = new Map<string, AtomDef>();
  private _actions = new Map<string, ActionDef>();
  private _schedules = new Map<string, ScheduleDef>();
  private _routes = new Map<string, RouteDef>();

  registerInput(def: InputDef): void {
    this.assertUnique(def.id);
    this._inputs.set(def.id, def);
  }

  registerAtom(def: AtomDef): void {
    this.assertUnique(def.id);
    this._atoms.set(def.id, def);
  }

  registerAction(def: ActionDef): void {
    this.assertUnique(def.id);
    this._actions.set(def.id, def);
  }

  registerSchedule(def: ScheduleDef): void {
    this.assertUnique(def.id);
    if (!this._inputs.has(def.inputId)) {
      throw new Error(
        `schedule "${def.id}" references unknown input "${def.inputId}". Register the input before declaring the schedule.`,
      );
    }
    this._schedules.set(def.id, def);
  }

  registerRoute(def: RouteDef): void {
    this.assertUnique(def.id);
    this._routes.set(def.id, def);
  }

  getInput(id: string): InputDef | undefined {
    return this._inputs.get(id);
  }
  getAtom(id: string): AtomDef | undefined {
    return this._atoms.get(id);
  }
  getAction(id: string): ActionDef | undefined {
    return this._actions.get(id);
  }
  getStep(id: string): StepDef | undefined {
    return this._atoms.get(id) ?? this._actions.get(id);
  }
  getSchedule(id: string): ScheduleDef | undefined {
    return this._schedules.get(id);
  }
  getRoute(id: string): RouteDef | undefined {
    return this._routes.get(id);
  }

  allInputs(): InputDef[] {
    return [...this._inputs.values()];
  }
  allAtoms(): AtomDef[] {
    return [...this._atoms.values()];
  }
  allActions(): ActionDef[] {
    return [...this._actions.values()];
  }
  allSteps(): StepDef[] {
    return [...this._atoms.values(), ...this._actions.values()];
  }
  allSchedules(): ScheduleDef[] {
    return [...this._schedules.values()];
  }
  allRoutes(): RouteDef[] {
    return [...this._routes.values()];
  }
  allIds(): string[] {
    return [
      ...this._inputs.keys(),
      ...this._atoms.keys(),
      ...this._actions.keys(),
      ...this._schedules.keys(),
      ...this._routes.keys(),
    ];
  }

  clear(): void {
    this._inputs.clear();
    this._atoms.clear();
    this._actions.clear();
    this._schedules.clear();
    this._routes.clear();
  }

  private assertUnique(id: string): void {
    if (
      this._inputs.has(id) ||
      this._atoms.has(id) ||
      this._actions.has(id) ||
      this._schedules.has(id) ||
      this._routes.has(id)
    ) {
      throw new Error(`Duplicate registry ID: ${id}`);
    }
  }
}

export const globalRegistry = new Registry();
