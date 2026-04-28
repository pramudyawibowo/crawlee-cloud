/**
 * Scaler routes - operational endpoints for the auto-scaler.
 *
 * Admin-only because the response includes runner IPs, queue
 * depth, and scaler config — sensitive operational data.
 */

import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../auth/middleware.js';
import { getScalerStatus } from '../scaler/index.js';

export const scalerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/scaler/status', async () => {
    return { data: await getScalerStatus() };
  });
};
