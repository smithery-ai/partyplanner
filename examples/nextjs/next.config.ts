import path from "node:path";
import type { NextConfig } from "next";

const portlessOrigin = originHost(process.env.PORTLESS_URL);

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "nextjs.hylo.localhost",
    "*.nextjs.hylo.localhost",
    "nextjs.hylo.local",
    "*.nextjs.hylo.local",
    ...(portlessOrigin ? [portlessOrigin] : []),
  ],
  transpilePackages: ["@workflow/frontend", "@workflow/server"],
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;

function originHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}
