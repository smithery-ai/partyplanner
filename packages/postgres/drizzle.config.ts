import { defineConfig } from "drizzle-kit";

const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error("POSTGRES_URL or DATABASE_URL is required");
}

export default defineConfig({
  schema: "./src/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
});
