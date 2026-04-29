import { routes, type VercelConfig } from "@vercel/config/v1";

const backendUrl = resolveHyloBackendUrl();

export const config: VercelConfig = {
  buildCommand: "pnpm build",
  framework: "vite",
  outputDirectory: "dist",
  rewrites: [
    ...(backendUrl
      ? [
          routes.rewrite("/api/:path*", `${backendUrl}/:path*`),
          routes.rewrite(
            "/worker/:workerId/api/:path*",
            `${backendUrl}/workers/:workerId/api/:path*`,
          ),
        ]
      : []),
    routes.rewrite("/:path*", "/"),
  ],
};

function resolveHyloBackendUrl(): string | undefined {
  return explicitHyloBackendUrl() ?? previewHyloBackendUrl();
}

function explicitHyloBackendUrl(): string | undefined {
  return firstEnv(["VITE_HYLO_BACKEND_URL", "HYLO_BACKEND_URL"]);
}

function previewHyloBackendUrl(): string | undefined {
  const template = firstEnv([
    "VITE_HYLO_BACKEND_PREVIEW_URL_TEMPLATE",
    "HYLO_BACKEND_PREVIEW_URL_TEMPLATE",
  ]);
  const branch = firstEnv([
    "VITE_VERCEL_GIT_COMMIT_REF",
    "VERCEL_GIT_COMMIT_REF",
    "GITHUB_HEAD_REF",
  ]);
  if (!template || !branch) return undefined;
  return template.replaceAll("{branch}", previewAlias(branch));
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value.replace(/\/+$/, "");
  }
  return undefined;
}

function previewAlias(branch: string): string {
  const normalized = branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return normalized || "preview";
}
