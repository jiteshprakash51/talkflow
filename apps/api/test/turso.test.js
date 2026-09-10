import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// TursoStore speaks SQLite dialect — node:sqlite runs its REAL SQL here,
// including the actual migration files. (Turso itself is the same dialect.)
let TursoStore;
let uid;
let db;

function sqliteAdapter() {
  return {
    execute: async (sql, args = []) => {
      const stmt = db.prepare(sql);
      if (/^\s*select/i.test(sql)) return { rows: stmt.all(...args) };
      stmt.run(...args);
      return { rows: [] };
    },
  };
}

before(async () => {
  const mod = await import("../dist/lib/store-turso.js");
  TursoStore = mod.TursoStore;
  ({ uid } = await import("../dist/lib/store.js"));
  db = new DatabaseSync(":memory:");
  const migDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "db", "migrations");
  for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migDir, f), "utf8");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      db.prepare(stmt).run();
    }
  }
});

const store = () => new TursoStore(sqliteAdapter(), { maxChats: 2, maxRuns: 1 });

test("migrations create all tables", () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["flows", "runs", "messages", "connections", "connectors", "pending", "usage_providers", "usage_users"]) {
    assert.ok(tables.includes(t), `missing ${t}`);
  }
});

test("turso: flows + pending per-user", async () => {
  const s = store();
  const f = { id: uid("flow"), user_id: "u1", title_en: "T", trigger_desc: "manual", steps_json: "[]", status: "active", created_via: "pwa", created_at: Date.now() };
  await s.saveFlow(f);
  assert.equal((await s.getFlow(f.id)).title_en, "T");
  await s.saveFlow({ ...f, title_en: "T2" }); // upsert
  assert.equal((await s.getFlow(f.id)).title_en, "T2");
  await s.setPending({ title_en: "A" }, "alice");
  await s.setPending({ title_en: "B" }, "bob");
  assert.equal((await s.takePending("alice")).title_en, "A");
  assert.equal(await s.takePending("alice"), undefined);
  assert.equal((await s.takePending("bob")).title_en, "B");
});

test("turso: runs, messages, connectors, connections", async () => {
  const s = store();
  await s.saveFlow({ id: "f1", user_id: "u9", title_en: "F", trigger_desc: "m", steps_json: "[]", status: "active", created_via: "pwa", created_at: Date.now() });
  await s.addRun({ id: uid("run"), flow_id: "f1", status: "ok", output_summary_en: "done", error_en: "", provider: "r", created_at: Date.now() });
  assert.equal((await s.listRuns("f1")).length, 1);
  for (let i = 0; i < 3; i++) {
    await s.addMessage({ id: uid("m"), user_id: "u9", role: "user", text: `m${i}`, created_at: Date.now() + i });
  }
  assert.deepEqual((await s.recentMessages("u9", 2)).map((m) => m.text), ["m1", "m2"]);
  await s.saveConnector({ id: "c1", name: "Demo", description_en: "d", base_url: "https://x.example", spec_json: "{}", created_at: Date.now() });
  assert.equal((await s.getConnector("demo")).base_url, "https://x.example");
  await s.saveConnection({ id: uid("c"), user_id: "u9", provider: "google", label: "G", secret_json: "{}", created_at: Date.now() });
  assert.equal((await s.listConnections("u9")).length, 1);
  await s.deleteConnection("u9", "google");
  assert.equal(await s.getConnection("u9", "google"), undefined);
});

test("turso: quotas + provider usage", async () => {
  const s = store();
  assert.equal(await s.checkAndTrackChat("qq"), null);
  assert.equal(await s.checkAndTrackChat("qq"), null);
  assert.match(await s.checkAndTrackChat("qq"), /reset tomorrow/);
  assert.equal(await s.checkAndTrackRun("qq"), null);
  assert.match(await s.checkAndTrackRun("qq"), /reset tomorrow/);
  await s.trackProvider("groq");
  await s.trackProvider("groq");
  assert.equal((await s.providerUsageToday()).groq, 2);
});
