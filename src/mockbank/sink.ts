import Fastify from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";

const secret = process.env.WH_SECRET ?? "";
const app = Fastify();
app.addContentTypeParser("application/json", { parseAs: "string" }, (_r, body, done) => done(null, body));
const seen = new Set<string>();

app.post("/hooks/forge", async (req, reply) => {
  const raw = req.body as string;
  const ts = String(req.headers["x-forge-timestamp"]);
  const sig = String(req.headers["x-forge-signature"]);
  const mac = "sha256=" + createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  const good = sig.length === mac.length && timingSafeEqual(Buffer.from(sig), Buffer.from(mac));
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
  const evt = JSON.parse(raw);
  const dup = seen.has(evt.event_id);
  if (good && fresh) seen.add(evt.event_id);
  console.log(new Date().toISOString(), evt.event, evt.event_id, { good, fresh, dup });
  return reply.code(good && fresh ? 200 : 401).send({ ok: good && fresh });
});

app.listen({ host: "127.0.0.1", port: 8081 }).then(() => console.log("sink on :8081"));