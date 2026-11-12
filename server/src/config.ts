const int = (v: string | undefined, d: number) => {
  const n = v === undefined || v === '' ? d : Number(v);
  if (!Number.isInteger(n)) throw new Error(`Expected an integer, got "${v}"`);
  return n;
};
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

export interface Config {
  nodeEnv: string;
  port: number;
  logLevel: string;
  dbPath: string;
  /** Shared secret for /api/v1/ops/* and /api/v1/demo/*. Empty only allowed outside production. */
  opsToken: string;
  /** Shows the demo banner and enables /api/v1/demo/*. */
  demoMode: boolean;
  /** Demo only: the ops dashboard and demo controls need no token (the web app sends none yet). Explicit opt-in: DEMO_OPEN=1. */
  opsOpenInDemo: boolean;
  /** Alternative to OPS_TOKEN, sent as x-demo-key (same header the original demo controls used). */
  demoSecret: string;
  /** Bank account that pays the demo "customer pays" transfers when a real bank is connected. */
  demoPayerAccount: string;
  /** The stand-in "Access ARM collection (simulated)" account; sweeps go to it and withdrawals are paid from it. */
  collectionAccount: string;
  collectionLabel: string;
  /** Optional bank accounts for the demo traders (comma separated in DEMO_BANK_ACCOUNTS), e.g. the sandbox individuals. */
  demoBankAccounts: string[];
  /** Sandbox accounts the demo seed leaves un-enrolled (DEMO_UNENROLLED_ACCOUNTS), so a live sign-up can use them. */
  demoUnenrolledAccounts: string[];
  /** Also hold any single credit at or above this many naira, alongside the statistical guard, when set. */
  guardHoldAboveNaira: number | null;
  scheduler: { enabled: boolean; sweepCron: string; retryCron: string; requeryCron: string };
  sweep: { batchConcurrency: number; defaultDailyCapKobo: number; defaultBufferKobo: number };
  /** After a sweep settles, keep checking it this long in case the bank reverses it. */
  reversalWatchMinutes: number;
  vestingMonths: number;
  cooldownMonths: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    port: int(env.PORT, 8080),
    logLevel: env.LOG_LEVEL ?? 'info',
    dbPath: env.DB_PATH ?? './data/kobo.sqlite',
    opsToken: env.OPS_TOKEN ?? '',
    demoMode: bool(env.DEMO_MODE, nodeEnv !== 'production'),
    opsOpenInDemo: bool(env.DEMO_OPEN, false),
    demoSecret: env.DEMO_SECRET ?? '',
    demoPayerAccount: env.DEMO_PAYER_ACCOUNT ?? '0123456793',
    collectionAccount: env.COLLECTION_ACCOUNT ?? '0123456793',
    collectionLabel: 'Access ARM collection (simulated)',
    demoBankAccounts: (env.DEMO_BANK_ACCOUNTS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    demoUnenrolledAccounts: (env.DEMO_UNENROLLED_ACCOUNTS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    guardHoldAboveNaira: env.GUARD_HOLD_ABOVE_NAIRA ? int(env.GUARD_HOLD_ABOVE_NAIRA, 0) : null,
    scheduler: {
      enabled: bool(env.SCHEDULER_ENABLED, true),
      sweepCron: env.SWEEP_CRON ?? '0 23 * * *',
      retryCron: env.SWEEP_RETRY_CRON ?? '30 23 * * *',
      requeryCron: env.REQUERY_CRON ?? '* * * * *',
    },
    sweep: {
      batchConcurrency: int(env.SWEEP_BATCH_CONCURRENCY, 3), // the sandbox allows 60 requests a minute for the whole team
      defaultDailyCapKobo: 500_000,
      defaultBufferKobo: 100_000,
    },
    reversalWatchMinutes: int(env.REVERSAL_WATCH_MINUTES, 24 * 60),
    vestingMonths: int(env.VESTING_MONTHS, 3),
    cooldownMonths: int(env.COOLDOWN_MONTHS, 2),
  };
}

/** Misconfigurations that must stop a production boot. */
export function productionProblems(c: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  if (c.nodeEnv !== 'production') return [];
  const p: string[] = [];
  if (!c.opsToken && !c.demoSecret && !(c.demoMode && c.opsOpenInDemo)) p.push('OPS_TOKEN is empty: the ops dashboard and demo controls would be open to the internet.');
  if (!(env.BANK_API_KEY || env.GATEWAY_KEY)) p.push('BANK_API_KEY (or GATEWAY_KEY) is empty: bank collection and transfers cannot run.');
  return p;
}
