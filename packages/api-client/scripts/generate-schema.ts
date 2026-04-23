import { mkdir, writeFile } from "node:fs/promises";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { createBackendOpenApiDocument } from "../../../apps/backend-cloudflare/src/app";

const outputUrl = new URL("../src/generated/schema.d.ts", import.meta.url);
const document = createBackendOpenApiDocument();
const ast = await openapiTS(document as Parameters<typeof openapiTS>[0]);
const source = `${COMMENT_HEADER}\n${astToString(ast)}`;

await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(outputUrl, source);
