import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { organizationsRoutes } from '../src/routes/organizations.js';
import { syncUserOidcGroups } from '../src/storage/organizations.js';

const mockPoolQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

let mockUserId = 'user-1';
let mockUserRole = 'user';

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: mockUserId, email: 'tester@crawlee.cloud', role: mockUserRole };
  },
}));

describe('Organizations and Teams API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(organizationsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockUserId = 'user-1';
    mockUserRole = 'user';
    mockPoolQuery.mockReset();
  });

  describe('GET /v2/organizations', () => {
    it('returns list of organizations for current user', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'org-1',
            name: 'Scraper Team',
            slug: 'scraper-team',
            member_role: 'owner',
            member_count: 3,
            created_at: new Date().toISOString(),
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v2/organizations',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].name).toBe('Scraper Team');
      expect(body.data.items[0].member_role).toBe('owner');
    });
  });

  describe('POST /v2/organizations', () => {
    it('creates organization and returns 201', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'org-new',
              name: 'ADS Scraper',
              slug: 'ads-scraper',
              description: 'Shared scraper workspace',
              oidc_group: 'ads-scrapers',
              created_at: new Date().toISOString(),
              modified_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // insert member

      const res = await app.inject({
        method: 'POST',
        url: '/v2/organizations',
        payload: {
          name: 'ADS Scraper',
          slug: 'ads-scraper',
          description: 'Shared scraper workspace',
          oidcGroup: 'ads-scrapers',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('ADS Scraper');
      expect(body.data.slug).toBe('ads-scraper');
    });
  });

  describe('GET /v2/organizations/:id', () => {
    it('returns organization details and members if user is member', async () => {
      // Check membership
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'mem-1', org_id: 'org-1', user_id: 'user-1', role: 'admin' }],
      });
      // Get org by ID
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'org-1', name: 'Scraper Team', slug: 'scraper-team' }],
      });
      // Get members
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-1',
            org_id: 'org-1',
            user_id: 'user-1',
            role: 'admin',
            user_email: 'tester@crawlee.cloud',
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v2/organizations/org-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('Scraper Team');
      expect(body.data.myRole).toBe('admin');
      expect(body.data.members).toHaveLength(1);
    });

    it('rejects with 403 if user is not member and not admin', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await app.inject({
        method: 'GET',
        url: '/v2/organizations/org-secret',
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /v2/organizations/:id/members', () => {
    it('adds a registered user as team member', async () => {
      // Check admin access
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'mem-1', org_id: 'org-1', user_id: 'user-1', role: 'owner' }],
      });
      // Lookup user by email
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'user-2', email: 'colleague@crawlee.cloud', name: 'Colleague' }],
      });
      // Insert/update membership
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Get updated members list
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { id: 'mem-1', user_id: 'user-1', role: 'owner' },
          { id: 'mem-2', user_id: 'user-2', role: 'member' },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v2/organizations/org-1/members',
        payload: {
          email: 'colleague@crawlee.cloud',
          role: 'member',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.member.user_email).toBe('colleague@crawlee.cloud');
      expect(body.data.members).toHaveLength(2);
    });

    it('returns 404 if email is not found in database', async () => {
      // Check admin access
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'mem-1', org_id: 'org-1', user_id: 'user-1', role: 'admin' }],
      });
      // Lookup user by email - not found
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/v2/organizations/org-1/members',
        payload: {
          email: 'unknown@crawlee.cloud',
          role: 'member',
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('syncUserOidcGroups', () => {
    it('automatically joins or creates organizations for OIDC group claims', async () => {
      // 1. Check existing org for group 'devops' -> found
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'org-devops', name: 'devops', slug: 'devops' }],
      });
      // 2. Add member to org-devops
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await syncUserOidcGroups('user-1', ['devops']);

      expect(mockPoolQuery).toHaveBeenCalled();
    });
  });
});
