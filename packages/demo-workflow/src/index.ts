import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

export const provider = input(
  "provider",
  z.object({
    name: z
      .string()
      .default("Acme MCP")
      .describe("Display name used in deploy actions and logs."),
    openapiUrl: z
      .string()
      .optional()
      .describe(
        "OpenAPI URL for the dispatch-worker path when MCP-based routes are not used.",
      ),
    mcpUrl: z
      .string()
      .default("https://mcp.acme.dev")
      .describe("MCP server URL for OAuth or DCR proxy paths."),
    hasDcr: z
      .boolean()
      .default(true)
      .describe(
        "Whether Dynamic Client Registration is available at the MCP endpoint.",
      ),
  }),
  {
    title: "Onboard a provider",
    description: "Connection details for the provider you are onboarding.",
  },
);

export const oauthCreds = input.deferred(
  "oauthCreds",
  z.object({
    clientId: z
      .string()
      .describe("OAuth client_id issued for this MCP deployment."),
    clientSecret: z
      .string()
      .describe(
        "OAuth client_secret; store and rotate outside this UI in production.",
      ),
  }),
  {
    title: "Add OAuth credentials",
    description:
      "Credentials after dynamic or static registration - required to deploy the OAuth proxy.",
  },
);

export const overlayReview = input.deferred(
  "overlayReview",
  z.object({
    approved: z
      .boolean()
      .describe(
        "Whether to apply the generated OpenAPI overlay to the dispatch worker.",
      ),
    strippedPaths: z
      .array(z.string())
      .optional()
      .describe(
        "JSON pointer-style paths to strip from the spec before deploy (optional).",
      ),
  }),
  {
    title: "Review the API overlay",
    description:
      "Human review gate before applying the OpenAPI overlay in the dispatch path.",
  },
);

export const prodApproval = input.deferred(
  "prodApproval",
  z.object({
    approved: z
      .boolean()
      .describe("Whether to promote the tested deployment to production."),
    confirmCode: z
      .string()
      .describe(
        "Typed confirmation (e.g. ticket or environment code) for audit trail.",
      ),
  }),
  {
    title: "Approve production deploy",
    description:
      "Final sign-off before production deploy - separate from overlay review.",
  },
);

export const prodDeployToken = secret("PROD_DEPLOY_TOKEN", undefined, {
  description:
    "Deployment token required by the final production promotion step.",
  errorMessage:
    "Provide PROD_DEPLOY_TOKEN by passing it as the secret value in this workflow definition.",
});

export const assess = atom(
  (get) => {
    const p = get(provider);
    if (p.mcpUrl && p.hasDcr) return "dcr-proxy";
    if (p.mcpUrl && !p.hasDcr) return "oauth-proxy";
    if (p.openapiUrl) return "dispatch-worker";
    return "blocked";
  },
  { name: "assess" },
);

export const dcrProxy = atom(
  (get) => {
    const path = get(assess);
    if (path !== "dcr-proxy")
      return get.skip("Assessment selected a non-DCR proxy path");
    const p = get(provider);
    return { action: "publish-dcr", mcpUrl: p.mcpUrl, provider: p.name };
  },
  { name: "dcrProxy" },
);

export const oauthProxy = atom(
  (get) => {
    const path = get(assess);
    if (path !== "oauth-proxy")
      return get.skip("Assessment selected a non-OAuth proxy path");
    const p = get(provider);
    const creds = get(oauthCreds);
    return {
      action: "deploy-oauth-proxy",
      mcpUrl: p.mcpUrl,
      provider: p.name,
      creds,
    };
  },
  { name: "oauthProxy" },
);

export const buildSpec = atom(
  (get) => {
    const path = get(assess);
    if (path !== "dispatch-worker")
      return get.skip("Assessment selected a non-dispatch-worker path");
    const p = get(provider);
    return { action: "build-spec", openapiUrl: p.openapiUrl, provider: p.name };
  },
  { name: "buildSpec" },
);

export const applyOverlay = atom(
  (get) => {
    const spec = get(buildSpec);
    const review = get(overlayReview);
    if (!review.approved) return get.skip("Overlay review was not approved");
    return {
      action: "apply-overlay",
      provider: spec.provider,
      strippedPaths: review.strippedPaths,
    };
  },
  { name: "applyOverlay" },
);

export const deployTest = atom(
  (get) => {
    const overlay = get(applyOverlay);
    return {
      action: "deploy-test",
      provider: overlay.provider,
      namespace: "test",
    };
  },
  { name: "deployTest" },
);

export const scanTools = atom(
  (get) => {
    const deployed = get(deployTest);
    return { action: "scan-tools", provider: deployed.provider };
  },
  { name: "scanTools" },
);

export const deployProd = atom(
  (get) => {
    const path = get(assess);
    const target =
      path === "dcr-proxy"
        ? get(dcrProxy)
        : path === "oauth-proxy"
          ? get(oauthProxy)
          : path === "dispatch-worker"
            ? get(scanTools)
            : get.skip("No deployable integration path was selected");
    const approval = get(prodApproval);
    if (!approval.approved)
      return get.skip("Production approval was not granted");
    const deployToken = get(prodDeployToken);
    if (deployToken.trim().length === 0)
      throw new Error("Production deployment token was not provided");
    return {
      action: "deploy-prod",
      provider: target.provider,
      credential: "prodDeployToken",
    };
  },
  { name: "deployProd" },
);
