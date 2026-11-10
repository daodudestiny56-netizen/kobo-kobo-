import 'dotenv/config';

const int = (v: string | undefined, d: number): number => (v === undefined || v === '' ? d : Number(v));
const bool = (v: string | undefined, d: boolean): boolean => (v === undefined || v === '' ? d : v === 'true');

export interface SweepTuning {
  /** Merchants processed in parallel during the nightly batch. */
  batchConcurrency: number;
  /** Debit attempts inside a single run (with exponential backoff between them). */
  inRunTries: number;
  /** Total debit attempts across all runs of the night before a sweep is marked FAILED. */
  maxAttempts: number;
  backoffBaseMs: number;
}

export interface AppConfig {
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  port: number;
  serviceToken: string;
  webhookToken: string;
  executorMode: 'mock' | 'http';
  /** Balance (naira) the mock executor reports for any account it was not told about. Demo/dev only. */
  mockDefaultBalanceNaira: number;
  railsBaseUrl: string;
  railsServiceToken: string;
  scheduler: { enabled: boolean; sweepCron: string; retryCron: string };
  sweep: SweepTuning;
  pin: { pepper: string; maxAttempts: number; lockMinutes: number; withdrawalRequired: boolean };
  voice: { provider: 'console' | 'africastalking'; callFrom: string; maxAttempts: number; retryBaseMs: number; callTimeoutMs: number; dispatchIntervalMs: number };
  guard: { releaseWindowDays: number; holdAboveNaira: number; url: string; token: string; timeoutMs: number; failClosed: boolean };
  smartRate: { expiryHours: number; declineCooldownDays: number };
  sms: {
    provider: 'console' | 'africastalking';
    atUsername: string;
    atApiKey: string;
    atSenderId: string;
    dispatchIntervalMs: number;
    maxAttempts: number;
    /** First retry delay for a failed send; doubles each attempt. */
    retryBaseMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/kobo',
    port: int(env.PORT, 3000),
    serviceToken: env.SERVICE_TOKEN ?? '',
    webhookToken: env.WEBHOOK_TOKEN ?? '',
    executorMode: env.EXECUTOR_MODE === 'http' ? 'http' : 'mock',
    mockDefaultBalanceNaira: int(env.MOCK_DEFAULT_BALANCE_NAIRA, 0),
    railsBaseUrl: env.RAILS_BASE_URL ?? 'http://localhost:3001',
    railsServiceToken: env.RAILS_SERVICE_TOKEN ?? '',
    scheduler: {
      enabled: bool(env.SCHEDULER_ENABLED, true),
      sweepCron: env.SWEEP_CRON ?? '0 23 * * *',
      retryCron: env.SWEEP_RETRY_CRON ?? '30 23 * * *',
    },
    sweep: {
      batchConcurrency: int(env.SWEEP_BATCH_CONCURRENCY, 10),
      inRunTries: int(env.SWEEP_IN_RUN_TRIES, 3),
      maxAttempts: int(env.SWEEP_MAX_ATTEMPTS, 6),
      backoffBaseMs: int(env.SWEEP_BACKOFF_BASE_MS, 1000),
    },
    pin: {
      // Server-side secret mixed into every PIN hash. Set it in production; changing it invalidates all PINs.
      pepper: env.PIN_PEPPER ?? '',
      maxAttempts: int(env.PIN_MAX_ATTEMPTS, 3),
      lockMinutes: int(env.PIN_LOCK_MINUTES, 30),
      withdrawalRequired: bool(env.WITHDRAWAL_PIN_REQUIRED, true),
    },
    voice: {
      provider: env.VOICE_PROVIDER === 'africastalking' ? 'africastalking' : 'console',
      callFrom: env.AT_VOICE_NUMBER ?? '',
      maxAttempts: int(env.VOICE_MAX_ATTEMPTS, 3),
      retryBaseMs: int(env.VOICE_RETRY_BASE_MS, 60_000),
      // How long a placed call may stay unanswered before we try again.
      callTimeoutMs: int(env.VOICE_CALL_TIMEOUT_MS, 300_000),
      dispatchIntervalMs: int(env.VOICE_DISPATCH_INTERVAL_MS, 10_000),
    },
    // 0 = off. A simple rule-based stand-in until the AI Sweep Guard is wired in: hold any night above this many naira.
    guard: { releaseWindowDays: int(env.GUARD_RELEASE_WINDOW_DAYS, 3), holdAboveNaira: int(env.GUARD_HOLD_ABOVE_NAIRA, 0), url: env.GUARD_URL ?? '', token: env.GUARD_TOKEN ?? '', timeoutMs: int(env.GUARD_TIMEOUT_MS, 3000), failClosed: env.GUARD_FAIL_CLOSED === 'true' },
    smartRate: { expiryHours: int(env.SMART_RATE_EXPIRY_HOURS, 72), declineCooldownDays: int(env.SMART_RATE_DECLINE_COOLDOWN_DAYS, 14) },
    sms: {
      provider: env.SMS_PROVIDER === 'africastalking' ? 'africastalking' : 'console',
      atUsername: env.AT_USERNAME ?? 'sandbox',
      atApiKey: env.AT_API_KEY ?? '',
      atSenderId: env.AT_SENDER_ID ?? '',
      dispatchIntervalMs: int(env.SMS_DISPATCH_INTERVAL_MS, 5000),
      maxAttempts: int(env.SMS_MAX_ATTEMPTS, 5),
      retryBaseMs: int(env.SMS_RETRY_BASE_MS, 30_000),
    },
  };
}

/**
 * Refuse to boot a production process that would run open or fake. In production the shared secrets must be set,
 * the PIN pepper must be set, and the bank must be the real executor. Returns the problems (empty = fine).
 */
export function productionProblems(c: AppConfig): string[] {
  if (c.nodeEnv !== 'production') return [];
  const out: string[] = [];
  if (!c.serviceToken) out.push('SERVICE_TOKEN is empty: internal endpoints would be open');
  if (!c.webhookToken) out.push('WEBHOOK_TOKEN is empty: telco webhooks would be open');
  if (!c.pin.pepper) out.push('PIN_PEPPER is empty');
  if (c.executorMode !== 'http') out.push('EXECUTOR_MODE is not "http": no real money would move');
  return out;
}
