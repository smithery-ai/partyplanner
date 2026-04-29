import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { declaredSecretNames, envSecretWranglerVars } from "../src/secrets.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hylo-secrets-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

it("discovers secrets declared by linked workflow dependencies", async () => {
  const project = join(workspace, "worker");
  const linked = join(project, "linked-gmail");
  const linkedArcade = join(project, "linked-arcade");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(linked, "src"), { recursive: true });
  await mkdir(join(linkedArcade, "src"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      dependencies: {
        "@workflow/integrations-gmail": "link:./linked-gmail",
      },
    }),
  );
  await writeFile(
    join(project, "src", "index.ts"),
    'import { secret } from "@workflow/core"; secret("PROJECT_TOKEN", undefined);',
  );
  await writeFile(
    join(linked, "package.json"),
    JSON.stringify({
      dependencies: {
        "@workflow/integrations-arcade": "link:../linked-arcade",
      },
    }),
  );
  await writeFile(join(linkedArcade, "package.json"), JSON.stringify({}));
  await writeFile(
    join(linkedArcade, "src", "arcade.ts"),
    [
      'import { secret } from "@workflow/core";',
      'secret("ARCADE_API_KEY", undefined);',
      'secret("HYLO_API_KEY", undefined);',
    ].join("\n"),
  );

  await expect(declaredSecretNames(join(project, "src"))).resolves.toEqual([
    "HYLO_API_KEY",
    "PROJECT_TOKEN",
  ]);
  await expect(
    envSecretWranglerVars(join(project, "src"), {
      ARCADE_API_KEY: "arcade-key",
      HYLO_API_KEY: "hylo-key",
      PROJECT_TOKEN: "project-token",
    } as NodeJS.ProcessEnv),
  ).resolves.toEqual([
    "--var",
    "HYLO_API_KEY:hylo-key",
    "--var",
    "PROJECT_TOKEN:project-token",
  ]);
});
