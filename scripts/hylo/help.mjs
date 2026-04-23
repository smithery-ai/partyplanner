import { deployableTargetChoices, profileChoices } from "./workspace.mjs";

export function printHelp() {
  console.log(`hylo-dev

Usage:
  hylo-dev dev [profile]
  hylo-dev uplink <profile> <workflow-target>
  hylo-dev deploy [profile] [target...]
  hylo-dev preview <name> [profile] [target...]
  hylo-dev env [profile]
  hylo-dev run [profile] -- <command...>
  hylo-dev exec [profile] -- <command...>
  hylo-dev profile add|remove <profile> <target>
  hylo-dev target add <target> --path <path> --url <url>

Profiles come from hylo.json. The default profile is used when no profile is
passed. Targets are named by kind, for example backend.node,
workflow.nextjs, or app.client.

Commands:
  dev       Start the configured local targets for a profile.
  uplink    Expose a local workflow to a remote app with a temporary tunnel.
  deploy    Deploy the deployable targets in a profile.
  preview   Deploy a named preview stack for a profile.
  env       Print the Hylo environment resolved for a profile.
  run       Launch a long-running command with profile env injected.
  exec      Run a one-off command with profile env injected.
  profile   Add or remove targets in hylo.json.
  target    Register targets in hylo.json.

Profiles:
  ${profileChoices()}

Deployable targets:
  ${deployableTargetChoices()}

Common:
  hylo-dev dev
  hylo-dev uplink remote workflow.cloudflareWorker
  hylo-dev env remote
  hylo-dev deploy remote
  hylo-dev preview pr-123
  hylo-dev deploy remote app.client

Register and attach a target:
  hylo-dev target add workflow.someWorker --path ./examples/some-worker --url https://some-worker.hylo.localhost
  hylo-dev profile add remote workflow.someWorker
`);
}
