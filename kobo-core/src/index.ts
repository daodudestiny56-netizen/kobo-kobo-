import { loadConfig, productionProblems } from './config';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import type { Deps } from './deps';
import { HttpExecutor } from './executors/http';
import { MockExecutor } from './executors/mock';
import { AllowAllGuard, ThresholdGuard } from './guard';
import { HttpGuard } from './guard-http';
import { startSmsDispatcher } from './sms/dispatcher';
import { AfricasTalkingProvider, ConsoleSmsProvider } from './sms/provider';
import { buildServer } from './server';
import { startVoiceDispatcher } from './voice/service';
import { AfricasTalkingVoiceProvider, ConsoleVoiceProvider } from './voice/provider';
import { startScheduler } from './sweeps/scheduler';

const config = loadConfig();
const problems = productionProblems(config);
if (problems.length) {
  console.error(`[boot] refusing to start in production:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandled rejection', e);
  process.exit(1); // a supervisor restarts us; carrying on in an unknown state is worse
});
const pool = createPool(config.databaseUrl);

const executor =
  config.executorMode === 'http' ? new HttpExecutor(config.railsBaseUrl, config.railsServiceToken) : new MockExecutor(BigInt(config.mockDefaultBalanceNaira) * 100n);
if (executor instanceof MockExecutor) console.warn('[boot] EXECUTOR_MODE=mock: no real money moves. Set EXECUTOR_MODE=http for the Rails executor.');

const sms =
  config.sms.provider === 'africastalking'
    ? new AfricasTalkingProvider(config.sms.atUsername, config.sms.atApiKey, config.sms.atSenderId)
    : new ConsoleSmsProvider(true);
if (sms instanceof ConsoleSmsProvider) console.warn('[boot] SMS_PROVIDER=console: messages are printed, not sent.');

const voice =
  config.voice.provider === 'africastalking'
    ? new AfricasTalkingVoiceProvider(config.sms.atUsername, config.sms.atApiKey, config.voice.callFrom)
    : new ConsoleVoiceProvider(true);
if (voice instanceof ConsoleVoiceProvider) console.warn('[boot] VOICE_PROVIDER=console: calls are printed, not placed.');

const guard =
  config.guard.url ? new HttpGuard(config.guard.url, config.guard.token, config.guard.timeoutMs, config.guard.failClosed) : config.guard.holdAboveNaira > 0 ? new ThresholdGuard(BigInt(config.guard.holdAboveNaira) * 100n) : new AllowAllGuard();
if (guard instanceof ThresholdGuard) console.warn(`[boot] GUARD_HOLD_ABOVE_NAIRA=${config.guard.holdAboveNaira}: simple threshold guard active (AI guard not wired).`);

if (process.env.RUN_MIGRATIONS === 'true') {
  const applied = await migrate(pool);
  console.log(applied.length ? `[boot] migrations applied: ${applied.join(', ')}` : '[boot] migrations: up to date');
}

const deps: Deps = { db: pool, config, clock: () => new Date(), executor, guard, sms, voice };

const app = buildServer(deps);
const scheduler = config.scheduler.enabled ? startScheduler(deps) : null;
const dispatcher = config.scheduler.enabled ? startSmsDispatcher(deps) : null;
const voiceDispatcher = config.scheduler.enabled ? startVoiceDispatcher(deps) : null;

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[boot] kobo-core listening on :${config.port} (scheduler ${scheduler ? 'on' : 'off'})`);

const shutdown = async (signal: string) => {
  console.log(`[boot] ${signal}: shutting down`);
  scheduler?.stop();
  dispatcher?.stop();
  voiceDispatcher?.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
