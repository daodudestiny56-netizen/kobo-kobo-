import { describe, expect, it } from 'vitest';
import { openDb, tx } from '../src/db';

describe('database', () => {
  it('applies migrations once and enforces foreign keys', () => {
    const db = openDb();
    const names = db.prepare('SELECT name FROM _migrations').all();
    expect(names).toHaveLength(1);
    expect(() => db.prepare(`INSERT INTO consents (id, merchant_id, text_version, given_at) VALUES ('c','nope','v1','x')`).run()).toThrow(/FOREIGN KEY/);
  });
  it('rolls a transaction back on error', () => {
    const db = openDb();
    expect(() =>
      tx(db, () => {
        db.prepare(`INSERT INTO demo_state (key, value) VALUES ('a','1')`).run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) c FROM demo_state').get()).toEqual({ c: 0 });
  });
});
