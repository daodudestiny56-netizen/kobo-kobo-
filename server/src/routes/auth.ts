import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { same } from '../util/same';

/** Secret presented as `Authorization: Bearer <secret>`, `x-ops-token` or `x-demo-key`. */
function presented(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const x = req.headers['x-ops-token'] ?? req.headers['x-demo-key'];
  return typeof x === 'string' ? x.trim() : '';
}

/**
 * Who may use /ops and the destructive /demo controls:
 *  - a request carrying OPS_TOKEN (or DEMO_SECRET), or
 *  - anyone, when DEMO_MODE and DEMO_OPEN are both on (the web app does not send a token yet), or
 *  - anyone, when no secret is configured and this is not production.
 */
export function hasOpsAccess(deps: Deps, req: FastifyRequest): boolean {
  const { opsToken, demoSecret, demoMode, opsOpenInDemo, nodeEnv } = deps.config;
  const given = presented(req);
  if (given && ((opsToken && same(given, opsToken)) || (demoSecret && same(given, demoSecret)))) return true;
  if (demoMode && opsOpenInDemo) return true;
  return !opsToken && !demoSecret && nodeEnv !== 'production';
}

export const requireOps = (deps: Deps) => async (req: FastifyRequest, _reply: FastifyReply) => {
  if (!hasOpsAccess(deps, req)) throw new AppError('UNAUTHORIZED', 'Missing or wrong ops token.', 401);
};

/** Demo-only routes look like they do not exist outside demo mode. */
export const requireDemoMode = (deps: Deps) => async () => {
  if (!deps.config.demoMode) throw new AppError('NOT_FOUND', 'Not found.', 404);
};

/** Demo controls that change data: demo mode plus ops access. */
export const requireDemo = (deps: Deps) => async (req: FastifyRequest, reply: FastifyReply) => {
  await requireDemoMode(deps)();
  await requireOps(deps)(req, reply);
};
