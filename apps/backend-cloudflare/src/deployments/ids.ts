import { PlatformApiError } from "../errors";

export function deploymentIdForTenant(tenantId: string): string {
  const slug = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  if (!slug) {
    throw new PlatformApiError(
      400,
      "invalid_tenant_id",
      "tenantId must contain at least one alphanumeric character.",
    );
  }
  return `tenant-${slug}`;
}

export function deploymentIdForTenantDeployment(
  tenantId: string,
  deploymentId: string,
): string {
  assertDeploymentId(deploymentId);
  const suffix = stableTenantSuffix(tenantId);
  const maxBaseLength = 63 - suffix.length - 1;
  const base =
    deploymentId
      .slice(0, maxBaseLength)
      .replace(/[-_]+$/g, "")
      .replace(/^[-_]+/g, "") || "workflow";
  return `${base}-${suffix}`;
}

export function tagForTenant(tenantId: string): string {
  const slug = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new PlatformApiError(
      400,
      "invalid_tenant_id",
      "tenantId must contain at least one alphanumeric character.",
    );
  }
  return `tenant-${slug}`;
}

export function assertDeploymentId(deploymentId: string): void {
  if (!/^[a-z0-9][a-z0-9-_]{0,62}$/.test(deploymentId)) {
    throw new PlatformApiError(
      400,
      "invalid_deployment_id",
      "deploymentId must be 1-63 lowercase letters, numbers, dashes, or underscores, and start with a letter or number.",
    );
  }
}

function stableTenantSuffix(tenantId: string): string {
  const slug = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(-10);
  if (slug) return slug;

  throw new PlatformApiError(
    400,
    "invalid_tenant_id",
    "tenantId must contain at least one alphanumeric character.",
  );
}

export function assertModuleName(moduleName: string): void {
  if (!/^[A-Za-z0-9._-]+\.mjs$/.test(moduleName)) {
    throw new PlatformApiError(
      400,
      "invalid_module_name",
      'moduleName must be a simple ".mjs" file name.',
    );
  }
}

export function assertCompatibilityDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PlatformApiError(
      400,
      "invalid_compatibility_date",
      "compatibilityDate must use YYYY-MM-DD format.",
    );
  }
}

export function assertWorkerTags(tags: string[]): void {
  if (tags.length > 8) {
    throw new PlatformApiError(
      400,
      "too_many_tags",
      "Cloudflare Workers for Platforms supports at most eight tags per script.",
    );
  }
  for (const tag of tags) {
    if (tag.length === 0 || tag.includes(",") || tag.includes("&")) {
      throw new PlatformApiError(
        400,
        "invalid_tag",
        'Worker tags cannot be empty or contain "," or "&".',
      );
    }
  }
}
