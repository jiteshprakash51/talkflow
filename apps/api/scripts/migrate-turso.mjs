// Applies packages/db/migrations/*.sql to Turso (or any libSQL server).
// Usage:
//   $env:TURSO_DATABASE_URL="libsql://xxx.turso.io"; $env:TURSO_AUTH_TOKEN="..."
//   node apps/api/scripts/migrate-turso.mjs
import { createClient } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN for remote).");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const db = createClient({ url, authToken });

for (const f of files) {
  const sql = readFileSync(join(dir, f), "utf8");
  const stmts = sql.split(";").map((s) => s.trim()).filter(Boolean);
  await db.batch(stmts.map((s) => ({ sql: s, args: [] })));
  console.log(`applied ${f} (${stmts.length} statements)`);
}
console.log("turso migrated ok");
