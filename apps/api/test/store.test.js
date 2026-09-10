import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storeFor;
let uid;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "talkflow-test-"));
  process.env.DB_PATH = join(dir, "talkflow.json");
  process.env.MAX_CHATS_PER_USER_PER_DAY = "2";
  process.env.MAX_RUNS_PER_USER_PER_DAY = "1";
  const mod = await import("../dist/lib/store.js");
  storeFor = mod.storeFor;
  uid = mod.uid;
});

const store = () => storeFor(undefined, {});

test("flows CRUD through Store", async () => {
  const s = store();
  const f = { id: uid("flow"), user_id: "u1", title_en: "Test flow", trigger_desc: "manual", steps_json: "[]", status: "active", created_via: "pwa", created_at: Date.now() };
  await s.saveFlow(f);
  assert.equal((await s.getFlow(f.id)).title_en, "Test flow");
  assert.equal((await s.listFlows()).length, 1);
  await s.setFlowStatus(f.id, "paused");
  assert.equal((await s.getFlow(f.id)).status, "paused");
});

test("pending plans are per-user", async () => {
  const s = store();
  await s.setPending({ title_en: "A" }, "alice");
  await s.setPending({ title_en: "B" }, "bob");
  assert.equal((await s.takePending("alice")).title_en, "A");
  assert.equal((await s.takePending("bob")).title_en, "B");
  assert.equal(await s.takePending("alice"), undefined);
});

test("connections hide secrets from listing", async () => {
  const s = store();
  await s.saveConnection({ id: uid("conn"), user_id: "u1", provider: "google", label: "Gmail", secret_json: JSON.stringify({ access_token: "SECRET" }), created_at: Date.now() });
  assert.equal((await s.getConnection("u1", "google")).secret_json.includes("SECRET"), true);
  const listed = await s.listConnections("u1");
  assert.equal(listed.length, 1);
  assert.equal("secret_json" in listed[0], false);
  await s.deleteConnection("u1", "google");
  assert.equal(await s.getConnection("u1", "google"), undefined);
});

test("messages keep recent history in order", async () => {
  const s = store();
  for (let i = 0; i < 3; i++) {
    await s.addMessage({ id: uid("msg"), user_id: "u2", role: i % 2 ? "assistant" : "user", text: `m${i}`, created_at: Date.now() + i });
  }
  const recent = await s.recentMessages("u2", 2);
  assert.deepEqual(recent.map((m) => m.text), ["m1", "m2"]);
});

test("connectors save/list/get by name", async () => {
  const s = store();
  await s.saveConnector({ id: "con_1", name: "demo-api", description_en: "d", base_url: "https://api.example.com", spec_json: "{}", created_at: Date.now() });
  assert.equal((await s.listConnectors()).length, 1);
  assert.equal((await s.getConnector("DEMO-API")).base_url, "https://api.example.com");
});

test("quotas block with plain-english messages", async () => {
  const s = store();
  assert.equal(await s.checkAndTrackChat("q"), null);
  assert.equal(await s.checkAndTrackChat("q"), null);
  const blocked = await s.checkAndTrackChat("q");
  assert.match(blocked, /reset tomorrow/);
  assert.equal(await s.checkAndTrackRun("q"), null);
  assert.match(await s.checkAndTrackRun("q"), /reset tomorrow/);
  assert.deepEqual(await s.userUsageToday("q"), { chats: 2, runs: 1 });
});

test("provider usage counted per day", async () => {
  const s = store();
  await s.trackProvider("groq");
  await s.trackProvider("groq");
  assert.equal((await s.providerUsageToday()).groq, 2);
});
