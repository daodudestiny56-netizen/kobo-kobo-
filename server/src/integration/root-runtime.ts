import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { ZodError } from 'zod';
import type Database from 'better-sqlite3';
import type { BankClient } from '../../../src/bank/types.js';
import { registerBankEventHandler } from '../../../src/webhooks/receiver.js';
import { loadConfig, productionProblems } from '../config';
import { AppError } from '../errors';
import type { Deps } from '../deps';
import { registerRoutes } from '../routes';
import { AllowAllGuard, ThresholdGuard } from '../guard/port';
import { startScheduler } from '../sweeps/scheduler';
import { RootBankPort } from './root-bank';
import { toWire } from '../wire';
import { applyResult, getSweepByReference } from '../sweeps/engine';
import { applyWithdrawalResult, getWithdrawal } from '../withdrawals/service';
import { seedDemo } from '../demo/seed';
import { getMerchant } from '../merchants/service';
import { webMerchant } from '../web/mappers';

export interface IntegratedRuntime {
  /** A trader in the shape the web app reads (camelCase, epoch-ms times). */
  merchantView(merchantId: string): unknown;
  stop(): void;
  seedIfEmpty(): Promise<void>;
}

export function registerEngineRuntime(app: FastifyInstance, db: Database.Database, client: BankClient, bankConfigured: boolean): IntegratedRuntime {
  const config = loadConfig();
  const problems = productionProblems(config);
  if (problems.length) throw new Error(`Invalid production configuration: ${problems.join(' ')}`);
  if (!bankConfigured) config.scheduler.enabled = false;
  const deps: Deps = {
    db,
    config,
    clock: () => new Date(),
    bank: new RootBankPort(client, process.env.DEMO_MODE === '1'),
    guard: config.guardHoldAboveNaira === null
      ? new AllowAllGuard()
      : new ThresholdGuard(BigInt(config.guardHoldAboveNaira) * 100n),
  };

  app.register(formbody);
  app.register(async (api) => {
    api.setReplySerializer((payload) => JSON.stringify(toWire(payload)));
    api.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        const message = error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
        return reply.status(400).send({ status: 'error', error: { code: 'INVALID_REQUEST', message } });
      }
      if (error instanceof AppError) {
        return reply.status(error.status).send({ status: 'error', error: { code: error.code, message: error.message, details: error.details } });
      }
      const e = error as { statusCode?: number; message?: string };
      const status = e.statusCode;
      if (status && status < 500) {
        return reply.status(status).send({ status: 'error', error: { code: 'INVALID_REQUEST', message: e.message } });
      }
      app.log.error({ err: error }, 'engine request failed');
      return reply.status(500).send({ status: 'error', error: { code: 'INTERNAL', message: 'Something went wrong.' } });
    });
    registerRoutes(api, deps);
  });

  const unregisterEvent = registerBankEventHandler(async (event, data) => {
    if (!event.startsWith('transfer.')) return;
    const reference = data?.reference ?? data?.transfer_reference;
    if (typeof reference !== 'string' || reference.length === 0) return;
    const transfer = await deps.bank.getTransfer(reference);
    if (!transfer) return;
    const sweep = getSweepByReference(db, reference);
    if (sweep) {
      applyResult(deps, sweep.id, transfer);
      return;
    }
    const withdrawal = db.prepare('SELECT id FROM withdrawals WHERE bank_reference = ?').get(reference) as { id: string } | undefined;
    if (withdrawal && getWithdrawal(db, withdrawal.id)) applyWithdrawalResult(deps, withdrawal.id, transfer);
  });

  const stopScheduler = startScheduler(deps);
  return {
    merchantView: (merchantId) => toWire(webMerchant(deps, getMerchant(db, merchantId))),
    stop() {
      unregisterEvent();
      stopScheduler();
    },
    async seedIfEmpty() {
      if (!config.demoMode) return;
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM merchants').get() as { count: number };
      if (count === 0) await seedDemo(deps);
    },
  };
}
