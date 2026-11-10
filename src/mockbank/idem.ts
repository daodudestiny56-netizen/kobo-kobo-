import { createHash } from "node:crypto";

type Saved = { hash: string; code: number; payload: unknown };
const saved = new Map<string, Saved>();

const hash = (b: unknown) =>
  createHash("sha256").update(JSON.stringify(b ?? {})).digest("hex");

export function idemLookup(route: string, key: string, body: unknown):
  | { kind: "new" }
  | { kind: "replay"; code: number; payload: unknown }
  | { kind: "conflict" } {
  const s = saved.get(`${route}|${key}`);
  if (!s) return { kind: "new" };
  return s.hash === hash(body)
    ? { kind: "replay", code: s.code, payload: s.payload }
    : { kind: "conflict" };
}

export function idemSave(route: string, key: string, body: unknown, code: number, payload: unknown) {
  saved.set(`${route}|${key}`, { hash: hash(body), code, payload });
}

export function idemClear() {
  saved.clear();
}