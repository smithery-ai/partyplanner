import type { ZodSchema } from "zod";
import type { AtomRuntimeContext, Get, RequestIntervention } from "./types";

export type InputDef = {
  kind: "input" | "deferred_input";
  id: string;
  schema: ZodSchema<unknown>;
  description?: string;
  secret?: boolean;
  secretValue?: string;
  errorMessage?: string;
};

export type AtomDef = {
  kind: "atom";
  id: string;
  fn: (
    get: Get,
    requestIntervention: RequestIntervention,
    context: AtomRuntimeContext,
  ) => unknown;
  description?: string;
};

export class Registry {
  private _inputs = new Map<string, InputDef>();
  private _atoms = new Map<string, AtomDef>();

  registerInput(def: InputDef): void {
    if (this._inputs.has(def.id) || this._atoms.has(def.id)) {
      throw new Error(`Duplicate registry ID: ${def.id}`);
    }
    this._inputs.set(def.id, def);
  }

  registerAtom(def: AtomDef): void {
    if (this._atoms.has(def.id) || this._inputs.has(def.id)) {
      throw new Error(`Duplicate registry ID: ${def.id}`);
    }
    this._atoms.set(def.id, def);
  }

  getInput(id: string): InputDef | undefined {
    return this._inputs.get(id);
  }
  getAtom(id: string): AtomDef | undefined {
    return this._atoms.get(id);
  }

  allInputs(): InputDef[] {
    return [...this._inputs.values()];
  }
  allAtoms(): AtomDef[] {
    return [...this._atoms.values()];
  }
  allIds(): string[] {
    return [...this._inputs.keys(), ...this._atoms.keys()];
  }

  clear(): void {
    this._inputs.clear();
    this._atoms.clear();
  }
}

export const globalRegistry = new Registry();
