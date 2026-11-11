import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps';
import { channelRoutes } from './channels';
import { merchantRoutes } from './merchants';
import { opsRoutes } from './ops';
import { demoRoutes } from './demo';

export { ok } from './respond';

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (api) => {
    channelRoutes(api, deps);
    merchantRoutes(api, deps);
    opsRoutes(api, deps);
    demoRoutes(api, deps);
  }, { prefix: '/api/v1' });
}
