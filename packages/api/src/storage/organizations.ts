/**
 * Multi-Tenant Organizations and Teams storage module.
 *
 * Handles team creation, role-based access control (RBAC), membership,
 * and automatic synchronization with OIDC identity provider groups.
 */

import { nanoid } from 'nanoid';
import { pool } from '../db/index.js';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  oidc_group: string | null;
  created_at: Date;
  modified_at: Date;
}

export interface UserOrgItem extends OrganizationRow {
  member_role: OrgRole;
  member_count?: number;
}

export interface OrganizationMemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: Date;
  user_email?: string;
  user_name?: string | null;
}

const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

/**
 * Generate a clean URL-friendly slug from an organization or group name.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Create a new organization and assign the creator as the Owner.
 */
export async function createOrganization(params: {
  name: string;
  slug?: string;
  description?: string;
  oidcGroup?: string;
  ownerId: string;
}): Promise<OrganizationRow> {
  const orgId = nanoid();
  const slug = (params.slug ? slugify(params.slug) : slugify(params.name)) || orgId;

  // Insert organization
  const res = await pool.query<OrganizationRow>(
    `INSERT INTO organizations (id, name, slug, description, oidc_group, created_at, modified_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING *`,
    [
      orgId,
      params.name.trim(),
      slug,
      params.description?.trim() || null,
      params.oidcGroup?.trim() || null,
    ]
  );

  const org = res.rows[0];
  if (!org) {
    throw new Error('Failed to create organization');
  }

  // Assign owner in organization_members
  await pool.query(
    `INSERT INTO organization_members (id, org_id, user_id, role, created_at)
     VALUES ($1, $2, $3, 'owner', NOW())`,
    [nanoid(), orgId, params.ownerId]
  );

  return org;
}

/**
 * Get all organizations where a user is a member.
 */
export async function getUserOrganizations(userId: string): Promise<UserOrgItem[]> {
  const res = await pool.query<UserOrgItem>(
    `SELECT o.*, m.role AS member_role,
            (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id)::int AS member_count
     FROM organizations o
     JOIN organization_members m ON m.org_id = o.id
     WHERE m.user_id = $1
     ORDER BY o.created_at ASC`,
    [userId]
  );

  return res.rows;
}

/**
 * Get single organization by ID.
 */
export async function getOrganizationById(orgId: string): Promise<OrganizationRow | null> {
  const res = await pool.query<OrganizationRow>('SELECT * FROM organizations WHERE id = $1', [
    orgId,
  ]);
  return res.rows[0] || null;
}

/**
 * Get a user's membership and role in an organization.
 */
export async function getOrganizationMember(
  orgId: string,
  userId: string
): Promise<OrganizationMemberRow | null> {
  const res = await pool.query<OrganizationMemberRow>(
    'SELECT * FROM organization_members WHERE org_id = $1 AND user_id = $2',
    [orgId, userId]
  );
  return res.rows[0] || null;
}

/**
 * List all members of an organization with user details.
 */
export async function getOrganizationMembers(orgId: string): Promise<OrganizationMemberRow[]> {
  const res = await pool.query<OrganizationMemberRow>(
    `SELECT m.id, m.org_id, m.user_id, m.role, m.created_at,
            u.email AS user_email, u.name AS user_name
     FROM organization_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1
     ORDER BY m.created_at ASC`,
    [orgId]
  );
  return res.rows;
}

/**
 * Verify whether a user has at least the required role in an organization.
 */
export async function verifyOrgAccess(
  userId: string,
  orgId: string,
  minRole: OrgRole = 'viewer'
): Promise<boolean> {
  const member = await getOrganizationMember(orgId, userId);
  if (!member) return false;

  const userRank = ROLE_RANK[member.role] ?? 0;
  const requiredRank = ROLE_RANK[minRole] ?? 0;

  return userRank >= requiredRank;
}

/**
 * Add or invite a user to an organization.
 */
export async function addOrganizationMember(
  orgId: string,
  userId: string,
  role: OrgRole = 'member'
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (id, org_id, user_id, role, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (org_id, user_id) DO UPDATE
     SET role = EXCLUDED.role`,
    [nanoid(), orgId, userId, role]
  );
}

/**
 * Update a member's role within an organization.
 */
export async function updateMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole
): Promise<void> {
  await pool.query(
    `UPDATE organization_members
     SET role = $1
     WHERE org_id = $2 AND user_id = $3`,
    [role, orgId, userId]
  );
}

/**
 * Remove a member from an organization.
 */
export async function removeMember(orgId: string, userId: string): Promise<void> {
  await pool.query('DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2', [
    orgId,
    userId,
  ]);
}

/**
 * Update organization metadata.
 */
export async function updateOrganization(
  orgId: string,
  data: Partial<Pick<OrganizationRow, 'name' | 'slug' | 'description' | 'oidc_group'>>
): Promise<OrganizationRow> {
  const current = await getOrganizationById(orgId);
  if (!current) {
    throw new Error('Organization not found');
  }

  const name = data.name !== undefined ? data.name.trim() : current.name;
  const slug = data.slug !== undefined ? slugify(data.slug) : current.slug;
  const description =
    data.description !== undefined
      ? data.description
        ? data.description.trim()
        : null
      : current.description;
  const oidcGroup =
    data.oidc_group !== undefined
      ? data.oidc_group
        ? data.oidc_group.trim()
        : null
      : current.oidc_group;

  const res = await pool.query<OrganizationRow>(
    `UPDATE organizations
     SET name = $1, slug = $2, description = $3, oidc_group = $4, modified_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [name, slug, description, oidcGroup, orgId]
  );

  const updated = res.rows[0];
  if (!updated) {
    throw new Error('Failed to update organization');
  }
  return updated;
}

/**
 * Delete an organization and its cascading resources.
 */
export async function deleteOrganization(orgId: string): Promise<void> {
  await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
}

/**
 * Synchronize OIDC user groups into team/organization memberships automatically.
 */
export async function syncUserOidcGroups(userId: string, groupNames: string[]): Promise<void> {
  if (!groupNames || groupNames.length === 0) return;

  for (const rawName of groupNames) {
    const groupName = (rawName || '').trim();
    if (!groupName) continue;

    const slug = slugify(groupName);

    try {
      // Find existing organization linked by oidc_group or matching slug
      const found = await pool.query<OrganizationRow>(
        'SELECT * FROM organizations WHERE oidc_group = $1 OR slug = $2',
        [groupName, slug]
      );

      let org = found.rows[0];
      if (!org) {
        // Auto-provision team organization for new OIDC group
        const newOrgId = nanoid();
        const insertRes = await pool.query<OrganizationRow>(
          `INSERT INTO organizations (id, name, slug, description, oidc_group, created_at, modified_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (slug) DO UPDATE SET oidc_group = EXCLUDED.oidc_group
           RETURNING *`,
          [newOrgId, groupName, slug, `Auto-synced from OIDC group: ${groupName}`, groupName]
        );
        org = insertRes.rows[0];
      }

      if (org) {
        // Ensure user is added as member of this team
        await addOrganizationMember(org.id, userId, 'member');
      }
    } catch (err) {
      console.warn(
        `[OIDC Group Sync] Failed to sync group "${groupName}" for user ${userId}:`,
        err
      );
    }
  }
}
