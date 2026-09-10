import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Full chain with a mock brain: real Hono app, real router HTTP, real store.
// Proves chat -> plan -> pending -> confirm -> queue-less run -> explainer.
// Only a real provider key remains unverified (none validates here).
let app;
let mockUrl;
let mockSrv;

const PLAN = {
  title_en: "Mock morning",
  confirm_en: "I will check things daily.",
  trigger_en: "every morning at 8am",
  steps: [
    { tool: "schedule", action: "cron", args: { when: "every morning at 8am" }, say_en: "Runs every morning." },
    { tool: "telegram", action: "send", args: { text: "Morning!" }, say_en: "Sends a morning note." },
  ],
};

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "talkflow-e2e-"));
  process.env.DB_PATH = join(dir, "talkflow.json");
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;

  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const sys = parsed.messages?.[0]?.content ?? "";
      const text = sys.includes("planner")
        ? JSON.stringify(PLAN)
        : sys.includes("explainer")
          ? "All done — morning check finished nicely."
          : "Hello! Tell me what to automate.";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  mockSrv = srv;
  mockUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  process.env.OLLAMA_BASE_URL = mockUrl;

  const mod = await import("../dist/index.js");
  app = mod.default;
});

after(async () => {
  if (mockSrv) await new Promise((r) => mockSrv.close(r));
});

async function post(path, body) {
  const res = await app.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {}
  );
  return res.json();
}

async function get(path) {
  const res = await app.fetch(new Request(`http://test${path}`), {});
  return res.json();
}

test("AI plans, user confirms, flow runs, explainer summarizes", async () => {
  const plan = await post("/api/chat", { text: "every morning check things", user_id: "e2e" });
  assert.equal(plan.ok, true);
  assert.equal(plan.needs_confirm, true);
  assert.match(plan.reply_en, /Mock morning/);

  const done = await post("/api/chat", { text: "ok", user_id: "e2e" });
  assert.equal(done.ok, true);
  assert.ok(done.flow_id);

  // runFlowLocal is fire-and-forget; poll for the run record
  let runs = [];
  for (let i = 0; i < 50 && runs.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    runs = (await get(`/api/runs?flow_id=${done.flow_id}`)).runs ?? [];
  }
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "ok");
  assert.match(runs[0].output_summary_en, /morning check finished/);

  const flows = (await get("/api/flows")).flows;
  assert.ok(flows.some((f) => f.id === done.flow_id));
});
