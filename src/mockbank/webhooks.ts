import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { nowIso, onReset } from "./state.js";
import { ok, fail } from "./envelope.js";

const fast = !!process.env.MOCK_FAST;
const secs = (s: number) => (fast ? Math.max(1, Math.round(s / 15)) : s) * 1000;
// 1 min, 5 min, 15 min, 1 h, 6 h
const RETRY = [60, 300, 900, 3600, 21600];

type Hook = { id: string; url: string; events: string[]; secret: string; createdAt: string };
type Attempt = { at: string; http_status: number | null; error: string | null; withheld?: boolean };
type Delivery = {
  event_id: string;
  webhook_id: string;
  event: string;
  url: string;
  status: "pending" | "delivered" | "failed";
  attempts: Attempt[];
  body: string;
};

const hooks = new Map<string, Hook>();
const deliveries: Delivery[] = [];
const timers: NodeJS.Timeout[] = [];

onReset(() => {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  hooks.clear();
  deliveries.length = 0;
});

async function attempt(d: Delivery, hook: Hook, withhold: boolean): Promise<boolean> {
  if (withhold) {
    d.attempts.push({ at: nowIso(), http_status: null, error: null, withheld: true });
    return false;
  }
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "sha256=" + createHmac("sha256", hook.secret).update(`${ts}.${d.body}`).digest("hex");
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-event": d.event,
        "x-forge-timestamp": ts,
        "x-forge-signature": sig,
      },
      body: d.body,
      signal: AbortSignal.timeout(10_000),
    });
    d.attempts.push({ at: nowIso(), http_status: res.status, error: null });
    return res.ok;
  } catch (e) {
    d.attempts.push({ at: nowIso(), http_status: null, error: (e as Error).message });
    return false;
  }
}

function run(d: Delivery, hook: Hook, n: number, withhold: boolean) {
  void attempt(d, hook, withhold).then((delivered) => {
    if (delivered) {
      d.status = "delivered";
      return;
    }
    if (n >= RETRY.length) {
      d.status = "failed";
      return;
    }
    timers.push(setTimeout(() => run(d, hook, n + 1, false), secs(RETRY[n])));
  });
}

export function emit(event: string, data: unknown, withholdFirst = false) {
  for (const hook of hooks.values()) {
    if (!hook.events.includes("*") && !hook.events.includes(event)) continue;
    const event_id = "evt_" + randomBytes(8).toString("hex");
    const body = JSON.stringify({ event_id, event, created_at: nowIso(), data });
    const d: Delivery = {
      event_id, webhook_id: hook.id, event, url: hook.url, status: "pending", attempts: [], body,
    };
    deliveries.push(d);
    run(d, hook, 0, withholdFirst);
  }
}

export async function webhookRoutes(v1: FastifyInstance) {
  v1.post<{ Body: { url?: string; events?: string[] } }>("/webhooks", async (req, reply) => {
    const { url, events } = req.body ?? {};
    if (!url || !/^https?:\/\//.test(url)) {
      return fail(reply, "INVALID_REQUEST", "url must be an http(s) URL", { field: "url" });
    }
    if (!Array.isArray(events) || events.length === 0) {
      return fail(reply, "INVALID_REQUEST", "events must be a non-empty array", { field: "events" });
    }
    const hook: Hook = {
      id: "wh_" + randomBytes(4).toString("hex"),
      url, events,
      secret: process.env.MOCK_WH_SECRET ?? "whsec_" + randomBytes(16).toString("hex"),
      createdAt: nowIso(),
    };
    hooks.set(hook.id, hook);
    // The secret is returned ONCE, at registration
    return ok(
      reply,
      { id: hook.id, url, events, webhook_secret: hook.secret, status: "active", created_at: hook.createdAt },
      "Webhook registered",
      null,
      201
    );
  });

  v1.get("/webhooks", async (_req, reply) =>
    ok(reply, [...hooks.values()].map((h) => ({ id: h.id, url: h.url, events: h.events, status: "active", created_at: h.createdAt })))
  );

  v1.delete<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    if (!hooks.delete(req.params.id)) return fail(reply, "NOT_FOUND", "Webhook not found");
    return ok(reply, { deleted: true });
  });

  v1.post("/webhooks/test", async (_req, reply) => {
    emit("webhook.test", { message: "Test delivery" });
    return ok(reply, { sent: true });
  });

  v1.get("/webhooks/deliveries", async (_req, reply) =>
    ok(
      reply,
      [...deliveries].reverse().map((d) => ({
        event_id: d.event_id, webhook_id: d.webhook_id, event: d.event, url: d.url,
        status: d.status, attempts: d.attempts,
      }))
    )
  );

  v1.post<{ Params: { id: string } }>("/webhooks/deliveries/:id/replay", async (req, reply) => {
    const d = deliveries.find((x) => x.event_id === req.params.id);
    const hook = d && hooks.get(d.webhook_id);
    if (!d || !hook) return fail(reply, "NOT_FOUND", "Delivery not found");
    d.status = "pending";
    run(d, hook, 0, false); // same event_id on purpose: receivers must de-dupe
    return ok(reply, { event_id: d.event_id, replayed: true });
  });
}