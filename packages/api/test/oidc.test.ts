import { describe, it, expect } from 'vitest';
import {
  extractRolesFromClaims,
  mapOidcRolesToRole,
  createOidcState,
  consumeOidcState,
} from '../src/auth/oidc.js';

describe('OIDC Role Mapping and Claims Extraction', () => {
  describe('extractRolesFromClaims', () => {
    it('extracts roles from flat array claims', () => {
      const claims = { roles: ['admin', 'editor', 'viewer'] };
      expect(extractRolesFromClaims(claims, 'roles')).toEqual(['admin', 'editor', 'viewer']);
    });

    it('extracts roles from nested claim paths like realm_access.roles', () => {
      const claims = {
        realm_access: {
          roles: ['crawlee-admin', 'default-roles-master'],
        },
      };
      expect(extractRolesFromClaims(claims, 'realm_access.roles')).toEqual([
        'crawlee-admin',
        'default-roles-master',
      ]);
    });

    it('extracts roles from comma-separated string claims', () => {
      const claims = { groups: 'DevOps, Engineering, Admins' };
      expect(extractRolesFromClaims(claims, 'groups')).toEqual(['DevOps', 'Engineering', 'Admins']);
    });

    it('extracts single string role claim', () => {
      const claims = { role: 'superadmin' };
      expect(extractRolesFromClaims(claims, 'role')).toEqual(['superadmin']);
    });

    it('returns empty array when claim path does not exist', () => {
      const claims = { email: 'user@example.com' };
      expect(extractRolesFromClaims(claims, 'custom.roles.claim')).toEqual([]);
    });

    it('handles deep nested paths safely', () => {
      const claims = {
        resource_access: {
          'crawlee-client': {
            roles: ['operator'],
          },
        },
      };
      expect(extractRolesFromClaims(claims, 'resource_access.crawlee-client.roles')).toEqual([
        'operator',
      ]);
    });
  });

  describe('mapOidcRolesToRole', () => {
    it('maps to admin when user has a matching admin role (exact match)', () => {
      const userRoles = ['member', 'crawlee-admins'];
      const adminRoles = ['admin', 'crawlee-admins'];
      expect(mapOidcRolesToRole(userRoles, adminRoles, 'user')).toBe('admin');
    });

    it('maps to admin when role matches case-insensitively', () => {
      const userRoles = ['DEVOPS', 'VIEWER'];
      const adminRoles = ['devops', 'admin'];
      expect(mapOidcRolesToRole(userRoles, adminRoles, 'user')).toBe('admin');
    });

    it('falls back to default role when no admin roles match', () => {
      const userRoles = ['developer', 'tester'];
      const adminRoles = ['admin', 'crawlee-admins'];
      expect(mapOidcRolesToRole(userRoles, adminRoles, 'user')).toBe('user');
    });

    it('respects custom default role', () => {
      const userRoles = ['guest'];
      const adminRoles = ['admin'];
      expect(mapOidcRolesToRole(userRoles, adminRoles, 'admin')).toBe('admin');
    });

    it('returns default role when adminRoles list is empty', () => {
      const userRoles = ['admin'];
      expect(mapOidcRolesToRole(userRoles, [], 'user')).toBe('user');
    });
  });

  describe('State Management', () => {
    it('creates and consumes state once', async () => {
      const { state, nonce } = await createOidcState(
        'https://example.com/callback',
        'https://example.com/dashboard'
      );
      expect(state).toBeTruthy();
      expect(nonce).toBeTruthy();

      const consumed = await consumeOidcState(state);
      expect(consumed).not.toBeNull();
      expect(consumed?.redirectUri).toBe('https://example.com/callback');
      expect(consumed?.returnTo).toBe('https://example.com/dashboard');
      expect(consumed?.nonce).toBe(nonce);

      // Subsequent consumption must return null (single use)
      const secondConsume = await consumeOidcState(state);
      expect(secondConsume).toBeNull();
    });

    it('returns null for non-existent state', async () => {
      const consumed = await consumeOidcState('non-existent-random-state');
      expect(consumed).toBeNull();
    });
  });
});
