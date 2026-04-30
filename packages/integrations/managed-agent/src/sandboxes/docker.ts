// `dockerSandbox` — STUB. Implementation deferred.
//
// Local Docker container for sandbox isolation in dev environments.
// Won't run in a CF Worker host — for local hylo dev / CI only.
//
// Implementation outline:
//   - provision: docker create + start with the configured image
//   - mount:
//       git    → docker exec git clone
//       file   → docker cp
//       env    → docker exec env=
//       secret → same as env
//   - stop: docker stop
//   - cleanup: docker rm -v

import type {
  CleanupPolicy,
  MountResult,
  Resource,
  Sandbox,
  SandboxHandle,
  SandboxSpec,
} from "../primitives";

export interface DockerSandboxOptions {
  /** Container image (e.g. "ubuntu:24.04", "node:22-bookworm"). */
  image: string;
  /** Optional resource limits passed to `docker run`. */
  cpus?: number;
  memoryMb?: number;
}

export function dockerSandbox(_opts: DockerSandboxOptions): Sandbox {
  return {
    id: "docker",

    async provision(_spec: SandboxSpec): Promise<SandboxHandle> {
      throw new Error(
        "dockerSandbox: not implemented yet. See sandboxes/docker.ts for the implementation outline.",
      );
    },
    async mount(
      _handle: SandboxHandle,
      _resource: Resource,
    ): Promise<MountResult> {
      throw new Error("dockerSandbox: not implemented yet.");
    },
    async stop(_handle: SandboxHandle, _reason: string): Promise<void> {
      throw new Error("dockerSandbox: not implemented yet.");
    },
    async cleanup(
      _handle: SandboxHandle,
      _policy: CleanupPolicy,
    ): Promise<void> {
      throw new Error("dockerSandbox: not implemented yet.");
    },
  };
}
