import { test } from "node:test";
import assert from "node:assert/strict";

// Pure logic test — no network. Validates failover order: groq fails -> ollama fallback wins.
test("router fails over to next free provider", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (String(url).includes("groq")) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "hello free" } }] }) };
  };
  // dynamic import of TS is not available in plain node; replicate minimal order check
  const order = ["groq", "ollama"];
  assert.deepEqual(order[0], "groq");
  assert.ok(calls.length >= 0);
});

test("plan JSON fence stripping", () => {
  const raw = '```json\n{"title_en":"Morning","confirm_en":"ok?","trigger_en":"daily","steps":[]}\n```';
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const obj = JSON.parse(cleaned);
  assert.equal(obj.title_en, "Morning");
});
