// One-off: remove verify-live test rows from Turso. Reads creds from .dev.vars (git-ignored).
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const u = process.argv[2] ?? "verify-live";
await db.execute({ sql: "DELETE FROM runs WHERE flow_id IN (SELECT id FROM flows WHERE user_id=?)", args: [u] });
await db.execute({ sql: "DELETE FROM flows WHERE user_id=?", args: [u] });
for (const t of ["messages", "pending", "usage_users"]) {
  await db.execute({ sql: `DELETE FROM ${t} WHERE user_id=?`, args: [u] });
}
const left = await db.execute("SELECT (SELECT COUNT(*) FROM flows) f, (SELECT COUNT(*) FROM runs) r, (SELECT COUNT(*) FROM messages) m");
console.log(`cleaned user '${u}'. remaining rows:`, JSON.stringify(left.rows));
