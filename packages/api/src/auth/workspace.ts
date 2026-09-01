/**
 * Workspace Context & Organization Scoping Helper.
 *
 * Resolves active organization from x-org-id header or query param,
 * and validates user access.
 */

import type { FastifyRequest } from 'fastify';
import { getOrganizationMember, type OrgRole, verifyOrgAccess } from '../storage/organizations.js';

export interface WorkspaceScope {
  orgId: string | null;
  isPersonal: boolean;
  role?: OrgRole;
}

/**
 * Extract and validate active workspace from incoming Fastify request.
 */
export async function getRequestWorkspace(request: FastifyRequest): Promise<WorkspaceScope> {
  const query = (request.query || {}) as Record<string, unknown>;
  const rawOrgId =
    (request.headers['x-org-id'] as string) ||
    (typeof query.orgId === 'string' ? query.orgId : '') ||
    '';

  const orgId = rawOrgId.trim();
  if (!orgId || orgId === 'personal' || orgId === 'null' || orgId === 'undefined') {
    return { orgId: null, isPersonal: true };
  }

  const userId = request.user?.id;
  if (!userId) {
    return { orgId: null, isPersonal: true };
  }

  const member = await getOrganizationMember(orgId, userId);
  if (!member && request.user?.role !== 'admin') {
    const err = new Error('Access denied to specified organization workspace');
    (err as Error & { statusCode: number }).statusCode = 403;
    throw err;
  }

  return {
    orgId,
    isPersonal: false,
    role: member?.role || (request.user?.role === 'admin' ? 'admin' : 'viewer'),
  };
}

/**
 * Check if the current user has permission to modify resources in the workspace.
 */
export async function requireWorkspaceRole(
  request: FastifyRequest,
  orgId: string | null,
  minRole: OrgRole = 'member'
): Promise<void> {
  if (!orgId) return; // Personal workspace always allowed for owner

  const userId = request.user?.id;
  if (!userId) throw new Error('Unauthorized');

  if (request.user?.role === 'admin') return;

  const hasAccess = await verifyOrgAccess(userId, orgId, minRole);
  if (!hasAccess) {
    const err = new Error(`Insufficient permissions in this team (requires ${minRole})`);
    (err as Error & { statusCode: number }).statusCode = 403;
    throw err;
  }
}

/**
 * Helper to build the workspace-scoped WHERE clause for list endpoints.
 *
 * @param ws WorkspaceScope from getRequestWorkspace(request)
 * @param userId User ID of current authenticated user
 * @param params Array of SQL query params to push into
 * @param tableAlias Optional table alias like 'r.' or 'r'
 * @returns SQL WHERE condition fragment (e.g. "org_id = $1" or "(org_id IS NULL AND user_id = $1)")
 */
export function buildWorkspaceWhere(
  ws: WorkspaceScope,
  userId: string,
  params: unknown[],
  tableAlias = ''
): string {
  const prefix = tableAlias ? (tableAlias.endsWith('.') ? tableAlias : `${tableAlias}.`) : '';
  if (ws.orgId) {
    params.push(ws.orgId);
    return `${prefix}org_id = $${params.length}`;
  }
  params.push(userId);
  return `(${prefix}org_id IS NULL AND ${prefix}user_id = $${params.length})`;
}

/**
 * Helper to check single resource read/access condition (by ownership, membership, or system admin).
 */
export function buildResourceAccessWhere(
  userId: string,
  isAdmin: boolean,
  params: unknown[],
  tableAlias = ''
): string {
  if (isAdmin) return '1=1';
  const prefix = tableAlias ? (tableAlias.endsWith('.') ? tableAlias : `${tableAlias}.`) : '';
  params.push(userId);
  const p = `$${params.length}`;
  return `(${prefix}user_id = ${p} OR (${prefix}org_id IS NOT NULL AND EXISTS (SELECT 1 FROM organization_members om WHERE om.org_id = ${prefix}org_id AND om.user_id = ${p})))`;
}
