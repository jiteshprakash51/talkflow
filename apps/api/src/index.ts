import { Hono } from "hono";
import { cors } from "hono/cors";
import { chat, freeProvidersStatus, type RouterEnv } from "@talkflow/llm-router";
import { PLANNER_SYSTEM, EXPLAINER_SYSTEM, CHAT_SYSTEM, CONNECTOR_SYSTEM } from "@talkflow/prompts";
import { safeParsePlan, uid } from "@talkflow/db";
import { runStep, type FlowStep } from "@talkflow/connectors";
import { storeFor, limitsOf, ensureSchemaD1, type D1Like } from "./lib/store.js";
import { googleAuthUrl, exchangeCode, refreshAccessToken, googleEnv } from "./lib/google.js";
import { TEMPLATES, findTemplate } from "./lib/templates.js";

type Bindings = {
  DB?: D1Like;
  RUN_QUEUE?: { send(msg: unknown): Promise<void> };
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  GROQ_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  GEMINI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  OLLAMA_BASE_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  MAX_CHATS_PER_USER_PER_DAY?: string;
  MAX_RUNS_PER_USER_PER_DAY?: string;
  CRON_SECRET?: string;
};

type Ctx = { env: Bindings };

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", cors());

/** D1 in cloud, JSON file locally — same API either way. */
function storeOf(c: Ctx) {
  return storeFor(c.env.DB, c.env as unknown as Record<string, string | undefined>);
}

function envStr(c: Ctx, key: keyof Bindings): string {
  return (c.env[key] as string | undefined) ?? (process.env[key as string] ?? "");
}

function routerEnv(c: Ctx): RouterEnv {
  return {
    GROQ_API_KEY: envStr(c, "GROQ_API_KEY") || undefined,
    CEREBRAS_API_KEY: envStr(c, "CEREBRAS_API_KEY") || undefined,
    GEMINI_API_KEY: envStr(c, "GEMINI_API_KEY") || undefined,
    MISTRAL_API_KEY: envStr(c, "MISTRAL_API_KEY") || undefined,
    NVIDIA_API_KEY: envStr(c, "NVIDIA_API_KEY") || undefined,
    OPENROUTER_API_KEY: envStr(c, "OPENROUTER_API_KEY") || undefined,
    OLLAMA_BASE_URL: envStr(c, "OLLAMA_BASE_URL") || "http://localhost:11434",
    AI: c.env.AI as RouterEnv["AI"],
  };
}

function isCommand(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (/^(templates?|ideas?|examples?)$/.test(t)) return "templates";
  if (/^(list|show).*(template|idea|example)/.test(t)) return "templates";
  if (/^(list|show)(\s|$)/.test(t)) return "list";
  if (/connect\s+(gmail|google|sheets)/.test(t)) return "connect-google";
  if (/connect\s+whatsapp/.test(t)) return "connect-whatsapp";
  if (/^(stop|pause|disable)/.test(t)) return "stop";
  if (/^(run|start|trigger)/.test(t)) return "run";
  if (/^(why|what).*(fail|error|wrong)/.test(t)) return "explain-fail";
  if (/^(ok|yes|confirm|start it|do it)/.test(t)) return "confirm";
  return null;
}

// ---- Google token with auto-refresh ----
async function googleAccessToken(c: Ctx, userId: string): Promise<string | undefined> {
  const store = storeOf(c);
  const conn = await store.getConnection(userId, "google");
  if (!conn) return undefined;
  try {
    const secret = JSON.parse(conn.secret_json) as {
      access_token: string;
      refresh_token?: string;
      expires_at?: number;
    };
    if (secret.expires_at && Date.now() < secret.expires_at - 60_000) return secret.access_token;
    if (!secret.refresh_token) return secret.access_token;
    const fresh = await refreshAccessToken(c.env as Record<string, string | undefined>, secret.refresh_token);
    const next = {
      ...secret,
      access_token: fresh.access_token,
      expires_at: Date.now() + fresh.expires_in * 1000,
    };
    await store.saveConnection({ ...conn, secret_json: JSON.stringify(next), created_at: Date.now() });
    return next.access_token;
  } catch {
    return undefined;
  }
}

interface PlanResult {
  reply_en: string;
  needs_confirm?: boolean;
  provider?: string;
  flow_id?: string;
  plan?: unknown;
}

/**
 * Fire a flow run. Queue when available (Cloudflare); on serverless (Vercel)
 * the runtime freezes after the response, so the run MUST be awaited inline.
 * Local dev stays fire-and-forget for snappy chat.
 */
async function dispatchRun(c: Ctx, flowId: string, userId: string): Promise<void> {
  if (c.env.RUN_QUEUE) {
    await c.env.RUN_QUEUE.send({ flow_id: flowId, user_id: userId }).catch(() => {});
    return;
  }
  if (process.env.VERCEL) {
    await runFlowLocal(flowId, userId, c);
    return;
  }
  void runFlowLocal(flowId, userId, c);
}

/** Shared due-tick predicate for Cloudflare cron and the Vercel /api/cron route. */
function isFlowDue(triggerDesc: string, now: Date): boolean {
  const t = triggerDesc.toLowerCase();
  const mins = now.getMinutes();
  if (/hourly|every hour/.test(t)) return true;
  if (/morn|daily|every day/.test(t) && now.getHours() === 8 && mins < 5) return true;
  return /manual|telegram|whatsapp/.test(t) ? false : mins < 5;
}

// Shared brain: PWA + Telegram + WhatsApp all call this.
async function handleNaturalText(c: Ctx, text: string, userId: string, via: string): Promise<PlanResult> {
  const store = storeOf(c);
  const cmd = isCommand(text);
  const overQuota = await store.checkAndTrackChat(userId);
  if (overQuota) return { reply_en: overQuota };
  await store.addMessage({ id: uid("msg"), user_id: userId, role: "user", text: text.slice(0, 2000), created_at: Date.now() });
  const finish = async (reply_en: string, extra: Partial<PlanResult> = {}): Promise<PlanResult> => {
    await store.addMessage({ id: uid("msg"), user_id: userId, role: "assistant", text: reply_en.slice(0, 2000), created_at: Date.now() });
    return { reply_en, ...extra };
  };

  // Template store: "templates" lists, "use <name>" stages the plan
  if (cmd === "templates" || /^use\s+.+/.test(text.trim().toLowerCase())) {
    const found = findTemplate(text);
    if (found) {
      await store.setPending(
        { title_en: found.title_en, confirm_en: found.description_en, trigger_en: found.trigger_en, steps: found.steps },
        userId
      );
      return finish(`'${found.title_en}': ${found.description_en} Say 'ok' to start it.`, { needs_confirm: true });
    }
    return finish(
      `Ready-made automations: ${TEMPLATES.map((x) => `${x.title_en} (say '${x.say_to_use_en}')`).join("; ")}.`
    );
  }

  if (cmd === "list") {
    const flows = (await store.listFlows()).slice(0, 10);
    if (!flows.length)
      return finish("You have no automations yet. Say for example: every morning summarize my Gmail to Telegram.");
    return finish(
      `You have ${flows.length} automation${flows.length > 1 ? "s" : ""}: ${flows.map((f) => `${f.title_en} (${f.status})`).join("; ")}. Say 'run ...' or 'stop ...' with the name.`
    );
  }

  if (cmd === "connect-google") {
    const { clientId } = googleEnv(c.env as Record<string, string | undefined>);
    if (!clientId) return finish("Google login isn't set up on this server yet. The owner needs to add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, then you say 'connect gmail' again.");
    const url = googleAuthUrl(c.env as Record<string, string | undefined>, userId);
    return finish(`To read Gmail and save to Sheets, open this link once and approve: ${url} Then tell me what to automate.`);
  }

  if (cmd === "connect-whatsapp") {
    const hasToken = !!envStr(c, "WHATSAPP_TOKEN");
    if (!hasToken) return finish("WhatsApp sending isn't set up on this server yet (needs WHATSAPP_TOKEN). Telegram works today — say hello to the Telegram bot instead.");
    return finish("WhatsApp is connected on the server. Tell me the number with country code, like: send a hello to 15551234567 on WhatsApp.");
  }

  if (cmd === "confirm") {
    const pending = (await store.takePending(userId)) as {
      title_en: string;
      steps: FlowStep[];
      trigger_en: string;
    } | undefined;
    if (!pending) return finish("Nothing waiting for confirmation. Tell me what to automate first.");
    const id = uid("flow");
    await store.saveFlow({
      id, user_id: userId, title_en: pending.title_en,
      trigger_desc: pending.trigger_en ?? "manual",
      steps_json: JSON.stringify(pending.steps ?? []),
      status: "active", created_via: via, created_at: Date.now(),
    });
    await dispatchRun(c, id, userId);
    return finish(`Done! '${pending.title_en}' is now running. Say 'list' anytime to see it.`, { flow_id: id });
  }

  if (cmd === "stop" || cmd === "run") {
    const flows = await store.listFlows();
    const target =
      flows.find((f) => text.toLowerCase().includes(f.title_en.toLowerCase().split(" ")[0])) ?? flows[0];
    if (!target) return finish("No automation found yet. Tell me what to build first.");
    await store.setFlowStatus(target.id, cmd === "stop" ? "paused" : "active");
    if (cmd === "run") await dispatchRun(c, target.id, target.user_id);
    return finish(
      cmd === "stop"
        ? `'${target.title_en}' paused. Say 'run ${target.title_en}' to resume.`
        : `'${target.title_en}' started. I'll tell you what happens.`
    );
  }

  if (cmd === "explain-fail") {
    const runs = await store.listRuns();
    const lastFail = runs.find((r) => r.status === "error");
    if (!lastFail) return finish("No recent failures. Everything looks good.");
    return finish(`Last trouble: ${lastFail.error_en} Say 'run' to retry, or tell me what changed.`);
  }

  // Otherwise: plan with free LLM + conversation memory
  const renv = routerEnv(c);
  const history = (await store.recentMessages(userId, 6)).map((m) => ({
    role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
    content: m.text,
  }));
  try {
    const connectors = (await store.listConnectors()).slice(0, 10);
    const customHint = connectors.length
      ? `\nCustom connectors available (tool=custom, args.connector=<name>): ${connectors.map((x) => `${x.name}: ${x.description_en}`).join(" | ")}`
      : "";
    const { text: raw, provider } = await chat(renv, [
      { role: "system", content: PLANNER_SYSTEM + customHint },
      ...history.slice(0, -1),
      { role: "user", content: text },
    ]);
    await store.trackProvider(provider);
    let plan;
    try {
      plan = safeParsePlan(raw);
    } catch {
      const convo = await chat(renv, [
        { role: "system", content: CHAT_SYSTEM },
        ...history,
      ]);
      await store.trackProvider(convo.provider);
      return finish(convo.text, { provider: convo.provider });
    }
    if (!plan.steps.length) return finish(plan.confirm_en, { provider });
    await store.setPending(plan, userId);
    const stepsEn = plan.steps.map((s, i) => `${i + 1}. ${s.say_en}`).join(" ");
    return finish(`Here's my plan for '${plan.title_en}': ${stepsEn} Say 'ok' to start it.`, {
      needs_confirm: true, provider, plan,
    });
  } catch (e) {
    return {
      reply_en: `My free AI helpers are all busy right now. Try again in a minute, or run Ollama locally for unlimited use. (${(e as Error).message.slice(0, 120)})`,
    };
  }
}

app.get("/api/health", (c) => {
  const env = c.env as unknown as Record<string, string | undefined>;
  const store = c.env.DB ? "d1" : env.TURSO_DATABASE_URL ?? process.env.TURSO_DATABASE_URL ? "turso" : "file";
  return c.json({ ok: true, service: "talkflow-api", store, free: freeProvidersStatus(routerEnv(c)) });
});

app.get("/api/usage", async (c) => {
  const store = storeOf(c);
  const userId = c.req.query("user_id") ?? "local";
  const limits = limitsOf(c.env as unknown as Record<string, string | undefined>);
  return c.json({
    ok: true,
    spent_usd: 0,
    note: "TalkFlow only uses free tiers + local Ollama. $0 by design.",
    providers: freeProvidersStatus(routerEnv(c)),
    calls_today_by_provider: await store.providerUsageToday(),
    you_today: await store.userUsageToday(userId),
    limits: {
      chats_per_user_per_day: limits.maxChats,
      runs_per_user_per_day: limits.maxRuns,
    },
    connections: await store.listConnections(),
    custom_connectors: (await store.listConnectors()).length,
  });
});

// ---- Template store ----
app.get("/api/templates", (c) =>
  c.json({
    ok: true,
    templates: TEMPLATES.map((t) => ({
      id: t.id, title_en: t.title_en, description_en: t.description_en, say_to_use_en: t.say_to_use_en,
    })),
  })
);

app.post("/api/templates/:id/use", async (c) => {
  const store = storeOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { user_id?: string };
  const userId = body.user_id ?? "local";
  const t = TEMPLATES.find((x) => x.id === c.req.param("id"));
  if (!t) return c.json({ ok: false, reply_en: "Template not found. Say 'templates' to see what's ready." }, 404);
  await store.setPending(
    { title_en: t.title_en, confirm_en: t.description_en, trigger_en: t.trigger_en, steps: t.steps },
    userId
  );
  return c.json({ ok: true, reply_en: `'${t.title_en}': ${t.description_en} Say 'ok' to start it.`, needs_confirm: true });
});

// ---- Chat ----
app.post("/api/chat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string; user_id?: string };
  const text = (body.text ?? "").trim();
  const userId = body.user_id ?? "local";
  if (!text)
    return c.json({ ok: false, reply_en: "Say what you want to automate, for example: every morning send my Gmail summary to Telegram." }, 400);
  const out = await handleNaturalText(c, text, userId, "pwa");
  return c.json({ ok: true, ...out });
});

// ---- Flows ----
app.get("/api/flows", async (c) => c.json({ ok: true, flows: await storeOf(c).listFlows() }));
app.post("/api/flows/:id/run", async (c) => {
  const id = c.req.param("id");
  const flow = await storeOf(c).getFlow(id);
  if (!flow) return c.json({ ok: false, reply_en: "Automation not found." }, 404);
  await dispatchRun(c, id, flow.user_id);
  return c.json({ ok: true, reply_en: `'${flow.title_en}' started.` });
});
app.post("/api/flows/:id/stop", async (c) => {
  await storeOf(c).setFlowStatus(c.req.param("id"), "paused");
  return c.json({ ok: true, reply_en: "Paused." });
});
app.get("/api/runs", async (c) => {
  const flowId = c.req.query("flow_id");
  return c.json({ ok: true, runs: (await storeOf(c).listRuns(flowId)).slice(0, 30) });
});

// ---- Google OAuth ----
app.get("/api/auth/google/url", (c) => {
  const userId = c.req.query("user_id") ?? "local";
  const { clientId } = googleEnv(c.env as Record<string, string | undefined>);
  if (!clientId) return c.json({ ok: false, reply_en: "GOOGLE_CLIENT_ID not set on server." }, 500);
  return c.json({ ok: true, url: googleAuthUrl(c.env as Record<string, string | undefined>, userId) });
});

app.get("/api/auth/google/callback", async (c) => {
  const store = storeOf(c);
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "local";
  if (!code) return c.text("Missing ?code= — start again with 'connect gmail'.", 400);
  try {
    const tok = await exchangeCode(c.env as Record<string, string | undefined>, code);
    await store.saveConnection({
      id: uid("conn"), user_id: state, provider: "google", label: "Gmail + Sheets",
      secret_json: JSON.stringify({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: Date.now() + tok.expires_in * 1000,
      }),
      created_at: Date.now(),
    });
    return c.text("Connected! You can close this tab and say 'every morning summarize my Gmail' in TalkFlow.");
  } catch (e) {
    return c.text(`Google said no: ${(e as Error).message}. Try 'connect gmail' again.`, 502);
  }
});

app.get("/api/connections", async (c) => {
  const userId = c.req.query("user_id") ?? undefined;
  // Never expose secrets — only provider + label
  return c.json({ ok: true, connections: await storeOf(c).listConnections(userId) });
});

app.delete("/api/connections/:provider", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { user_id?: string };
  await storeOf(c).deleteConnection(body.user_id ?? "local", c.req.param("provider"));
  return c.json({ ok: true, reply_en: "Disconnected." });
});

// ---- AI connector generator ----
app.get("/api/connectors", async (c) => {
  const list = (await storeOf(c).listConnectors()).map((x) => ({
    id: x.id, name: x.name, description_en: x.description_en, base_url: x.base_url,
    spec: JSON.parse(x.spec_json),
  }));
  return c.json({ ok: true, connectors: list });
});

app.post("/api/connectors/generate", async (c) => {
  const store = storeOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    openapi_url?: string; docs_text?: string; auth_token?: string;
  };
  let docs = (body.docs_text ?? "").slice(0, 15000);
  if (body.openapi_url) {
    if (!body.openapi_url.startsWith("http")) return c.json({ ok: false, reply_en: "Give a full https address for the OpenAPI file." }, 400);
    try {
      const res = await fetch(body.openapi_url);
      if (!res.ok) return c.json({ ok: false, reply_en: `That address answered ${res.status}. Paste the docs text instead.` }, 400);
      docs = (await res.text()).slice(0, 15000);
    } catch {
      return c.json({ ok: false, reply_en: "I couldn't fetch that address. Paste the docs text instead." }, 400);
    }
  }
  if (!docs) return c.json({ ok: false, reply_en: "Paste API docs or give an OpenAPI URL, and I'll build the connector." }, 400);
  try {
    const renv = routerEnv(c);
    const { text: raw, provider } = await chat(renv, [
      { role: "system", content: CONNECTOR_SYSTEM },
      { role: "user", content: `Build a connector from these docs:\n${docs}` },
    ]);
    await store.trackProvider(provider);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as {
      name: string; description_en: string; base_url: string;
      actions: Array<{ name: string; method: string; path: string; description_en: string }>;
      auth?: { type: string };
    };
    if (!obj.name || !obj.base_url?.startsWith("http") || !Array.isArray(obj.actions)) {
      throw new Error("bad shape");
    }
    const id = uid("con");
    await store.saveConnector({
      id, name: obj.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
      description_en: obj.description_en ?? "", base_url: obj.base_url,
      spec_json: JSON.stringify({ actions: obj.actions.slice(0, 4), auth: obj.auth ?? { type: "none" }, auth_token: body.auth_token ?? "" }),
      created_at: Date.now(),
    });
    return c.json({
      ok: true, provider,
      reply_en: `Built connector '${obj.name}' with ${obj.actions.length} actions. Say: use ${obj.name} to ...`,
      connector: obj,
    });
  } catch (e) {
    return c.json({ ok: false, reply_en: `I couldn't understand those docs yet. Paste a shorter section, ideally the OpenAPI paths. (${(e as Error).message.slice(0, 100)})` }, 502);
  }
});

// ---- Vercel Cron: GET /api/cron?secret=... (runs due flows inline) ----
app.get("/api/cron", async (c) => {
  const expected = envStr(c, "CRON_SECRET");
  if (!expected || c.req.query("secret") !== expected) return c.text("forbidden", 403);
  const store = storeOf(c);
  const now = new Date();
  const due = (await store.listFlows())
    .filter((f) => f.status === "active" && isFlowDue(f.trigger_desc, now))
    .slice(0, 5);
  const ran: string[] = [];
  for (const f of due) {
    await runFlowLocal(f.id, f.user_id, c);
    ran.push(f.id);
  }
  return c.json({ ok: true, ran });
});

// ---- Telegram webhook ----
app.post("/api/bot/telegram", async (c) => {
  const update = (await c.req.json().catch(() => ({}))) as {
    message?: { chat?: { id?: number }; text?: string };
  };
  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim() ?? "";
  const token = envStr(c, "TELEGRAM_BOT_TOKEN");
  if (!chatId || !text) return c.json({ ok: true });
  if (!token) return c.json({ ok: true, note: "TELEGRAM_BOT_TOKEN not set" });
  const out = await handleNaturalText(c, text, `tg:${chatId}`, "telegram");
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: out.reply_en.slice(0, 4000) }),
  }).catch(() => {});
  return c.json({ ok: true });
});

// ---- WhatsApp webhook (Meta Cloud API, free tier) ----
app.get("/api/bot/whatsapp", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge") ?? "";
  const expected = envStr(c, "WHATSAPP_VERIFY_TOKEN") || "talkflow";
  if (mode === "subscribe" && token === expected) return c.text(challenge);
  return c.text("forbidden", 403);
});

async function whatsappSend(c: Ctx, to: string, text: string): Promise<void> {
  const token = envStr(c, "WHATSAPP_TOKEN");
  const phoneId = envStr(c, "WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneId) return;
  await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000) } }),
  }).catch(() => {});
}

app.post("/api/bot/whatsapp", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from?: string; text?: { body?: string } }> } }> }>;
  };
  const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = msg?.from ?? "";
  const text = msg?.text?.body?.trim() ?? "";
  if (!from || !text) return c.json({ ok: true });
  const out = await handleNaturalText(c, text, `wa:${from}`, "whatsapp");
  await whatsappSend(c, from, out.reply_en);
  return c.json({ ok: true });
});

async function runFlowLocal(flowId: string, userId: string, c: Ctx): Promise<void> {
  const store = storeOf(c);
  const flow = await store.getFlow(flowId);
  if (!flow || flow.status !== "active") return;
  const blocked = await store.checkAndTrackRun(userId);
  if (blocked) {
    await store.addRun({
      id: uid("run"), flow_id: flowId, status: "error",
      output_summary_en: blocked, error_en: blocked,
      provider: "quota", created_at: Date.now(),
    });
    return;
  }
  const steps = JSON.parse(flow.steps_json) as FlowStep[];
  const googleToken = await googleAccessToken(c, userId).catch(() => undefined);
  const parts: string[] = [];
  let okAll = true;
  for (const s of steps) {
    if (s.tool === "schedule") {
      parts.push(s.say_en);
      continue;
    }
    const custom = s.tool === "custom" ? await store.getConnector(s.args.connector ?? "") : undefined;
    const r = await runStep(s, {
      TELEGRAM_BOT_TOKEN: envStr(c, "TELEGRAM_BOT_TOKEN") || undefined,
      GOOGLE_ACCESS_TOKEN: googleToken,
      WHATSAPP_TOKEN: envStr(c, "WHATSAPP_TOKEN") || undefined,
      WHATSAPP_PHONE_NUMBER_ID: envStr(c, "WHATSAPP_PHONE_NUMBER_ID") || undefined,
      CUSTOM_CONNECTOR: custom
        ? { base_url: custom.base_url, spec: JSON.parse(custom.spec_json) }
        : undefined,
    });
    parts.push(r.summary_en);
    if (!r.ok) {
      okAll = false;
      const retry = await runStep(s, {
        TELEGRAM_BOT_TOKEN: envStr(c, "TELEGRAM_BOT_TOKEN") || undefined,
        GOOGLE_ACCESS_TOKEN: await googleAccessToken(c, userId).catch(() => undefined),
        WHATSAPP_TOKEN: envStr(c, "WHATSAPP_TOKEN") || undefined,
        WHATSAPP_PHONE_NUMBER_ID: envStr(c, "WHATSAPP_PHONE_NUMBER_ID") || undefined,
        CUSTOM_CONNECTOR: custom
          ? { base_url: custom.base_url, spec: JSON.parse(custom.spec_json) }
          : undefined,
      });
      parts.push(`Retry: ${retry.summary_en}`);
      if (!retry.ok) break;
      else okAll = true;
    }
  }
  const summary = parts.join(" ");
  let friendly = summary;
  try {
    const out = await chat(routerEnv(c), [
      { role: "system", content: EXPLAINER_SYSTEM },
      { role: "user", content: `Flow '${flow.title_en}' finished. Details: ${summary}` },
    ]);
    await store.trackProvider(out.provider);
    friendly = out.text;
  } catch { /* keep raw summary if LLM down */ }
  await store.addRun({
    id: uid("run"), flow_id: flowId, status: okAll ? "ok" : "error",
    output_summary_en: friendly, error_en: okAll ? "" : summary.slice(0, 500),
    provider: "router", created_at: Date.now(),
  });
}

// Cloudflare: scheduled cron + queue consumer
export async function scheduled(env: Bindings): Promise<void> {
  if (env.DB) await ensureSchemaD1(env.DB).catch(() => {});
  const store = storeFor(env.DB, env as unknown as Record<string, string | undefined>);
  const flows = (await store.listFlows()).filter((f) => f.status === "active");
  const now = new Date();
  const due = flows.filter((f) => isFlowDue(f.trigger_desc, now));
  for (const f of due.slice(0, 5)) {
    if (env.RUN_QUEUE) await env.RUN_QUEUE.send({ flow_id: f.id, user_id: f.user_id }).catch(() => {});
  }
}

export async function queueBatch(
  messages: Array<{ body: { flow_id: string; user_id?: string } }>,
  env: Bindings
): Promise<void> {
  const store = storeFor(env.DB, env as unknown as Record<string, string | undefined>);
  for (const m of messages) {
    const flow = await store.getFlow(m.body.flow_id);
    await runFlowLocal(m.body.flow_id, m.body.user_id ?? flow?.user_id ?? "local", { env });
  }
}

export default {
  fetch: app.fetch,
  scheduled(_event: unknown, env: Bindings) {
    return scheduled(env);
  },
  async queue(batch: { messages: Array<{ body: { flow_id: string; user_id?: string } }> }, env: Bindings) {
    return queueBatch(batch.messages, env);
  },
};

// Named export for the Vercel adapter (api/[[...route]].ts). Workers use default.
export { app };

// Re-exports so tests exercise the production bundle (esbuild flattens dist/).
export { TursoStore } from "./lib/store-turso.js";
export { storeFor, limitsOf } from "./lib/store.js";
export { uid };
