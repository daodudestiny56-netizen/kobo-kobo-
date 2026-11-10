import Fastify from "fastify";
import { db, migrate } from "./db.js";
import { startCollector } from "./collector.js";

const app = Fastify({ logger: true });

const applied = migrate();
app.log.info({ applied }, "migrations applied");
if (process.env.BANK_API_KEY || process.env.GATEWAY_KEY) startCollector();

app.get("/healthz", async () => {
  db.prepare("SELECT 1").get();
  return { ok: true };
});

app.get("/", async (_req, reply) =>
  reply
    .type("text/html")
    .send("<h1>Kobo Kobo</h1><p>Sandbox demo. Simulated components listed in About.</p>")
);

const port = Number(process.env.PORT ?? 8080);

app.listen({ host: "0.0.0.0", port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});