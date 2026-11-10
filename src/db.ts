import Database from "better-sqlite3";
import { migrations } from "./migrations/index.js";

export const db = new Database(process.env.DB_PATH ?? "./kobo.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

export function migrate(): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const done = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id)
  );
  let applied = 0;
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        m.id,
        new Date().toISOString()
      );
    })();
    applied++;
  }
  return applied;
}