import type { ZodSchema } from "zod";
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
};

export type ActionDef = {
  kind: "action";
  id: string;
  fn: StepFn;
  description?: string;
};

export type StepDef = AtomDef | ActionDef;

export class Registry {
  private _inputs = new Map<string, InputDef>();
  private _atoms = new Map<string, AtomDef>();
  private _actions = new Map<string, ActionDef>();

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
  allIds(): string[] {
    return [
      ...this._inputs.keys(),
      ...this._atoms.keys(),
      ...this._actions.keys(),
    ];
  }

  clear(): void {
    this._inputs.clear();
    this._atoms.clear();
    this._actions.clear();
  }

  private assertUnique(id: string): void {
    if (this._inputs.has(id) || this._atoms.has(id) || this._actions.has(id)) {
      throw new Error(`Duplicate registry ID: ${id}`);
    }
  }
}

export const globalRegistry = new Registry();
