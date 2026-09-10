export interface FlowStep {
  tool: "schedule" | "http" | "gmail" | "sheets" | "telegram" | "whatsapp" | "custom";
  action: string;
  args: Record<string, string>;
  say_en: string;
}
export interface StepResult {
  ok: boolean;
  summary_en: string;
  data?: unknown;
}

export interface ConnectorEnv {
  TELEGRAM_BOT_TOKEN?: string;
  GOOGLE_ACCESS_TOKEN?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  CUSTOM_CONNECTOR?: { base_url: string; spec: CustomSpec };
  fetchFn?: typeof fetch;
}

export interface CustomSpec {
  actions: Array<{
    name: string;
    method: string;
    path: string;
    description_en: string;
  }>;
  auth?: { type: "none" | "bearer" | "query"; key_name?: string };
  auth_token?: string;
}

function b64urlDecode(s: string): string {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

export function decodeGmailBody(payload: { mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }> }): string {
  const walk = (p: typeof payload): string => {
    if (p?.body?.data && (p.mimeType?.startsWith("text/plain") || !p.parts)) return b64urlDecode(p.body.data);
    for (const part of p?.parts ?? []) {
      const t = walk(part as typeof payload);
      if (t) return t;
    }
    return "";
  };
  return walk(payload).slice(0, 2000);
}

/** Execute one planned step. All errors become plain-English results — never throw raw errors to users. */
export async function runStep(step: FlowStep, env: ConnectorEnv): Promise<StepResult> {
  const fetchFn = env.fetchFn ?? fetch;
  try {
    switch (step.tool) {
      case "schedule":
        return { ok: true, summary_en: `Will run ${step.args.when ?? step.say_en}.` };
      case "http": {
        const url = step.args.url ?? "";
        if (!url.startsWith("http")) return { ok: false, summary_en: "That web address looks incomplete. Say the full address starting with https." };
        const res = await fetchFn(url, {
          method: (step.args.method ?? "GET").toUpperCase(),
          headers: { "Content-Type": "application/json" },
          body: ["POST", "PUT", "PATCH"].includes((step.args.method ?? "GET").toUpperCase())
            ? step.args.body ?? "{}"
            : undefined,
        });
        const text = await res.text();
        return res.ok
          ? { ok: true, summary_en: `Checked the web address, got an answer (${text.slice(0, 200)}).`, data: text.slice(0, 2000) }
          : { ok: false, summary_en: `The web address answered with error ${res.status}. Say a different address or try later.` };
      }
      case "gmail": {
        if (!env.GOOGLE_ACCESS_TOKEN) {
          return { ok: true, summary_en: "Checked Gmail (demo mode — say 'connect gmail' to read real mail)." };
        }
        const query = step.args.query ?? "newer_than:1d";
        const max = Math.min(Number(step.args.max ?? 5) || 5, 10);
        const listRes = await fetchFn(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
          { headers: { Authorization: `Bearer ${env.GOOGLE_ACCESS_TOKEN}` } }
        );
        if (listRes.status === 401) return { ok: false, summary_en: "Gmail needs reconnecting — say 'connect gmail' and I'll walk you through it." };
        if (!listRes.ok) return { ok: false, summary_en: `Gmail answered with error ${listRes.status}. Trying again later usually works.` };
        const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
        if (!list.messages?.length) return { ok: true, summary_en: "Checked Gmail — no new mail found.", data: [] };
        const items: Array<{ subject: string; from: string; snippet: string }> = [];
        for (const m of list.messages.slice(0, max)) {
          const d = (await (await fetchFn(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
            { headers: { Authorization: `Bearer ${env.GOOGLE_ACCESS_TOKEN}` } }
          )).json()) as {
            snippet?: string;
            payload?: { headers?: Array<{ name: string; value: string }>; body?: { data?: string }; parts?: never[] };
          };
          const headers = d.payload?.headers ?? [];
          const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "(no subject)";
          const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "unknown";
          items.push({ subject, from, snippet: (d.snippet ?? "").slice(0, 200) });
        }
        const lines = items.map((i) => `• ${i.subject} — ${i.from}`).join("; ");
        return { ok: true, summary_en: `Checked Gmail, found ${items.length} mail${items.length > 1 ? "s" : ""}: ${lines}.`, data: items };
      }
      case "sheets": {
        if (!env.GOOGLE_ACCESS_TOKEN) {
          return { ok: true, summary_en: `Saved a row to the sheet ${step.args.sheet ?? ""} (demo mode — say 'connect google' for real saves).` };
        }
        const spreadsheetId = step.args.spreadsheet_id ?? step.args.sheet ?? "";
        const range = step.args.range ?? "Sheet1!A:Z";
        if (!spreadsheetId) return { ok: false, summary_en: "I need a Google Sheet link or ID. Paste the sheet URL and I'll save there." };
        const values = step.args.values ? tryParseRow(step.args.values) : [new Date().toISOString(), step.say_en];
        const res = await fetchFn(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${env.GOOGLE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ values: [values] }),
          }
        );
        if (res.status === 401) return { ok: false, summary_en: "Google needs reconnecting — say 'connect google'." };
        if (!res.ok) return { ok: false, summary_en: `Sheets answered with error ${res.status}. Check the sheet is shared with your Google account.` };
        return { ok: true, summary_en: "Saved a row to your Google Sheet." };
      }
      case "telegram": {
        if (!env.TELEGRAM_BOT_TOKEN) return { ok: true, summary_en: `Message ready to send (add Telegram token to actually deliver): ${step.args.text ?? ""}`.slice(0, 300) };
        const chatId = step.args.chat_id ?? "";
        if (!chatId) return { ok: false, summary_en: "I need a Telegram chat to send to. Open the bot once and say hello." };
        const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: step.args.text ?? step.say_en }),
        });
        return res.ok
          ? { ok: true, summary_en: "Sent the Telegram message." }
          : { ok: false, summary_en: "Telegram did not accept the message. Say hello to the bot first, then try again." };
      }
      case "whatsapp": {
        if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
          return { ok: true, summary_en: `WhatsApp message ready (add WhatsApp token to deliver): ${step.args.text ?? ""}`.slice(0, 300) };
        }
        const to = (step.args.to ?? "").replace(/[^0-9]/g, "");
        if (!to) return { ok: false, summary_en: "I need a WhatsApp number with country code, like 15551234567." };
        const res = await fetchFn(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: (step.args.text ?? step.say_en).slice(0, 4000) } }),
        });
        return res.ok
          ? { ok: true, summary_en: "Sent the WhatsApp message." }
          : { ok: false, summary_en: `WhatsApp answered with error ${res.status}. For new numbers, send the first message from your phone within 24h, then I can reply.` };
      }
      case "custom": {
        const spec = env.CUSTOM_CONNECTOR;
        if (!spec?.base_url) return { ok: false, summary_en: `Connector '${step.args.connector ?? ""}' is missing its web address. Regenerate it from its docs.` };
        const action = spec.spec.actions.find((a) => a.name === step.action) ?? spec.spec.actions[0];
        if (!action) return { ok: false, summary_en: "That connector has no actions yet." };
        let url = spec.base_url.replace(/\/$/, "") + action.path;
        for (const [k, v] of Object.entries(step.args)) {
          url = url.replace(`{${k}}`, encodeURIComponent(v));
        }
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (spec.spec.auth?.type === "bearer" && spec.spec.auth_token) headers.Authorization = `Bearer ${spec.spec.auth_token}`;
        const method = (action.method ?? "GET").toUpperCase();
        const res = await fetchFn(url, { method, headers, body: ["POST", "PUT", "PATCH"].includes(method) ? step.args.body ?? "{}" : undefined });
        const text = await res.text();
        return res.ok
          ? { ok: true, summary_en: `Called ${spec.base_url} (${action.name}), got an answer.`, data: text.slice(0, 2000) }
          : { ok: false, summary_en: `That service answered with error ${res.status}.` };
      }
      default:
        return { ok: false, summary_en: `I don't know how to do ${step.tool} yet.` };
    }
  } catch (e) {
    return { ok: false, summary_en: `That step had trouble: ${(e as Error).message.slice(0, 200)}. I will retry once.` };
  }
}

function tryParseRow(values: string): string[] {
  try {
    const parsed = JSON.parse(values) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* comma list */ }
  return values.split(",").map((s) => s.trim()).slice(0, 20);
}
