// TalkFlow template store — automations described in plain English, installed with one sentence.
// Each template is a ready FlowPlan; "use" puts it in the user's pending slot, they say "ok".

import type { FlowStep } from "@talkflow/connectors";

export interface Template {
  id: string;
  title_en: string;
  description_en: string;
  say_to_use_en: string;
  trigger_en: string;
  steps: FlowStep[];
}

export const TEMPLATES: Template[] = [
  {
    id: "morning-gmail-digest",
    title_en: "Morning Gmail digest",
    description_en: "Every morning at 8, reads your newest mail and sends a short summary to Telegram.",
    say_to_use_en: "use morning digest",
    trigger_en: "every morning at 8am",
    steps: [
      { tool: "schedule", action: "cron", args: { when: "every morning at 8am" }, say_en: "Runs every morning at 8." },
      { tool: "gmail", action: "list", args: { query: "newer_than:1d", max: "5" }, say_en: "Reads your newest mail." },
      { tool: "telegram", action: "send", args: { text: "Morning digest ready — see run details." }, say_en: "Sends the summary to Telegram." },
    ],
  },
  {
    id: "receipt-to-sheet",
    title_en: "Receipts to sheet",
    description_en: "Every evening, finds today's receipts in Gmail and appends them to your Google Sheet.",
    say_to_use_en: "use receipts to sheet",
    trigger_en: "every evening at 7pm",
    steps: [
      { tool: "schedule", action: "cron", args: { when: "every evening at 7pm" }, say_en: "Runs every evening." },
      { tool: "gmail", action: "list", args: { query: "receipt newer_than:1d", max: "10" }, say_en: "Finds today's receipts." },
      { tool: "sheets", action: "append", args: { range: "Sheet1!A:Z", values: "" }, say_en: "Saves them to your sheet." },
    ],
  },
  {
    id: "website-watch",
    title_en: "Website watcher",
    description_en: "Checks your website every hour and pings Telegram if it stops answering.",
    say_to_use_en: "use website watcher",
    trigger_en: "every hour",
    steps: [
      { tool: "schedule", action: "cron", args: { when: "every hour" }, say_en: "Runs every hour." },
      { tool: "http", action: "get", args: { url: "https://example.com", method: "GET" }, say_en: "Checks your website. Say your real address after installing." },
      { tool: "telegram", action: "send", args: { text: "Website check finished — see run details." }, say_en: "Pings you on Telegram." },
    ],
  },
  {
    id: "whatsapp-morning-hello",
    title_en: "WhatsApp morning note",
    description_en: "Sends a good-morning WhatsApp message to a number you choose, every day at 8.",
    say_to_use_en: "use whatsapp hello",
    trigger_en: "every morning at 8am",
    steps: [
      { tool: "schedule", action: "cron", args: { when: "every morning at 8am" }, say_en: "Runs every morning at 8." },
      { tool: "whatsapp", action: "send", args: { to: "", text: "Good morning! ☀️" }, say_en: "Sends WhatsApp. Tell me the number with country code after installing." },
    ],
  },
  {
    id: "api-to-telegram",
    title_en: "API alerts to Telegram",
    description_en: "Polls any web address every hour and forwards the answer to Telegram.",
    say_to_use_en: "use api alerts",
    trigger_en: "every hour",
    steps: [
      { tool: "schedule", action: "cron", args: { when: "every hour" }, say_en: "Runs every hour." },
      { tool: "http", action: "get", args: { url: "https://api.example.com/status", method: "GET" }, say_en: "Asks your web address. Say the real address after installing." },
      { tool: "telegram", action: "send", args: { text: "API check finished." }, say_en: "Forwards the answer to Telegram." },
    ],
  },
];

export function findTemplate(text: string): Template | undefined {
  const t = text.toLowerCase();
  return (
    TEMPLATES.find((x) => t.includes(x.id)) ??
    TEMPLATES.find((x) => t.includes(x.say_to_use_en)) ??
    TEMPLATES.find((x) => t.includes(x.title_en.toLowerCase()))
  );
}
