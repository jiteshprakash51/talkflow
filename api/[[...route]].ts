// Vercel serverless entry — mounts the same Hono app as Cloudflare Workers.
// Runs on Node.js (not edge): keeps process.env access for secrets.
// Frontend (apps/web/dist) is served statically; /api/* lands here.

import { handle } from "hono/vercel";
import { app } from "../apps/api/dist/index.js";

// Hobby: 10s default, raisable to 60s in dashboard. AI planning + inline
// runs need headroom — 60s max on hobby.
export const maxDuration = 60;

const handler = handle(app);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
