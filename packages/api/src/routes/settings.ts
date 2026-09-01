/**
 * System Settings management routes (Admin only).
 *
 * GET  /v2/system/settings           - Get all effective settings (masked secrets)
 * PUT  /v2/system/settings/oidc      - Update OIDC / SSO configuration & role mapping
 * POST /v2/system/settings/oidc/test - Test connectivity to OIDC discovery endpoint
 * PUT  /v2/system/settings/execution - Update execution/run limits & pricing
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware.js';
import {
  getEffectiveOidcConfig,
  getEffectiveExecutionConfig,
  setSystemSetting,
  type OidcSystemSettings,
  type ExecutionSystemSettings,
} from '../storage/settings.js';
import { testOidcDiscovery } from '../auth/oidc.js';

const MASKED_SECRET = '••••••••';

const oidcUpdateSchema = z.object({
  enabled: z.boolean(),
  providerName: z.string().optional().default('SSO'),
  issuerUrl: z.string().optional().default(''),
  clientId: z.string().optional().default(''),
  clientSecret: z.string().optional(),
  scopes: z.string().optional().default('openid email profile groups'),
  redirectUri: z.string().optional(),
  rolesClaim: z.string().optional().default('roles'),
  adminRoles: z.array(z.string()).optional().default(['admin', 'crawlee-admins', 'devops']),
  defaultRole: z.enum(['admin', 'user']).optional().default('user'),
  autoRegister: z.boolean().optional().default(true),
});

const oidcTestSchema = z.object({
  issuerUrl: z.string().min(1),
});

const executionUpdateSchema = z.object({
  maxConcurrentRuns: z.number().int().positive(),
  defaultMemoryMb: z.number().int().positive(),
  defaultTimeoutSecs: z.number().int().positive(),
  apifyCuPrice: z.number().nonnegative(),
});

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * Helper to verify admin role.
   */
  function requireAdmin(
    role?: string,
    reply?: { status: (code: number) => { send: (body: unknown) => void } }
  ): boolean {
    if (role !== 'admin') {
      if (reply) {
        reply.status(403).send({ error: { message: 'Admin access required' } });
      }
      return false;
    }
    return true;
  }

  /**
   * GET /v2/system/settings - Get all effective platform settings
   */
  fastify.get('/system/settings', async (request, reply) => {
    if (!requireAdmin(request.user?.role, reply)) return;

    const oidc = await getEffectiveOidcConfig();
    const execution = await getEffectiveExecutionConfig();

    return reply.send({
      data: {
        oidc: {
          ...oidc,
          clientSecret: oidc.clientSecret ? MASKED_SECRET : '',
          isSecretSet: Boolean(oidc.clientSecret && oidc.clientSecret.length > 0),
        },
        execution,
      },
    });
  });

  /**
   * PUT /v2/system/settings/oidc - Update OIDC settings
   */
  fastify.put('/system/settings/oidc', async (request, reply) => {
    if (!requireAdmin(request.user?.role, reply)) return;

    const body = oidcUpdateSchema.parse(request.body);
    const current = await getEffectiveOidcConfig();

    // Preserve existing client secret if unchanged or masked
    let clientSecret = body.clientSecret;
    if (!clientSecret || clientSecret === MASKED_SECRET) {
      clientSecret = current.clientSecret;
    }

    const updated: OidcSystemSettings = {
      enabled: body.enabled,
      providerName: body.providerName.trim() || 'SSO',
      issuerUrl: body.issuerUrl.trim().replace(/\/+$/, ''),
      clientId: body.clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes: body.scopes.trim() || 'openid email profile groups',
      redirectUri: body.redirectUri ? body.redirectUri.trim() : undefined,
      rolesClaim: body.rolesClaim.trim() || 'roles',
      adminRoles: body.adminRoles.map((r) => r.trim()).filter(Boolean),
      defaultRole: body.defaultRole,
      autoRegister: body.autoRegister,
    };

    await setSystemSetting('auth.oidc', updated, request.user?.id);

    return reply.send({
      data: {
        ...updated,
        clientSecret: updated.clientSecret ? MASKED_SECRET : '',
        isSecretSet: Boolean(updated.clientSecret && updated.clientSecret.length > 0),
      },
    });
  });

  /**
   * POST /v2/system/settings/oidc/test - Test OIDC discovery endpoint
   */
  fastify.post('/system/settings/oidc/test', async (request, reply) => {
    if (!requireAdmin(request.user?.role, reply)) return;

    const body = oidcTestSchema.parse(request.body);
    const result = await testOidcDiscovery(body.issuerUrl);

    if (!result.success) {
      return reply.status(400).send({
        data: {
          success: false,
          error: result.error || 'Could not discover OIDC configuration',
        },
      });
    }

    return reply.send({
      data: {
        success: true,
        endpoints: {
          issuer: result.config?.issuer,
          authorization_endpoint: result.config?.authorization_endpoint,
          token_endpoint: result.config?.token_endpoint,
          userinfo_endpoint: result.config?.userinfo_endpoint,
          jwks_uri: result.config?.jwks_uri,
        },
      },
    });
  });

  /**
   * PUT /v2/system/settings/execution - Update execution defaults
   */
  fastify.put('/system/settings/execution', async (request, reply) => {
    if (!requireAdmin(request.user?.role, reply)) return;

    const body = executionUpdateSchema.parse(request.body);
    const updated: ExecutionSystemSettings = {
      maxConcurrentRuns: body.maxConcurrentRuns,
      defaultMemoryMb: body.defaultMemoryMb,
      defaultTimeoutSecs: body.defaultTimeoutSecs,
      apifyCuPrice: body.apifyCuPrice,
    };

    await setSystemSetting('system.execution', updated, request.user?.id);

    return reply.send({ data: updated });
  });
};
