import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  die,
  formatPackagePath,
  isHttpUrl,
  packageJsonAt,
  packagePath,
  repoRoot,
  validateHttpUrl,
} from "./shared.mjs";

const UrlSchema = z.string().url();
const TargetSchema = z.object({
  path: z.string().min(1),
  provider: z.string().min(1).optional(),
  dev: z.string().min(1).optional(),
  build: z.string().min(1).optional(),
  deploy: z.string().min(1).optional(),
  url: UrlSchema.optional(),
  listenUrl: UrlSchema.optional(),
  workerName: z.string().min(1).optional(),
});
const ProfileSchema = z.object({
  targets: z.array(z.string().min(1)).min(1),
  urls: z.record(z.string().min(1), UrlSchema).default({}),
});
const HyloConfigSchema = z.object({
  defaultProfile: z.string().min(1).optional(),
  profiles: z.record(z.string().min(1), ProfileSchema),
  targets: z.record(z.string().min(1), TargetSchema),
});

export const HYLO_CONFIG = loadHyloConfig();
export const TARGETS = loadTargets();
export const BACKENDS = TARGETS.filter((target) => target.kind === "backend");
export const WORKFLOWS = TARGETS.filter((target) => target.kind === "workflow");
export const APPS = TARGETS.filter((target) => target.kind === "app");

export function defaultProfile() {
  const profileName =
    process.env.HYLO_PROFILE?.trim() || HYLO_CONFIG.defaultProfile;
  if (!profileName) return undefined;
  return resolveProfile(profileName);
}

export function resolveProfile(profileName) {
  const profile = HYLO_CONFIG.profiles?.[profileName];
  if (!profile) {
    die(`hylo.json profile "${profileName}" does not exist.`);
  }

  return {
    id: profileName,
    targetIds: profile.targets,
    targets: profile.targets.map((targetId) => resolveTarget(targetId)),
    urls: profile.urls,
  };
}

export function updateProfileTargets(profileName, updater) {
  const nextConfig = structuredClone(HYLO_CONFIG);
  const profile = nextConfig.profiles?.[profileName];
  if (!profile) {
    die(`hylo.json profile "${profileName}" does not exist.`);
  }

  profile.targets = updater(profile.targets, nextConfig);
  validateHyloConfigReferences(nextConfig);
  writeHyloConfig(nextConfig);
}

export function addTarget(targetId, targetConfig) {
  const nextConfig = structuredClone(HYLO_CONFIG);
  if (nextConfig.targets[targetId]) {
    die(`hylo.json target "${targetId}" already exists.`);
  }
  nextConfig.targets[targetId] = targetConfig;
  validateHyloConfigReferences(nextConfig);
  writeHyloConfig(nextConfig);
}

export function hasProfile(profileName) {
  return Boolean(HYLO_CONFIG.profiles?.[profileName]);
}

export function profileChoices() {
  return Object.keys(HYLO_CONFIG.profiles).join(", ");
}

export function resolveTarget(name, expectedKind) {
  if (isHttpUrl(name)) {
    die(
      "targets are configured hylo.json ids or package paths, not URLs. Put URLs on the target config.",
    );
  }

  const target = resolveConfiguredTarget(name);
  if (expectedKind && target.kind !== expectedKind) {
    die(`target "${name}" is a ${target.kind}, expected ${expectedKind}.`);
  }
  return target;
}

export function resolveCurrentTarget() {
  const currentDir = resolve(process.cwd());
  return TARGETS.find((target) => target.packageDir === currentDir);
}

export function profileBackend(profile) {
  return singleProfileTarget(profile, "backend");
}

export function profileApp(profile) {
  return singleProfileTarget(profile, "app");
}

export function profileWorkflows(profile) {
  return profile.targets.filter((target) => target.kind === "workflow");
}

export function targetRuntimeUrl(target, profile) {
  const value = profile.urls?.[target.id] ?? target.url;
  if (!value) {
    die(
      `${target.id} must set ${profile.id === "local" ? "url" : `profiles.${profile.id}.urls.${target.id}`} in hylo.json.`,
    );
  }
  return validateHttpUrl(value, `${target.id} url`);
}

export function targetListenUrl(target) {
  return target.listenUrl
    ? validateHttpUrl(target.listenUrl, `${target.id} listenUrl`)
    : undefined;
}

export function targetChoices(targets = TARGETS) {
  return targets
    .map((target) => `${target.id} (${formatPackagePath(target.packageDir)})`)
    .join(", ");
}

export function deployableTargets(targets = TARGETS) {
  return targets.filter((target) => target.deploy);
}

export function deployableTargetChoices() {
  return targetChoices(deployableTargets());
}

export function packageTargetForKind(kind) {
  if (kind === "backend") return BACKENDS;
  if (kind === "workflow") return WORKFLOWS;
  if (kind === "app") return APPS;
  return TARGETS.filter((target) => target.kind === kind);
}

function singleProfileTarget(profile, kind) {
  const targets = profile.targets.filter((target) => target.kind === kind);
  if (targets.length === 1) return targets[0];
  if (targets.length === 0) {
    die(`profile "${profile.id}" does not include a ${kind} target.`);
  }
  die(`profile "${profile.id}" includes multiple ${kind} targets.`);
}

function resolveConfiguredTarget(name) {
  const raw = name?.trim();
  if (!raw) die("missing target.");

  const byId = TARGETS.find((target) => target.id === raw);
  if (byId) return byId;

  const packageDir = resolvePackageDir(raw);
  const byPath = TARGETS.find((target) => target.packageDir === packageDir);
  if (byPath) return byPath;

  die(`"${name}" is not a configured Hylo target. Use ${targetChoices()}.`);
}

function resolvePackageDir(value) {
  const packageDir = resolve(process.cwd(), value);
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    die(`target "${value}" must be a hylo.json id or package directory.`);
  }
  return packageDir;
}

function loadTargets() {
  return Object.entries(HYLO_CONFIG.targets)
    .map(([id, config]) => readTargetConfig(id, config))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function readTargetConfig(id, config) {
  const [kind, ...nameParts] = id.split(".");
  if (
    !["app", "backend", "workflow"].includes(kind) ||
    nameParts.length === 0
  ) {
    die(`hylo.json target "${id}" must be named like backend.node.`);
  }

  const packageDir = resolve(repoRoot, config.path);
  const packageJson = packageJsonAt(packageDir);
  const packageName = String(packageJson.name ?? "").trim();
  if (!packageName) {
    die(`${formatPackagePath(packageDir)} must set package.json name`);
  }

  return {
    ...config,
    id,
    kind,
    name: nameParts.join("."),
    packageDir,
    packageName,
    packagePath: packagePath(packageDir),
  };
}

function loadHyloConfig() {
  const configPath = hyloConfigPath();
  if (!existsSync(configPath)) {
    die(`${configPath} does not exist. Run hylo init to create one.`);
  }

  const parsed = HyloConfigSchema.safeParse(
    JSON.parse(readFileSync(configPath, "utf8")),
  );
  if (!parsed.success) {
    die(
      `hylo.json is invalid:\n${parsed.error.issues
        .map(
          (issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        )
        .join("\n")}`,
    );
  }

  const config = parsed.data;
  validateHyloConfigReferences(config);
  return config;
}

function writeHyloConfig(config) {
  writeFileSync(hyloConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function hyloConfigPath() {
  return join(repoRoot, "hylo.json");
}

function validateHyloConfigReferences(config) {
  if (config.defaultProfile && !config.profiles[config.defaultProfile]) {
    die(
      `defaultProfile references missing profile "${config.defaultProfile}".`,
    );
  }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    for (const targetId of profile.targets) {
      if (!config.targets[targetId]) {
        die(
          `profile "${profileName}" references missing target "${targetId}".`,
        );
      }
    }

    for (const targetId of Object.keys(profile.urls)) {
      if (!config.targets[targetId]) {
        die(
          `profile "${profileName}" has a URL for missing target "${targetId}".`,
        );
      }
    }

    const kinds = profile.targets.map((targetId) => targetId.split(".")[0]);
    for (const kind of ["backend", "app"]) {
      const count = kinds.filter((value) => value === kind).length;
      if (count !== 1) {
        die(
          `profile "${profileName}" must include exactly one ${kind} target.`,
        );
      }
    }
    if (!kinds.includes("workflow")) {
      die(
        `profile "${profileName}" must include at least one workflow target.`,
      );
    }
  }
}
