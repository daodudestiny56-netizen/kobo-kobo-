import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const spec = parse(readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
const srcDir = new URL('../src/', import.meta.url);

/** Every route registered in src (routes/*.ts and server.ts), as "METHOD /path/{param}". */
function registeredRoutes(): string[] {
  const files = [...readdirSync(new URL('routes/', srcDir)).map((f) => `routes/${f}`), 'server.ts'];
  const out: string[] = [];
  for (const f of files) {
    const text = readFileSync(new URL(f, srcDir), 'utf8');
    for (const m of text.matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) {
      out.push(`${m[1].toUpperCase()} ${m[2].replace(/:(\w+)/g, '{$1}')}`);
    }
  }
  return out;
}

const specOps = (filter: (path: string) => boolean): string[] =>
  Object.entries<Record<string, unknown>>(spec.paths)
    .filter(([p]) => filter(p))
    .flatMap(([p, ops]) => Object.keys(ops).filter((k) => ['get', 'post', 'put', 'delete', 'patch'].includes(k)).map((m) => `${m.toUpperCase()} ${p}`));

describe('OpenAPI spec', () => {
  it('documents exactly the routes core serves (the executor paths are Rails\' side)', () => {
    const documented = specOps((p) => !p.startsWith('/api/v1/executor/')).sort();
    expect(documented).toEqual([...new Set(registeredRoutes())].sort());
  });

  it('documents the four executor endpoints core calls', () => {
    expect(specOps((p) => p.startsWith('/api/v1/executor/')).sort()).toEqual([
      'GET /api/v1/executor/balance',
      'GET /api/v1/executor/debits',
      'POST /api/v1/executor/credit',
      'POST /api/v1/executor/debit',
    ]);
    const http = readFileSync(new URL('executors/http.ts', srcDir), 'utf8');
    for (const p of ['balance', 'debit', 'credit', 'debits']) expect(http).toContain(`/api/v1/executor/${p}`);
  });

  it('every $ref points at something that exists', () => {
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of refs) {
      const target = ref.split('/').reduce<any>((o, k) => o?.[k], spec);
      expect(target, `missing ${ref}`).toBeTruthy();
    }
  });

  it('sweep statuses match the database constraint', () => {
    const sql = readFileSync(new URL('../migrations/001_init_schema.sql', import.meta.url), 'utf8');
    const m = sql.match(/chk_sweep_status CHECK \(status IN\s*\(([^)]+)\)/)!;
    const db = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
    expect([...spec.components.schemas.Sweep.properties.status.enum].sort()).toEqual(db);
  });
});
