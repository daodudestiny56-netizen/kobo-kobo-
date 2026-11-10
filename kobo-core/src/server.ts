import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from './errors';
import type { Deps } from './deps';
import { serviceAuth, webhookAuth } from './http/auth';
import { channelRoutes } from './routes/channels';
import { reconciliationRoutes } from './routes/reconciliation';
import { pinRoutes } from './routes/pin';
import { smartRateRoutes } from './routes/smart-rate';
import { guardRoutes } from './routes/guard';
import { pfaRoutes } from './routes/pfa';
import { splitRoutes } from './routes/split';
import { sweepRoutes } from './routes/sweeps';
import { withdrawalRoutes } from './routes/withdrawals';

/** A request line safe to log: no query string (it carries the webhook token), no headers, no body (USSD text carries PINs). */
export const safeRequestLog = (req: { method?: string; url?: string }) => ({ method: req.method, path: (req.url ?? '').split('?')[0] });

export function buildServer(deps: Deps, opts: { logStream?: NodeJS.WritableStream } = {}): FastifyInstance {
  const app = Fastify({
    // Structured request logs. Only method and path are logged (see safeRequestLog); error logs never include bodies.
    logger:
      deps.config.logLevel === 'silent'
        ? false
        : { level: deps.config.logLevel, ...(opts.logStream ? { stream: opts.logStream } : {}), serializers: { req: safeRequestLog } },
    bodyLimit: 64 * 1024, // every payload we accept is tiny; reject anything bigger early
  });
  app.register(formbody);

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    _req.log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  // Liveness plus a database round trip, so an orchestrator stops sending traffic to an instance that lost its database.
  app.get('/health', async (_req, reply) => {
    try {
      await deps.db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', reason: 'database' });
    }
  });

  // Internal API: Rails and ops call these with the service token.
  app.register(async (internal) => {
    internal.addHook('preHandler', serviceAuth(deps.config.serviceToken));
    splitRoutes(internal, deps);
    pfaRoutes(internal, deps);
    sweepRoutes(internal, deps);
    withdrawalRoutes(internal, deps);
    pinRoutes(internal, deps);
    smartRateRoutes(internal, deps);
    guardRoutes(internal, deps);
    reconciliationRoutes(internal, deps);
  });

  // Telco webhooks: USSD and inbound SMS.
  app.register(async (telco) => {
    telco.addHook('preHandler', webhookAuth(deps.config.webhookToken));
    channelRoutes(telco, deps);
  });

  return app;
}
