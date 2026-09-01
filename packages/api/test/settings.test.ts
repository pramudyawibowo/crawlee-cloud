import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { settingsRoutes } from '../src/routes/settings.js';

const mockPoolQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

let mockUserRole = 'admin';

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'admin-1', email: 'admin@crawlee.cloud', role: mockUserRole };
  },
}));

const mockTestOidcDiscovery = vi.fn();
vi.mock('../src/auth/oidc.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    testOidcDiscovery: (...args: unknown[]) => mockTestOidcDiscovery(...args),
  };
});

describe('System Settings Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(settingsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockUserRole = 'admin';
    mockPoolQuery.mockReset();
    mockTestOidcDiscovery.mockReset();
  });

  describe('GET /v2/system/settings', () => {
    it('rejects non-admin users with 403', async () => {
      mockUserRole = 'user';

      const response = await app.inject({
        method: 'GET',
        url: '/v2/system/settings',
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns system settings for admin', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            value: {
              enabled: true,
              providerName: 'Keycloak',
              issuerUrl: 'https://auth.company.com/realms/main',
              clientId: 'crawlee-client',
              clientSecret: 'super-secret-key-12345',
              scopes: 'openid email profile',
              rolesClaim: 'realm_access.roles',
              adminRoles: ['admin', 'devops'],
              defaultRole: 'user',
              autoRegister: true,
            },
          },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/system/settings',
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.data.oidc.enabled).toBe(true);
      expect(json.data.oidc.providerName).toBe('Keycloak');
      expect(json.data.oidc.clientSecret).toBe('••••••••');
      expect(json.data.oidc.isSecretSet).toBe(true);
      expect(json.data.execution.maxConcurrentRuns).toBeDefined();
    });
  });

  describe('PUT /v2/system/settings/oidc', () => {
    it('rejects non-admin users with 403', async () => {
      mockUserRole = 'user';

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/system/settings/oidc',
        body: { enabled: true },
      });

      expect(response.statusCode).toBe(403);
    });

    it('saves updated OIDC configuration and preserves secret if masked', async () => {
      // Mock current getEffectiveOidcConfig
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            value: {
              clientSecret: 'existing-real-secret',
            },
          },
        ],
      });

      // Mock update query
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/system/settings/oidc',
        body: {
          enabled: true,
          providerName: 'Authentik',
          issuerUrl: 'https://authentik.company.com/application/o/crawlee/',
          clientId: 'crawlee-app',
          clientSecret: '••••••••', // Masked secret
          rolesClaim: 'groups',
          adminRoles: ['superadmin', 'crawlee-admins'],
          defaultRole: 'user',
          autoRegister: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.data.enabled).toBe(true);
      expect(json.data.providerName).toBe('Authentik');
      expect(json.data.clientSecret).toBe('••••••••');
      expect(json.data.isSecretSet).toBe(true);
    });
  });

  describe('POST /v2/system/settings/oidc/test', () => {
    it('returns discovery endpoints on success', async () => {
      mockTestOidcDiscovery.mockResolvedValueOnce({
        success: true,
        config: {
          issuer: 'https://auth.company.com/realms/main',
          authorization_endpoint:
            'https://auth.company.com/realms/main/protocol/openid-connect/auth',
          token_endpoint: 'https://auth.company.com/realms/main/protocol/openid-connect/token',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/system/settings/oidc/test',
        body: { issuerUrl: 'https://auth.company.com/realms/main' },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.data.success).toBe(true);
      expect(json.data.endpoints.authorization_endpoint).toContain('/auth');
    });

    it('returns error when discovery fails', async () => {
      mockTestOidcDiscovery.mockResolvedValueOnce({
        success: false,
        error: 'Connection refused (HTTP 500)',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/system/settings/oidc/test',
        body: { issuerUrl: 'https://invalid-oidc-domain.com' },
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.body);
      expect(json.data.success).toBe(false);
      expect(json.data.error).toContain('Connection refused');
    });
  });

  describe('PUT /v2/system/settings/execution', () => {
    it('updates execution defaults', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/system/settings/execution',
        body: {
          maxConcurrentRuns: 20,
          defaultMemoryMb: 2048,
          defaultTimeoutSecs: 7200,
          apifyCuPrice: 0.5,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.data.maxConcurrentRuns).toBe(20);
      expect(json.data.defaultMemoryMb).toBe(2048);
      expect(json.data.defaultTimeoutSecs).toBe(7200);
      expect(json.data.apifyCuPrice).toBe(0.5);
    });
  });
});
