// Internal SRE monitoring workflow. Dispatches a Flamecast cloud agent on a
// schedule to investigate connect/gateway, then resumes when the agent posts
// findings back to /webhooks. Deploy via `pnpm hylo deploy apps/sre-monitor`.
export * from "./sreMonitorAgent";
