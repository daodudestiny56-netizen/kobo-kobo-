import Fastify from "fastify";
import { db, migrate } from "./db.js";
import { bank } from "./bank/index.js";
import { startCollector } from "./collector.js";
import { webhookPlugin, ensureWebhook } from "./webhooks/receiver.js";
import { onboardingRoutes } from "./onboarding/routes.js";
import { onOnboard } from "./onboarding/service.js";
import { createPensionAccountOnboardingHook } from "./pension/onboarding.js";

const app = Fastify({ logger: true, trustProxy: true });

const applied = migrate();
app.log.info({ applied }, "migrations applied");
onOnboard(createPensionAccountOnboardingHook(db));
const hasKey = !!(process.env.BANK_API_KEY || process.env.GATEWAY_KEY);
const engineRuntimePath = "../server/src/integration/root-runtime.ts";
const { registerEngineRuntime } = await import(engineRuntimePath);
const engineRuntime = registerEngineRuntime(app, db, bank, hasKey);
app.addHook("onClose", async () => engineRuntime.stop());
if (hasKey) startCollector();
await app.register(webhookPlugin);
await app.register(onboardingRoutes);

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
    if (hasKey && process.env.DEMO_MODE === "1") {
      await engineRuntime.seedIfEmpty().catch((error: unknown) =>
        app.log.warn(`demo seed failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    if (!hasKey) return;
    await ensureWebhook().catch((e) => app.log.warn(`webhook registration failed: ${e.message}`));
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });