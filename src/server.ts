import Fastify from "fastify";
import { db, migrate } from "./db.js";
import { startCollector } from "./collector.js";
import { webhookPlugin, ensureWebhook } from "./webhooks/receiver.js";
import { onboardingRoutes } from "./onboarding/routes.js";
import { demoRoutes } from "./demo/routes.js";
import { seedIfEmpty } from "./demo/reset.js";

const app = Fastify({ logger: true, trustProxy: true });

const applied = migrate();
app.log.info({ applied }, "migrations applied");
const hasKey = !!(process.env.BANK_API_KEY || process.env.GATEWAY_KEY);
if (hasKey) startCollector();
await app.register(webhookPlugin);
await app.register(onboardingRoutes);
await app.register(demoRoutes);

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

app
  .listen({ host: "0.0.0.0", port })
  .then(async () => {
    if (!hasKey) return;
    if (process.env.DEMO_MODE === "1") await seedIfEmpty().catch((e) => app.log.warn(`demo seed failed: ${e.message}`));
    await ensureWebhook().catch((e) => app.log.warn(`webhook registration failed: ${e.message}`));
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });