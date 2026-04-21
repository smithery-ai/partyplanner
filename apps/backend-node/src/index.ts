import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { localBackendPort } from "./config";

const app = createApp();
const port = Number(process.env.PORT ?? localBackendPort());

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Hylo Node backend listening on http://localhost:${info.port}`);
  },
);
