import { defineConfig } from "drizzle-kit";

const url = process.env.SQLITE_FILE;

if (!url) {
  throw new Error("SQLITE_FILE is required");
}

export default defineConfig({
  schema: "./src/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url: url.startsWith("file:") ? url : `file:${url}` },
});
