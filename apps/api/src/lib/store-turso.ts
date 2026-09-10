// Turso (libSQL) Store — the Vercel backend for TalkFlow.
// Uses @libsql/client/web (fetch-only, edge-safe) so the Cloudflare Workers
// bundle is unaffected. SQL is SQLite dialect, same as D1.

import { createClient } from "@libsql/client/web";
import type {
  Store,
  StoreLimits,
  StoredConnection,
  StoredConnector,
  StoredFlow,
  StoredMessage,
  StoredRun,
} from "./store.js";
import { limitsOf } from "./store.js";

/** Minimal SQL surface TursoStore needs — also implemented by the node:sqlite test fake. */
export interface SqlDb {
  execute(
    sql: string,
    args?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export class TursoStore implements Store {
  constructor(private db: SqlDb, private limits: StoreLimits) {}

  private async all<T>(q: string, args: unknown[] = []): Promise<T[]> {
    const r = await this.db.execute(q, args);
    return (r.rows ?? []) as unknown as T[];
  }

  private async run(q: string, args: unknown[] = []): Promise<void> {
    await this.db.execute(q, args);
  }

  async listFlows(): Promise<StoredFlow[]> {
    return this.all<StoredFlow>("SELECT * FROM flows ORDER BY created_at DESC LIMIT 200");
  }

  async saveFlow(f: StoredFlow): Promise<void> {
    await this.run(
      "INSERT INTO flows (id, user_id, title_en, trigger_desc, steps_json, status, created_via, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title_en=excluded.title_en, trigger_desc=excluded.trigger_desc, steps_json=excluded.steps_json, status=excluded.status",
      [f.id, f.user_id, f.title_en, f.trigger_desc, f.steps_json, f.status, f.created_via, f.created_at]
    );
  }

  async getFlow(id: string): Promise<StoredFlow | undefined> {
    return (await this.all<StoredFlow>("SELECT * FROM flows WHERE id=? LIMIT 1", [id]))[0];
  }

  async setFlowStatus(id: string, status: string): Promise<void> {
    await this.run("UPDATE flows SET status=? WHERE id=?", [status, id]);
  }

  async addRun(r: StoredRun): Promise<void> {
    await this.run(
      "INSERT INTO runs (id, flow_id, status, input_summary, output_summary_en, error_en, provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [r.id, r.flow_id, r.status, "", r.output_summary_en, r.error_en, r.provider, r.created_at]
    );
  }

  async listRuns(flowId?: string): Promise<StoredRun[]> {
    if (flowId)
      return this.all<StoredRun>("SELECT * FROM runs WHERE flow_id=? ORDER BY created_at DESC LIMIT 30", [flowId]);
    return this.all<StoredRun>("SELECT * FROM runs ORDER BY created_at DESC LIMIT 100");
  }

  async setPending(plan: unknown, userId = "local"): Promise<void> {
    await this.run(
      "INSERT INTO pending (user_id, plan_json) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET plan_json=excluded.plan_json",
      [userId, JSON.stringify(plan)]
    );
  }

  async takePending(userId = "local"): Promise<unknown> {
    const rows = await this.all<{ plan_json: string }>("SELECT plan_json FROM pending WHERE user_id=? LIMIT 1", [userId]);
    if (!rows[0]) return undefined;
    await this.run("DELETE FROM pending WHERE user_id=?", [userId]);
    try {
      return JSON.parse(rows[0].plan_json) as unknown;
    } catch {
      return undefined;
    }
  }

  async saveConnection(c: StoredConnection): Promise<void> {
    await this.run("DELETE FROM connections WHERE user_id=? AND provider=?", [c.user_id, c.provider]);
    await this.run(
      "INSERT INTO connections (id, user_id, provider, label, secret_json, created_at) VALUES (?,?,?,?,?,?)",
      [c.id, c.user_id, c.provider, c.label, c.secret_json, c.created_at]
    );
  }

  async getConnection(userId: string, provider: string): Promise<StoredConnection | undefined> {
    return (
      await this.all<StoredConnection>("SELECT * FROM connections WHERE user_id=? AND provider=? LIMIT 1", [userId, provider])
    )[0];
  }

  async listConnections(userId?: string): Promise<Array<{ provider: string; label: string; created_at: number }>> {
    const rows = userId
      ? await this.all<StoredConnection>("SELECT * FROM connections WHERE user_id=? ORDER BY created_at DESC", [userId])
      : await this.all<StoredConnection>("SELECT * FROM connections ORDER BY created_at DESC LIMIT 100");
    return rows.map((x) => ({ provider: x.provider, label: x.label, created_at: x.created_at }));
  }

  async deleteConnection(userId: string, provider: string): Promise<void> {
    await this.run("DELETE FROM connections WHERE user_id=? AND provider=?", [userId, provider]);
  }

  async addMessage(m: StoredMessage): Promise<void> {
    await this.run("INSERT INTO messages (id, user_id, role, text, created_at) VALUES (?,?,?,?,?)", [
      m.id, m.user_id, m.role, m.text, m.created_at,
    ]);
    await this.run(
      "DELETE FROM messages WHERE user_id=? AND id NOT IN (SELECT id FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT 60)",
      [m.user_id, m.user_id]
    );
  }

  async recentMessages(userId: string, n = 6): Promise<StoredMessage[]> {
    return (
      await this.all<StoredMessage>("SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT ?", [userId, n])
    ).reverse();
  }

  async saveConnector(c: StoredConnector): Promise<void> {
    await this.run(
      "INSERT INTO connectors (id, name, description_en, base_url, spec_json, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description_en=excluded.description_en, base_url=excluded.base_url, spec_json=excluded.spec_json",
      [c.id, c.name, c.description_en, c.base_url, c.spec_json, c.created_at]
    );
  }

  async listConnectors(): Promise<StoredConnector[]> {
    return this.all<StoredConnector>("SELECT * FROM connectors ORDER BY created_at DESC LIMIT 100");
  }

  async getConnector(idOrName: string): Promise<StoredConnector | undefined> {
    return (
      await this.all<StoredConnector>("SELECT * FROM connectors WHERE id=? OR lower(name)=lower(?) LIMIT 1", [idOrName, idOrName])
    )[0];
  }

  async trackProvider(provider: string): Promise<void> {
    await this.run(
      "INSERT INTO usage_providers (provider, day, count) VALUES (?,?,1) ON CONFLICT(provider, day) DO UPDATE SET count=count+1",
      [provider, todayStr()]
    );
  }

  async providerUsageToday(): Promise<Record<string, number>> {
    const rows = await this.all<{ provider: string; count: number }>("SELECT provider, count FROM usage_providers WHERE day=?", [todayStr()]);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.provider] = r.count;
    return out;
  }

  async checkAndTrackChat(userId: string): Promise<string | null> {
    const rows = await this.all<{ chats: number; runs: number }>("SELECT chats, runs FROM usage_users WHERE user_id=? AND day=? LIMIT 1", [userId, todayStr()]);
    const cur = rows[0] ?? { chats: 0, runs: 0 };
    if (cur.chats >= this.limits.maxChats) {
      return `You've used today's ${this.limits.maxChats} free chats — they reset tomorrow. Your automations keep running meanwhile.`;
    }
    await this.run(
      "INSERT INTO usage_users (user_id, day, chats, runs) VALUES (?,?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET chats=chats+1",
      [userId, todayStr(), cur.chats + 1, cur.runs]
    );
    return null;
  }

  async checkAndTrackRun(userId: string): Promise<string | null> {
    const rows = await this.all<{ chats: number; runs: number }>("SELECT chats, runs FROM usage_users WHERE user_id=? AND day=? LIMIT 1", [userId, todayStr()]);
    const cur = rows[0] ?? { chats: 0, runs: 0 };
    if (cur.runs >= this.limits.maxRuns) {
      return `Today's ${this.limits.maxRuns} free runs are used up — they reset tomorrow. Say 'list' to review your automations.`;
    }
    await this.run(
      "INSERT INTO usage_users (user_id, day, chats, runs) VALUES (?,?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET runs=runs+1",
      [userId, todayStr(), cur.chats, cur.runs + 1]
    );
    return null;
  }

  async userUsageToday(userId: string): Promise<{ chats: number; runs: number }> {
    const rows = await this.all<{ chats: number; runs: number }>("SELECT chats, runs FROM usage_users WHERE user_id=? AND day=? LIMIT 1", [userId, todayStr()]);
    return rows[0] ?? { chats: 0, runs: 0 };
  }
}

let cached: { key: string; store: TursoStore } | null = null;

/** Singleton per URL — serverless functions reuse it across warm invocations. */
export function tursoStore(env: Record<string, string | undefined>): Store {
  const url = env.TURSO_DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? "";
  const token = env.TURSO_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;
  const key = `${url}|${token ? "tok" : "notok"}`;
  if (cached && cached.key === key) return cached.store;
  const client = createClient({ url, authToken: token });
  const store = new TursoStore(
    {
      execute: async (sql, args) => {
        const rs = await client.execute({ sql, args: (args ?? []) as never[] });
        return { rows: rs.rows as unknown as Array<Record<string, unknown>> };
      },
    },
    limitsOf(env)
  );
  cached = { key, store };
  return store;
}
