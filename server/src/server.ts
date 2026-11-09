import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';
import type { Deps } from './deps';

/** Request logs record only method and path: never headers, bodies or query strings (phones, keys, amounts). */
const safeLog = {
  serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, path: r.url.split('?')[0] }) },
};

export function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: { level: deps.config.logLevel, ...safeLog }, bodyLimit: 64 * 1024 });
  app.register(formbody);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ status: 'error', error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; message?: string; validation?: unknown };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ status: 'error', error: { code: 'INVALID_REQUEST', message: e.message } });
    }
    app.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ status: 'error', error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  // Platform readiness probe (PRD section 5): cheap, touches the database.
  app.get('/healthz', async (_req, reply) => {
    try {
      deps.db.prepare('SELECT 1').get();
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
