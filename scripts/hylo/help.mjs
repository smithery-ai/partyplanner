import { deployableTargetChoices, profileChoices } from "./workspace.mjs";

export function printHelp() {
  console.log(`hylo

Usage:
  hylo dev [profile]
  hylo uplink <profile> <workflow-target>
  hylo deploy [profile] [target...]
  hylo env [profile]
  hylo run [profile] -- <command...>
  hylo exec [profile] -- <command...>
  hylo profile add|remove <profile> <target>
  hylo target add <target> --path <path> --url <url>

Profiles come from hylo.json. The default profile is used when no profile is
passed. Targets are named by kind, for example backend.node,
workflow.nextjs, or app.client.

Commands:
  dev       Start the configured local targets for a profile.
  uplink    Expose a local workflow to a remote app with a temporary tunnel.
  deploy    Deploy the deployable targets in a profile.
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
  hylo dev
  hylo uplink remote workflow.nextjs
  hylo env remote
  hylo deploy remote
  hylo exec remote -- env

Register and attach a target:
  hylo target add workflow.someWorker --path ./examples/some-worker --url https://some-worker.hylo.localhost
  hylo profile add remote workflow.someWorker
`);
}
