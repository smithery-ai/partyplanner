import type { ZodSchema } from "zod";
import type { Get } from "./types";

export type InputDef = {
  kind: "input" | "deferred_input";
  id: string;
  schema: ZodSchema<unknown>;
  description?: string;
};

export type SecretDef = {
  kind: "secret";
  id: string;
  defaultValue: unknown;
  description?: string;
};

export type AtomDef = {
  kind: "atom";
  id: string;
  fn: (get: Get) => unknown;
  description?: string;
};

export class Registry {
  private _inputs = new Map<string, InputDef>();
  private _secrets = new Map<string, SecretDef>();
  private _atoms = new Map<string, AtomDef>();
  private _anonymousIds = new Map<string, number>();

  registerInput(def: InputDef): void {
    if (this.hasId(def.id)) {
      throw new Error(`Duplicate registry ID: ${def.id}`);
    }
    this._inputs.set(def.id, def);
  }

  registerSecret(def: SecretDef): void {
    if (this.hasId(def.id)) {
      throw new Error(`Duplicate registry ID: ${def.id}`);
    }
    this._secrets.set(def.id, def);
  }

  registerAtom(def: AtomDef): void {
    if (this.hasId(def.id)) {
      throw new Error(`Duplicate registry ID: ${def.id}`);
    }
    this._atoms.set(def.id, def);
  }

  nextAnonymousId(prefix: string): string {
    const n = (this._anonymousIds.get(prefix) ?? 0) + 1;
    this._anonymousIds.set(prefix, n);
    return `${prefix}_${n}`;
  }

  getInput(id: string): InputDef | undefined {
    return this._inputs.get(id);
  }
  getSecret(id: string): SecretDef | undefined {
    return this._secrets.get(id);
  }
  getAtom(id: string): AtomDef | undefined {
    return this._atoms.get(id);
  }

  allInputs(): InputDef[] {
    return [...this._inputs.values()];
  }
  allSecrets(): SecretDef[] {
    return [...this._secrets.values()];
  }
  allAtoms(): AtomDef[] {
    return [...this._atoms.values()];
  }
  allIds(): string[] {
    return [
      ...this._inputs.keys(),
      ...this._secrets.keys(),
      ...this._atoms.keys(),
    ];
  }

  clear(): void {
    this._inputs.clear();
    this._secrets.clear();
    this._atoms.clear();
    this._anonymousIds.clear();
  }

  private hasId(id: string): boolean {
    return this._inputs.has(id) || this._secrets.has(id) || this._atoms.has(id);
  }
}

export const globalRegistry = new Registry();
