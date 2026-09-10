# 💬 TalkFlow — just say it. $0 automation.

Free, natural-language successor to n8n. No canvas unless you ask. Chat / voice / Telegram first.

## 60-second start (100% free, local)

```powershell
cp .dev.vars.example .dev.vars
# optional: add GROQ_API_KEY (console.groq.com, free, no card) for fastest brain
docker compose up --build
# web: http://localhost:5173   api: http://localhost:8787/api/health
# first Ollama pull (unlimited local fallback):
docker exec talkflow-ollama-1 ollama pull qwen2.5:7b
```

Or without Docker:

```powershell
npm install
npm run build
npm run dev:api   # http://localhost:8787
npm run dev:web   # http://localhost:5173 (needs VITE_API_URL=http://localhost:8787 or proxy)
```

## Try it (PWA + Telegram + WhatsApp — same brain)

1. `connect gmail` → open the Google link once, approve (Gmail read + Sheets write only)
2. `every morning send my Gmail summary to Telegram here`
3. Bot replies with plan → `ok` → running. `list` → see flows. `stop morning summary` → pause. `why did last run fail?` → plain-English diagnosis.

Voice: tap 🎤 in PWA, speak, hear the reply. WhatsApp: message the connected number, same commands work.

## Free brain (router order)

`Groq → Cerebras → Gemini Flash → Mistral → NVIDIA NIM → OpenRouter :free → Workers AI → Ollama local`
`GET /api/usage` shows `$0 spent` + which providers are configured. On 429 it fails over automatically.

Get free keys (all no-card): Groq `console.groq.com`, Cerebras `cloud.cerebras.ai`, Gemini `aistudio.google.com`, Mistral `console.mistral.ai`, NVIDIA `build.nvidia.com`, OpenRouter `openrouter.ai`.

## Telegram bot (free)

1. Talk to `@BotFather` → `/newbot` → copy token into `.dev.vars` as `TELEGRAM_BOT_TOKEN`
2. Local test: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-tunnel>/api/bot/telegram` (use `npx localtunnel --port 8787`)
3. Cloud: `npx wrangler d1 create talkflow` → paste id into `wrangler.jsonc` → `npm run deploy` → set webhook to `https://talkflow-api.<you>.workers.dev/api/bot/telegram`

## Google connect (free OAuth, real Gmail + Sheets)

1. Google Cloud console → new project → OAuth consent (External) → create OAuth client (Web) → redirect URI `http://localhost:8787/api/auth/google/callback` (and your worker URL for cloud)
2. Put id/secret in `.dev.vars` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
3. In TalkFlow say `connect gmail` or open `GET /api/auth/google/url?user_id=local`
4. Approve once → token stored locally, auto-refreshed. Say `every morning summarize my Gmail to Telegram` for real mail; `save it to my sheet <ID>` for real Sheets appends.

## WhatsApp bot (Meta free tier)

1. developers.facebook.com → create app → add WhatsApp → copy temporary `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` into `.dev.vars`
2. Webhook: `https://<you>/api/bot/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`
3. Message your test number from the dashboard, then chat: `list`, `every hour ping me here`. Note: Meta requires the user to message first within 24h (free tier rule).

## AI connectors (any API, no code)

PWA → “+ Build connector from API” → paste OpenAPI URL, or:

```powershell
Invoke-RestMethod http://localhost:8787/api/connectors/generate -Method Post -Body '{"openapi_url":"https://api.example.com/openapi.json"}' -ContentType "application/json"
```

Then: `use <name> to list items every morning`. `GET /api/connectors` lists what the AI built.

## Cloud free deploy

```powershell
npx wrangler d1 create talkflow
npx wrangler d1 execute talkflow --file=packages/db/migrations/0001_init.sql
npx wrangler d1 execute talkflow --file=packages/db/migrations/0002_connections.sql
npx wrangler d1 execute talkflow --file=packages/db/migrations/0003_pending_usage.sql
npm run deploy
```

In cloud the API uses D1 for everything (flows, runs, connections, pending plans, quotas) — `GET /api/health` reports `"store":"d1"`. Locally it uses a JSON file (`"store":"file"`). Same API either way; quotas read `MAX_*` from Worker vars in cloud, `.dev.vars` locally.

### Local Cloudflare testing (free, no login)

```powershell
npx wrangler d1 execute talkflow --local --file=packages/db/migrations/0001_init.sql
npx wrangler d1 execute talkflow --local --file=packages/db/migrations/0002_connections.sql
npx wrangler d1 execute talkflow --local --file=packages/db/migrations/0003_pending_usage.sql
npx wrangler dev --port 8788   # API on :8788 with store=d1
```

Note: `wrangler dev` without a Cloudflare login hangs on the remote Workers AI binding — temporarily remove the `"ai"` block from `wrangler.jsonc` for local runs (the router treats missing AI as unconfigured and fails over). Restore it before `npm run deploy`.

Uses Workers + Workflows + Queues + D1 + Workers AI free tiers. No VPS.

## Project map

* `apps/web` — React PWA chat + voice + flow cards + connections + runs + connector builder
* `apps/api` — Hono API: `/api/chat`, `/api/flows`, `/api/connections`, `/api/connectors/*`, `/api/auth/google/*`, `/api/bot/telegram`, `/api/bot/whatsapp`, scheduler + queue
* `packages/llm-router` — $0 failover router
* `packages/connectors` — schedule/http/real gmail/real sheets/telegram/whatsapp/custom
* `packages/db` — D1/SQLite schema + plan validation
* `workers/*` — docs; logic lives in single worker for 1-click deploy

## Templates, quotas, offline (Phase 3)

* Say `templates` anywhere (PWA, Telegram, WhatsApp) or tap “Use this” in the PWA — the plan is staged, say `ok` to start. `GET /api/templates`, `POST /api/templates/:id/use`.
* Free-tier caps: 100 chats + 25 runs per user/day (env `MAX_CHATS_PER_USER_PER_DAY`, `MAX_RUNS_PER_USER_PER_DAY`). Over the cap you get a plain-English “resets tomorrow” note — automations already running are unaffected until their next tick. `GET /api/usage?user_id=local` shows calls by provider + your usage + limits; the PWA shows a $0 dashboard.
* Offline: the PWA works without network (service worker shell) — messages queue in the browser and send when you're back.
