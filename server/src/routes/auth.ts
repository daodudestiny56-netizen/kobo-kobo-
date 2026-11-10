import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps';
import { AppError } from '../errors';
import { same } from '../util/same';

/** Token presented as `Authorization: Bearer <token>` or `x-ops-token`. */
function presented(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const x = req.headers['x-ops-token'];
  return typeof x === 'string' ? x.trim() : '';
}

export function hasOpsAccess(deps: Deps, req: FastifyRequest): boolean {
  const token = deps.config.opsToken;
  // No token configured: open only outside production (a production boot refuses to start without one).
  if (!token) return deps.config.nodeEnv !== 'production';
  return same(presented(req), token);
}

export const requireOps = (deps: Deps) => async (req: FastifyRequest, _reply: FastifyReply) => {
  if (!hasOpsAccess(deps, req)) throw new AppError('UNAUTHORIZED', 'Missing or wrong ops token.', 401);
};

/** Demo controls exist only in demo mode; elsewhere they look like they are not there. */
export const requireDemo = (deps: Deps) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!deps.config.demoMode) throw new AppError('NOT_FOUND', 'Not found.', 404);
  await requireOps(deps)(req, reply);
};
