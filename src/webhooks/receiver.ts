import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { bank } from "../bank/index.js";
import { pollOnce } from "../collector.js";
import { verifySignature } from "./verify.js";
import { bankEvents } from "./events.js";

const EVENTS = ["transfer.pending", "transfer.successful", "transfer.failed", "transfer.reversed"];

// Held in memory only. The bank returns it once; we re-register on every boot, so a restart is safe.
let secret: string | null = null;
export const getWebhookSecret = () => secret ?? process.env.WEBHOOK_SECRET ?? null;

export async function ensureWebhook(): Promise<void> {
  const url = process.env.WEBHOOK_URL ?? "http://app.team07.svc.cluster.local/hooks/forge";
  for (const w of await bank.listWebhooks()) if (w.url === url) await bank.deleteWebhook(w.id);
  secret = (await bank.registerWebhook(url, EVENTS)).secret;
  console.log("[webhooks] registered");
}

// Webhooks arriving mid-poll trigger one more poll afterwards, so nothing is missed.
let running = false, again = false;
async function poll(): Promise<void> {
  if (running) { again = true; return; }
  running = true;
  try {
    do { again = false; await pollOnce(); } while (again);
  } finally {
    running = false;
  }
}

async function handle(event: string, d: any): Promise<void> {
  bankEvents.emit(event, d);
  const dest = d?.destination?.account_number;
  if (event === "transfer.successful" && dest && db.prepare("SELECT 1 FROM merchants WHERE bank_account = ?").get(dest)) {
    await poll(); // one source of truth for takings: the bank's rows, not the webhook body
  }
}

export async function webhookPlugin(app: FastifyInstance) {
  // Encapsulated: only this plugin's routes get the raw-string parser. The signature is over the RAW body.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_r, body, done) => done(null, body));

  app.post("/hooks/forge", async (req, reply) => {
    const raw = typeof req.body === "string" ? req.body : "";
    const key = getWebhookSecret();
    if (!key || !verifySignature(raw, String(req.headers["x-forge-timestamp"] ?? ""), String(req.headers["x-forge-signature"] ?? ""), key)) {
      return reply.code(401).send({ ok: false });
    }

    let evt: any;
    try { evt = JSON.parse(raw); } catch { return reply.code(400).send({ ok: false }); }
    const event: string = evt.event ?? evt.type ?? "unknown";
    const eventId: string = evt.event_id ?? evt.id ?? createHash("sha256").update(raw).digest("hex");

    const ins = db
      .prepare("INSERT OR IGNORE INTO webhook_events (event_id, type, received_at) VALUES (?, ?, ?)")
      .run(eventId, event, new Date().toISOString());
    if (ins.changes === 0) return reply.code(200).send({ ok: true, duplicate: true });

    console.log("[webhooks]", event, eventId); // no body, no account numbers
    void handle(event, evt.data).catch((e) => console.warn("[webhooks] handler:", (e as Error).message));
    return reply.code(200).send({ ok: true }); // answer fast: the bank wants a 2xx within 10s
  });
}
