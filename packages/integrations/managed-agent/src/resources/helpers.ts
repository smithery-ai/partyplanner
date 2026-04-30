// Resource builders. Sugar over the `Resource` discriminated union so
// consumers don't have to type the kind/field plumbing each time.
//
// Example:
//   import { resources as r } from "@workflow/integrations-managed-agent";
//   const factory = managedAgent({
//     resources: [
//       r.git({ repo: "smithery-ai/mono", mount: "/workspace/repo" }),
//       r.secret({ source: githubPat, env: "SMITHERY_GH_PAT" }),
//       r.secret({ source: linearApiKey, env: "LINEAR_API_KEY", optional: true }),
//     ],
//     ...
//   });

import type { Resource, SecretRef } from "../primitives";

export function git(args: {
  repo: string;
  ref?: string;
  mount: string;
}): Resource {
  return { kind: "git", repo: args.repo, ref: args.ref, mount: args.mount };
}

export function file(args: { source: string; mount: string }): Resource {
  return { kind: "file", source: args.source, mount: args.mount };
}

export function secret(args: {
  source: SecretRef;
  env: string;
  optional?: boolean;
}): Resource {
  return {
    kind: "secret",
    source: args.source,
    env: args.env,
    optional: args.optional,
  };
}

export function env(args: { name: string; value: string }): Resource {
  return { kind: "env", name: args.name, value: args.value };
}
