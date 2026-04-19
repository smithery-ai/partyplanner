import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite"],
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
