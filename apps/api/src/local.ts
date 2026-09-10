import app from "./index.js";
import { serve } from "@hono/node-server";

const port = Number(process.env.PORT ?? 8787);
console.log(`[talkflow-api] free router + chat on http://localhost:${port}`);
console.log(`[talkflow-api] health: http://localhost:${port}/api/health`);
serve({ fetch: app.fetch, port });
