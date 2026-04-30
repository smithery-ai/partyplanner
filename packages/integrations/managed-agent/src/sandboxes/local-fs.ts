// `localFsSandbox` — STUB. Implementation deferred.
//
// In-process / tmp-dir sandbox for local dev and testing. Tool calls
// operate against a host filesystem path. Useful for prototyping
// non-cloud-claude provider/sandbox compositions before paying for
// remote infra.
//
// Implementation outline:
//   - provision: mkdir -p workdir; allocate a unique session subdir
//   - mount:
//       git    → child_process git clone into the subdir
//       file   → fs.copyFileSync into the subdir
//       env    → write to a .env file the provider can source
//       secret → same as env, with the resolved value
//   - cleanup: rm -rf the subdir (when policy === "delete")

import type {
  CleanupPolicy,
  MountResult,
  Resource,
  Sandbox,
  SandboxHandle,
  SandboxSpec,
} from "../primitives";

export interface LocalFsSandboxOptions {
  /** Root directory under which session subdirs are created. */
  workdir: string;
}

export function localFsSandbox(_opts: LocalFsSandboxOptions): Sandbox {
  return {
    id: "local-fs",

    async provision(_spec: SandboxSpec): Promise<SandboxHandle> {
      throw new Error(
        "localFsSandbox: not implemented yet. See sandboxes/local-fs.ts for the implementation outline.",
      );
    },
    async mount(
      _handle: SandboxHandle,
      _resource: Resource,
    ): Promise<MountResult> {
      throw new Error("localFsSandbox: not implemented yet.");
    },
    async cleanup(
      _handle: SandboxHandle,
      _policy: CleanupPolicy,
    ): Promise<void> {
      throw new Error("localFsSandbox: not implemented yet.");
    },
  };
}
