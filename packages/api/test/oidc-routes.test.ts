import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { authRoutes } from '../src/routes/auth.js';
import { config } from '../src/config.js';

const mockPoolQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

vi.mock('../src/auth/index.js', () => ({
  verifyPassword: vi.fn().mockResolvedValue(true),
  createToken: vi.fn().mockReturnValue('mock_jwt_token_123'),
  generateApiKey: vi.fn().mockReturnValue('cp_mock_key'),
  hashApiKey: vi.fn().mockResolvedValue('hashed_api_key'),
  sha256ApiKey: vi.fn().mockReturnValue('a'.repeat(64)),
}));

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'user-1', email: 'test@example.com', role: 'user' };
  },
}));

// Mock oidc helper functions
const mockGetOidcAuthorizationUrl = vi.fn();
const mockConsumeOidcState = vi.fn();
const mockExchangeOidcCode = vi.fn();
const mockFetchOidcUserProfile = vi.fn();
const mockFindOrCreateOidcUser = vi.fn();

vi.mock('../src/auth/oidc.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    getOidcAuthorizationUrl: (...args: unknown[]) => mockGetOidcAuthorizationUrl(...args),
    consumeOidcState: (...args: unknown[]) => mockConsumeOidcState(...args),
    exchangeOidcCode: (...args: unknown[]) => mockExchangeOidcCode(...args),
    fetchOidcUserProfile: (...args: unknown[]) => mockFetchOidcUserProfile(...args),
    findOrCreateOidcUser: (...args: unknown[]) => mockFindOrCreateOidcUser(...args),
  };
});

describe('OIDC Auth Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await authRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /v2/auth/providers', () => {
    it('returns providers info including OIDC status', async () => {
      config.oidcEnabled = true;
      config.oidcProviderName = 'Keycloak SSO';

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/providers',
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.data.password).toBe(true);
      expect(json.data.oidc.enabled).toBe(true);
      expect(json.data.oidc.name).toBe('Keycloak SSO');
      expect(json.data.oidc.loginUrl).toBe('/v2/auth/oidc/login');
    });
  });

  describe('GET /v2/auth/oidc/login', () => {
    it('returns 404 if OIDC is disabled', async () => {
      config.oidcEnabled = false;

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/oidc/login',
      });

      expect(response.statusCode).toBe(404);
    });

    it('redirects to IdP authorization URL when OIDC is enabled', async () => {
      config.oidcEnabled = true;
      mockGetOidcAuthorizationUrl.mockResolvedValueOnce({
        url: 'https://auth.company.com/auth?client_id=crawlee',
        state: 'test-state-123',
        nonce: 'test-nonce-123',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/oidc/login?return_to=https://app.example.com',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('https://auth.company.com/auth?client_id=crawlee');
      expect(mockGetOidcAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          returnTo: 'https://app.example.com',
        })
      );
    });
  });

  describe('GET /v2/auth/oidc/callback', () => {
    it('redirects with error if provider returned an error', async () => {
      config.oidcEnabled = true;

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/oidc/callback?error=access_denied&error_description=User+cancelled+login',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('/login?error=');
    });

    it('redirects with error if state is invalid or expired', async () => {
      config.oidcEnabled = true;
      mockConsumeOidcState.mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/oidc/callback?code=auth-code-123&state=expired-state',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('Invalid+or+expired+OIDC+state');
    });

    it('successfully processes callback, registers user, and redirects with JWT token', async () => {
      config.oidcEnabled = true;
      config.oidcRolesClaim = 'realm_access.roles';
      config.oidcAdminRoles = ['admin', 'devops'];
      config.oidcDefaultRole = 'user';

      mockConsumeOidcState.mockResolvedValueOnce({
        nonce: 'nonce-123',
        redirectUri: 'https://api.example.com/v2/auth/oidc/callback',
        returnTo: 'https://dashboard.example.com',
        createdAt: Date.now(),
      });

      mockExchangeOidcCode.mockResolvedValueOnce({
        access_token: 'at_123',
        id_token: 'id_123',
        token_type: 'Bearer',
      });

      mockFetchOidcUserProfile.mockResolvedValueOnce({
        sub: 'oidc-user-sub-99',
        email: 'developer@example.com',
        name: 'Jane Doe',
        rawClaims: {
          sub: 'oidc-user-sub-99',
          email: 'developer@example.com',
          name: 'Jane Doe',
          realm_access: {
            roles: ['DevOps', 'member'],
          },
        },
      });

      mockFindOrCreateOidcUser.mockResolvedValueOnce({
        id: 'usr_new_99',
        email: 'developer@example.com',
        name: 'Jane Doe',
        role: 'admin',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/oidc/callback?code=valid_code&state=valid_state',
      });

      expect(response.statusCode).toBe(302);
      expect(mockExchangeOidcCode).toHaveBeenCalledWith(
        'valid_code',
        'https://api.example.com/v2/auth/oidc/callback'
      );
      expect(mockFindOrCreateOidcUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'developer@example.com' }),
        'admin' // Mapped to admin because user has 'DevOps' role matching OIDC_ADMIN_ROLES
      );
      expect(response.headers.location).toBe(
        'https://dashboard.example.com/callback?token=mock_jwt_token_123'
      );
    });
  });
});
