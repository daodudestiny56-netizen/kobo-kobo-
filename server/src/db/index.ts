import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;
export type Row = Record<string, unknown>;

/** One process owns the database. WAL + a busy timeout keep readers from blocking the single writer. */
export function openDb(path = ':memory:'): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Run `fn` atomically. `fn` is synchronous on purpose: with better-sqlite3 nothing can interleave inside it, so
 * every check-then-write inside a transaction is race-free. Do bank calls OUTSIDE (before or after), never inside.
 * Nested calls become savepoints.
 */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}

const here = dirname(fileURLToPath(import.meta.url));

/** Apply migrations/NNN_name.sql in order, once each, tracked in `_migrations`. */
export function migrate(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const dir = join(here, 'migrations');
  const done = new Set((db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    tx(db, () => {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    });
    applied.push(f);
  }
  return applied;
}

export const iso = (d: Date) => d.toISOString();
