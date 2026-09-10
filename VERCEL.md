# ▲ TalkFlow on Vercel (100% Vercel-hosted)

Same app, different adapters: the PWA builds to static files, the Hono API
runs as one serverless function (`api/[[...route]].ts`), and Turso (free,
SQLite-dialect) replaces D1. No code changes per deploy target — `storeFor`
picks Turso when `TURSO_DATABASE_URL` is set.

## What runs where

| Piece | Vercel form | Notes |
|---|---|---|
| PWA chat | Static (`apps/web/dist`) | Same-origin `/api/*` → serverless function |
| API | 1 Node function, `maxDuration: 60` | Same Hono app as Workers |
| DB | Turso free tier | Same SQL as D1 (SQLite dialect) |
| Scheduled flows | `GET /api/cron?secret=…` via cron-job.org free tier | Vercel's built-in cron is too limited on Hobby |
| AI brain | Free LLM keys (Groq/Gemini/…) | No Ollama in cloud — use a no-card key |

## 1. Database (once, ~3 min)

1. Sign up at `turso.tech` (free tier, no card) → `turso db create talkflow` → `turso db show talkflow` (copy URL) → `turso db tokens create talkflow` (copy token). Or do it in the dashboard.
2. Locally:
   ```powershell
   $env:TURSO_DATABASE_URL="libsql://...turso.io"
   $env:TURSO_AUTH_TOKEN="..."
   npm run db:migrate:turso
   ```

## 2. Deploy (once, ~5 min)

1. Push this repo to GitHub. In Vercel: Add New → Project → Import (root directory = repo root, defaults in `vercel.json` handle the rest).
2. Environment Variables (Production + Preview):
   ```
   TURSO_DATABASE_URL=libsql://...
   TURSO_AUTH_TOKEN=...
   GROQ_API_KEY=...            # console.groq.com, free, no card (or another free key)
   CRON_SECRET=<long random>   # protects /api/cron
   TELEGRAM_BOT_TOKEN=         # optional, @BotFather
   GOOGLE_CLIENT_ID=           # optional, real Gmail/Sheets
   GOOGLE_CLIENT_SECRET=
   GOOGLE_REDIRECT_URI=https://<your-app>.vercel.app/api/auth/google/callback
   WHATSAPP_TOKEN=             # optional
   WHATSAPP_PHONE_NUMBER_ID=
   WHATSAPP_VERIFY_TOKEN=talkflow
   MAX_CHATS_PER_USER_PER_DAY=100
   MAX_RUNS_PER_USER_PER_DAY=25
   ```
3. Deploy. Open `https://<your-app>.vercel.app` → say `templates` → `use morning digest` → `ok`.

## 3. Scheduled flows (free)

Vercel Hobby cron can't do 5-minute ticks, so use cron-job.org (free):
create a job every 5 minutes → `https://<your-app>.vercel.app/api/cron?secret=<CRON_SECRET>`.
It returns `{ ok, ran: [...] }`. Manual, Telegram and WhatsApp triggers work without cron.

## 4. Point the bots at Vercel

* Telegram: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/bot/telegram`
* WhatsApp webhook: `https://<your-app>.vercel.app/api/bot/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`.
* Google OAuth redirect must exactly match `GOOGLE_REDIRECT_URI` above.

## Limits to know (Hobby)

* Function timeout 10s default — `vercel.json` already raises it to 60s (hobby max). Long Gmail reads + slow free LLMs can still brush the ceiling; flows run inline (no queue on Vercel), so keep flows to a few fast steps.
* Cold starts add ~1-2s to the first chat after idle — normal, free-tier tradeoff.
* Turso free tier is generous for this workload (a few thousand rows); `/api/usage` shows your real consumption.
