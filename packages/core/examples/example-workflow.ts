import { z } from "zod";
import { atom, input, secret } from "../src/index";

export const provider = input(
  "provider",
  z.object({
    name: z
      .string()
      .default("Acme MCP")
      .describe("Provider name used in deploy steps and logs."),
    openapiUrl: z
      .string()
      .optional()
      .describe(
        "OpenAPI URL used when onboarding through the dispatch-worker path.",
      ),
    mcpUrl: z
      .string()
      .optional()
      .describe("MCP endpoint used for DCR or OAuth proxy deployment paths."),
    hasDcr: z
      .boolean()
      .default(true)
      .describe(
        "Whether the MCP endpoint supports dynamic client registration.",
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
    clientId: z.string().describe("OAuth client_id issued for this provider."),
    clientSecret: z
      .string()
      .describe("OAuth client_secret issued for this provider."),
  }),
  {
    title: "Add OAuth credentials",
    description:
      "OAuth credentials supplied after static registration when DCR is unavailable.",
  },
);

export const overlayReview = input.deferred(
  "overlayReview",
  z.object({
    approved: z
      .boolean()
      .describe(
        "Whether the generated OpenAPI overlay is approved for deployment.",
      ),
    strippedPaths: z
      .array(z.string())
      .optional()
      .describe("Optional JSON pointer–style paths removed before deployment."),
  }),
  {
    title: "Review the API overlay",
    description: "Human review gate before applying the OpenAPI overlay.",
  },
);

export const prodApproval = input.deferred(
  "prodApproval",
  z.object({
    approved: z
      .boolean()
      .describe("Whether production deployment is approved."),
    changeTicket: z
      .string()
      .describe(
        "Change ticket or audit code captured with the production approval.",
      ),
  }),
  {
    title: "Approve production deploy",
    description: "Final approval gate before production deployment.",
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
    return {
      action: "publish-dcr",
      provider: p.name,
      mcpUrl: p.mcpUrl,
    };
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
      provider: p.name,
      mcpUrl: p.mcpUrl,
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
    return {
      action: "build-spec",
      provider: p.name,
      openapiUrl: p.openapiUrl,
    };
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
      strippedPaths: review.strippedPaths ?? [],
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
    return {
      action: "scan-tools",
      provider: deployed.provider,
      namespace: deployed.namespace,
      discovered: ["search", "fetch", "authorize"],
    };
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
      audit: approval.changeTicket,
      credential: "prodDeployToken",
    };
  },
  { name: "deployProd" },
);
