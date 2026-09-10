import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StoredFlow {
  id: string;
  user_id: string;
  title_en: string;
  trigger_desc: string;
  steps_json: string;
  status: string;
  created_via: string;
  created_at: number;
}

export interface StoredRun {
  id: string;
  flow_id: string;
  status: string;
  output_summary_en: string;
  error_en: string;
  provider: string;
  created_at: number;
}

export interface StoredConnection {
  id: string;
  user_id: string;
  provider: string;
  label: string;
  secret_json: string;
  created_at: number;
}

export interface StoredMessage {
  id: string;
  user_id: string;
  role: string;
  text: string;
  created_at: number;
}

export interface StoredConnector {
  id: string;
  name: string;
  description_en: string;
  base_url: string;
  spec_json: string;
  created_at: number;
}

// Cloudflare D1 binding shape (subset we use)
export interface D1Like {
  prepare(q: string): {
    bind(...args: unknown[]): { all(): Promise<{ results: unknown[] }>; run(): Promise<unknown> };
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local', title_en TEXT NOT NULL, trigger_desc TEXT NOT NULL DEFAULT '', steps_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_via TEXT NOT NULL DEFAULT 'pwa', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', input_summary TEXT NOT NULL DEFAULT '', output_summary_en TEXT NOT NULL DEFAULT '', error_en TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local', role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local', provider TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', secret_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, name TEXT NOT NULL, description_en TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL DEFAULT '', spec_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending (user_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_providers (provider TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, day));
CREATE TABLE IF NOT EXISTS usage_users (user_id TEXT NOT NULL, day TEXT NOT NULL, chats INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));`;

export async function ensureSchemaD1(db: D1Like): Promise<void> {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).bind().run();
  }
}

// ---- Local JSON file store (Docker / npm dev). Same shape as D1. ----
interface FileDB {
  flows: StoredFlow[];
  runs: StoredRun[];
  connections: StoredConnection[];
  messages: StoredMessage[];
  connectors: StoredConnector[];
  pendingPlan?: unknown;
  pendingByUser?: Record<string, unknown>;
  usage?: {
    providers: Record<string, { date: string; count: number }>;
    users: Record<string, { date: string; chats: number; runs: number }>;
  };
}

function emptyDb(): FileDB {
  return { flows: [], runs: [], connections: [], messages: [], connectors: [] };
}

function dbPath(): string {
  return process.env.DB_PATH ?? join(process.cwd(), "data", "talkflow.json");
}

function loadFile(): FileDB {
  const p = dbPath();
  if (!existsSync(p)) return emptyDb();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<FileDB>;
    return {
      flows: raw.flows ?? [],
      runs: raw.runs ?? [],
      connections: raw.connections ?? [],
      messages: raw.messages ?? [],
      connectors: raw.connectors ?? [],
      pendingPlan: raw.pendingPlan,
      pendingByUser: raw.pendingByUser,
      usage: raw.usage ?? { providers: {}, users: {} },
    };
  } catch {
    return emptyDb();
  }
}

function saveFile(db: FileDB): void {
  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(db, null, 2));
}

export const localStore = {
  listFlows(): StoredFlow[] {
    return loadFile().flows;
  },
  saveFlow(f: StoredFlow): void {
    const db = loadFile();
    db.flows = [f, ...db.flows.filter((x) => x.id !== f.id)].slice(0, 200);
    saveFile(db);
  },
  getFlow(id: string): StoredFlow | undefined {
    return loadFile().flows.find((x) => x.id === id);
  },
  setFlowStatus(id: string, status: string): void {
    const db = loadFile();
    db.flows = db.flows.map((x) => (x.id === id ? { ...x, status } : x));
    saveFile(db);
  },
  addRun(r: StoredRun): void {
    const db = loadFile();
    db.runs = [r, ...db.runs].slice(0, 500);
    saveFile(db);
  },
  listRuns(flowId?: string): StoredRun[] {
    const runs = loadFile().runs;
    return flowId ? runs.filter((r) => r.flow_id === flowId) : runs;
  },
  setPending(plan: unknown, userId = "local"): void {
    const db = loadFile();
    db.pendingPlan = plan;
    db.pendingByUser = { ...(db.pendingByUser ?? {}), [userId]: plan };
    saveFile(db);
  },
  takePending(userId = "local"): unknown {
    const db = loadFile();
    const p = db.pendingByUser?.[userId] ?? db.pendingPlan;
    if (db.pendingByUser) delete db.pendingByUser[userId];
    db.pendingPlan = undefined;
    saveFile(db);
    return p;
  },
  peekPending(userId = "local"): unknown {
    const db = loadFile();
    return db.pendingByUser?.[userId] ?? db.pendingPlan;
  },
  // ---- Connections (OAuth tokens, never shown to user) ----
  saveConnection(c: StoredConnection): void {
    const db = loadFile();
    db.connections = [c, ...db.connections.filter((x) => !(x.user_id === c.user_id && x.provider === c.provider))].slice(0, 50);
    saveFile(db);
  },
  getConnection(userId: string, provider: string): StoredConnection | undefined {
    return loadFile().connections.find((x) => x.user_id === userId && x.provider === provider);
  },
  listConnections(userId?: string): Array<{ provider: string; label: string; created_at: number }> {
    const all = loadFile().connections;
    const filtered = userId ? all.filter((x) => x.user_id === userId) : all;
    return filtered.map((x) => ({ provider: x.provider, label: x.label, created_at: x.created_at }));
  },
  deleteConnection(userId: string, provider: string): void {
    const db = loadFile();
    db.connections = db.connections.filter((x) => !(x.user_id === userId && x.provider === provider));
    saveFile(db);
  },
  // ---- Memory: last N messages per user for planner context ----
  addMessage(m: StoredMessage): void {
    const db = loadFile();
    db.messages = [...db.messages.filter((x) => x.user_id === m.user_id).slice(-49), m];
    // keep other users intact (cap total)
    const others = loadFile().messages.filter((x) => x.user_id !== m.user_id).slice(-200);
    db.messages = [...others.filter((x) => x.user_id !== m.user_id), ...db.messages].slice(-250);
    saveFile(db);
  },
  recentMessages(userId: string, n = 6): StoredMessage[] {
    return loadFile().messages.filter((x) => x.user_id === userId).slice(-n);
  },
  // ---- Quotas + usage ($0 protection: caps keep free tiers safe) ----
  trackProvider(provider: string): void {
    const db = loadFile();
    db.usage = db.usage ?? { providers: {}, users: {} };
    const today = new Date().toISOString().slice(0, 10);
    const cur = db.usage.providers[provider];
    db.usage.providers[provider] =
      cur?.date === today ? { date: today, count: cur.count + 1 } : { date: today, count: 1 };
    saveFile(db);
  },
  providerUsageToday(): Record<string, number> {
    const db = loadFile();
    const today = new Date().toISOString().slice(0, 10);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(db.usage?.providers ?? {})) {
      if (v.date === today) out[k] = v.count;
    }
    return out;
  },
  /** Returns null when allowed, or a plain-English reason when the user hit a cap. */
  checkAndTrackChat(userId: string): string | null {
    const max = Number(process.env.MAX_CHATS_PER_USER_PER_DAY ?? 100);
    const db = loadFile();
    db.usage = db.usage ?? { providers: {}, users: {} };
    const today = new Date().toISOString().slice(0, 10);
    const cur = db.usage.users[userId];
    const entry = cur?.date === today ? cur : { date: today, chats: 0, runs: 0 };
    if (entry.chats >= max) {
      return `You've used today's ${max} free chats — they reset tomorrow. Your automations keep running meanwhile.`;
    }
    entry.chats += 1;
    db.usage.users[userId] = entry;
    saveFile(db);
    return null;
  },
  checkAndTrackRun(userId: string): string | null {
    const max = Number(process.env.MAX_RUNS_PER_USER_PER_DAY ?? 25);
    const db = loadFile();
    db.usage = db.usage ?? { providers: {}, users: {} };
    const today = new Date().toISOString().slice(0, 10);
    const cur = db.usage.users[userId];
    const entry = cur?.date === today ? cur : { date: today, chats: 0, runs: 0 };
    if (entry.runs >= max) {
      return `Today's ${max} free runs are used up — they reset tomorrow. Say 'list' to review your automations.`;
    }
    entry.runs += 1;
    db.usage.users[userId] = entry;
    saveFile(db);
    return null;
  },
  userUsageToday(userId: string): { chats: number; runs: number } {
    const db = loadFile();
    const today = new Date().toISOString().slice(0, 10);
    const cur = db.usage?.users[userId];
    return cur?.date === today ? { chats: cur.chats, runs: cur.runs } : { chats: 0, runs: 0 };
  },
  // ---- AI-generated custom connectors ----
  saveConnector(c: StoredConnector): void {
    const db = loadFile();
    db.connectors = [c, ...db.connectors.filter((x) => x.id !== c.id)].slice(0, 100);
    saveFile(db);
  },
  listConnectors(): StoredConnector[] {
    return loadFile().connectors;
  },
  getConnector(idOrName: string): StoredConnector | undefined {
    const all = loadFile().connectors;
    return all.find((x) => x.id === idOrName || x.name.toLowerCase() === idOrName.toLowerCase());
  },
};

// ---- Unified async Store: D1 in cloud, JSON file locally ----
export interface StoreLimits {
  maxChats: number;
  maxRuns: number;
}

export function limitsOf(env: Record<string, string | undefined>): StoreLimits {
  const pick = (k: string, d: number): number => {
    const v = Number(env[k] ?? process.env[k] ?? d);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return { maxChats: pick("MAX_CHATS_PER_USER_PER_DAY", 100), maxRuns: pick("MAX_RUNS_PER_USER_PER_DAY", 25) };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface Store {
  listFlows(): Promise<StoredFlow[]>;
  saveFlow(f: StoredFlow): Promise<void>;
  getFlow(id: string): Promise<StoredFlow | undefined>;
  setFlowStatus(id: string, status: string): Promise<void>;
  addRun(r: StoredRun): Promise<void>;
  listRuns(flowId?: string): Promise<StoredRun[]>;
  setPending(plan: unknown, userId?: string): Promise<void>;
  takePending(userId?: string): Promise<unknown>;
  saveConnection(c: StoredConnection): Promise<void>;
  getConnection(userId: string, provider: string): Promise<StoredConnection | undefined>;
  listConnections(userId?: string): Promise<Array<{ provider: string; label: string; created_at: number }>>;
  deleteConnection(userId: string, provider: string): Promise<void>;
  addMessage(m: StoredMessage): Promise<void>;
  recentMessages(userId: string, n?: number): Promise<StoredMessage[]>;
  saveConnector(c: StoredConnector): Promise<void>;
  listConnectors(): Promise<StoredConnector[]>;
  getConnector(idOrName: string): Promise<StoredConnector | undefined>;
  trackProvider(provider: string): Promise<void>;
  providerUsageToday(): Promise<Record<string, number>>;
  checkAndTrackChat(userId: string): Promise<string | null>;
  checkAndTrackRun(userId: string): Promise<string | null>;
  userUsageToday(userId: string): Promise<{ chats: number; runs: number }>;
}

class D1Store implements Store {
  constructor(private db: D1Like, private limits: StoreLimits) {}

  private async all<T>(q: string, ...args: unknown[]): Promise<T[]> {
    const r = await this.db.prepare(q).bind(...args).all();
    return ((r.results ?? []) as T[]);
  }

  private async run(q: string, ...args: unknown[]): Promise<void> {
    await this.db.prepare(q).bind(...args).run();
  }

  async listFlows(): Promise<StoredFlow[]> {
    return this.all<StoredFlow>("SELECT * FROM flows ORDER BY created_at DESC LIMIT 200");
  }

  async saveFlow(f: StoredFlow): Promise<void> {
    await this.run(
      "INSERT INTO flows (id, user_id, title_en, trigger_desc, steps_json, status, created_via, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title_en=excluded.title_en, trigger_desc=excluded.trigger_desc, steps_json=excluded.steps_json, status=excluded.status",
      f.id, f.user_id, f.title_en, f.trigger_desc, f.steps_json, f.status, f.created_via, f.created_at
    );
  }

  async getFlow(id: string): Promise<StoredFlow | undefined> {
    const rows = await this.all<StoredFlow>("SELECT * FROM flows WHERE id=? LIMIT 1", id);
    return rows[0];
  }

  async setFlowStatus(id: string, status: string): Promise<void> {
    await this.run("UPDATE flows SET status=? WHERE id=?", status, id);
  }

  async addRun(r: StoredRun): Promise<void> {
    await this.run(
      "INSERT INTO runs (id, flow_id, status, input_summary, output_summary_en, error_en, provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
      r.id, r.flow_id, r.status, "", r.output_summary_en, r.error_en, r.provider, r.created_at
    );
  }

  async listRuns(flowId?: string): Promise<StoredRun[]> {
    if (flowId) return this.all<StoredRun>("SELECT * FROM runs WHERE flow_id=? ORDER BY created_at DESC LIMIT 30", flowId);
    return this.all<StoredRun>("SELECT * FROM runs ORDER BY created_at DESC LIMIT 100");
  }

  async setPending(plan: unknown, userId = "local"): Promise<void> {
    await this.run("INSERT INTO pending (user_id, plan_json) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET plan_json=excluded.plan_json", userId, JSON.stringify(plan));
  }

  async takePending(userId = "local"): Promise<unknown> {
    const rows = await this.all<{ plan_json: string }>("SELECT plan_json FROM pending WHERE user_id=? LIMIT 1", userId);
    if (!rows[0]) return undefined;
    await this.run("DELETE FROM pending WHERE user_id=?", userId);
    try {
      return JSON.parse(rows[0].plan_json) as unknown;
    } catch {
      return undefined;
    }
  }

  async saveConnection(c: StoredConnection): Promise<void> {
    await this.run("DELETE FROM connections WHERE user_id=? AND provider=?", c.user_id, c.provider);
    await this.run(
      "INSERT INTO connections (id, user_id, provider, label, secret_json, created_at) VALUES (?,?,?,?,?,?)",
      c.id, c.user_id, c.provider, c.label, c.secret_json, c.created_at
    );
  }

  async getConnection(userId: string, provider: string): Promise<StoredConnection | undefined> {
    const rows = await this.all<StoredConnection>("SELECT * FROM connections WHERE user_id=? AND provider=? LIMIT 1", userId, provider);
    return rows[0];
  }

  async listConnections(userId?: string): Promise<Array<{ provider: string; label: string; created_at: number }>> {
    const rows = userId
      ? await this.all<StoredConnection>("SELECT * FROM connections WHERE user_id=? ORDER BY created_at DESC", userId)
      : await this.all<StoredConnection>("SELECT * FROM connections ORDER BY created_at DESC LIMIT 100");
    return rows.map((x) => ({ provider: x.provider, label: x.label, created_at: x.created_at }));
  }

  async deleteConnection(userId: string, provider: string): Promise<void> {
    await this.run("DELETE FROM connections WHERE user_id=? AND provider=?", userId, provider);
  }

  async addMessage(m: StoredMessage): Promise<void> {
    await this.run("INSERT INTO messages (id, user_id, role, text, created_at) VALUES (?,?,?,?,?)", m.id, m.user_id, m.role, m.text, m.created_at);
    await this.run(
      "DELETE FROM messages WHERE user_id=? AND id NOT IN (SELECT id FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT 60)",
      m.user_id, m.user_id
    );
  }

  async recentMessages(userId: string, n = 6): Promise<StoredMessage[]> {
    const rows = await this.all<StoredMessage>("SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT ?", userId, n);
    return rows.reverse();
  }

  async saveConnector(c: StoredConnector): Promise<void> {
    await this.run(
      "INSERT INTO connectors (id, name, description_en, base_url, spec_json, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description_en=excluded.description_en, base_url=excluded.base_url, spec_json=excluded.spec_json",
      c.id, c.name, c.description_en, c.base_url, c.spec_json, c.created_at
    );
  }

  async listConnectors(): Promise<StoredConnector[]> {
    return this.all<StoredConnector>("SELECT * FROM connectors ORDER BY created_at DESC LIMIT 100");
  }

  async getConnector(idOrName: string): Promise<StoredConnector | undefined> {
    const rows = await this.all<StoredConnector>("SELECT * FROM connectors WHERE id=? OR lower(name)=lower(?) LIMIT 1", idOrName, idOrName);
    return rows[0];
  }

  async trackProvider(provider: string): Promise<void> {
    await this.run(
      "INSERT INTO usage_providers (provider, day, count) VALUES (?,?,1) ON CONFLICT(provider, day) DO UPDATE SET count=count+1",
      provider, todayStr()
    );
  }

  async providerUsageToday(): Promise<Record<string, number>> {
    const rows = await this.all<{ provider: string; count: number }>("SELECT provider, count FROM usage_providers WHERE day=?", todayStr());
    const out: Record<string, number> = {};
    for (const r of rows) out[r.provider] = r.count;
    return out;
  }

  async checkAndTrackChat(userId: string): Promise<string | null> {
    const rows = await this.all<{ chats: number; runs: number }>("SELECT chats, runs FROM usage_users WHERE user_id=? AND day=? LIMIT 1", userId, todayStr());
    const cur = rows[0] ?? { chats: 0, runs: 0 };
    if (cur.chats >= this.limits.maxChats) {
      return `You've used today's ${this.limits.maxChats} free chats — they reset tomorrow. Your automations keep running meanwhile.`;
    }
    await this.run(
      "INSERT INTO usage_users (user_id, day, chats, runs) VALUES (?,?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET chats=chats+1",
      userId, todayStr(), cur.chats + 1, cur.runs
    );
    return null;
  }

  async checkAndTrackRun(userId: string): Promise<string | null> {
    const rows = await this.all<{ chats: number; runs: number }>("SELECT chats, runs FROM usage_users WHERE user_id=? AND day=? LIMIT 1", userId, todayStr());
    const cur = rows[0] ?? { chats: 0, runs: 0 };
    if (cur.runs >= this.limits.maxRuns) {
      return `Today's ${this.limits.maxRuns} free runs are used up — they reset tomorrow. Say 'list' to review your automations.`;
    }
    await this.run(
      "INSERT INTO usage_users (user_id, day, chats, runs) VALUES (?,?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET runs=runs+1",
      userId, todayStr(), cur.chats, cur.runs + 1
    );
    return null;
  }

  async userUsageToday(userId: string): Promise<{ chats: number; runs: number }> {
    const rows = await this.all<{ chats: number; runs: number }>("SELECT chats, runs FROM usage_users WHERE user_id=? AND day=? LIMIT 1", userId, todayStr());
    return rows[0] ?? { chats: 0, runs: 0 };
  }
}

function localAdapter(): Store {
  const wrap = <T>(v: T): Promise<T> => Promise.resolve(v);
  // localStore methods are synchronous; quota limits read process.env inside.
  return {
    listFlows: () => wrap(localStore.listFlows()),
    saveFlow: (f) => wrap(localStore.saveFlow(f)),
    getFlow: (id) => wrap(localStore.getFlow(id)),
    setFlowStatus: (id, s) => wrap(localStore.setFlowStatus(id, s)),
    addRun: (r) => wrap(localStore.addRun(r)),
    listRuns: (fid) => wrap(localStore.listRuns(fid)),
    setPending: (p, u) => wrap(localStore.setPending(p, u)),
    takePending: (u) => wrap(localStore.takePending(u)),
    saveConnection: (c) => wrap(localStore.saveConnection(c)),
    getConnection: (u, p) => wrap(localStore.getConnection(u, p)),
    listConnections: (u) => wrap(localStore.listConnections(u)),
    deleteConnection: (u, p) => wrap(localStore.deleteConnection(u, p)),
    addMessage: (m) => wrap(localStore.addMessage(m)),
    recentMessages: (u, n) => wrap(localStore.recentMessages(u, n)),
    saveConnector: (c) => wrap(localStore.saveConnector(c)),
    listConnectors: () => wrap(localStore.listConnectors()),
    getConnector: (id) => wrap(localStore.getConnector(id)),
    trackProvider: (p) => wrap(localStore.trackProvider(p)),
    providerUsageToday: () => wrap(localStore.providerUsageToday()),
    checkAndTrackChat: (u) => wrap(localStore.checkAndTrackChat(u)),
    checkAndTrackRun: (u) => wrap(localStore.checkAndTrackRun(u)),
    userUsageToday: (u) => wrap(localStore.userUsageToday(u)),
  };
}

/** D1 when the binding exists (Cloudflare), JSON file otherwise (local/Docker). */
export function storeFor(db: D1Like | undefined, env: Record<string, string | undefined>): Store {
  if (db) return new D1Store(db, limitsOf(env));
  return localAdapter();
}

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
