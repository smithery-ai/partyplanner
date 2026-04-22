import { defineConfig } from "@workflow/cli";

export default defineConfig({
  name: "__APP_NAME__",
  main: "src/index.ts",
  compatibilityDate: "2026-04-19",
  compatibilityFlags: ["global_fetch_strictly_public"],
  vars: {
    // HYLO_BACKEND_URL: "https://your-backend.example.com",
  },
  // For Cloudflare Workers for Platforms, set the dispatch namespace:
  // dispatchNamespace: "my-namespace",
});
