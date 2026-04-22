import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "nextjs.hylo.localhost",
    "*.nextjs.hylo.localhost",
    "nextjs.hylo.local",
    "*.nextjs.hylo.local",
  ],
  transpilePackages: ["@workflow/frontend", "@workflow/server"],
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
