/**
 * Organization and Team Management API Routes.
 *
 * GET    /v2/organizations                 - List user's organizations
 * POST   /v2/organizations                 - Create a new organization
 * GET    /v2/organizations/:id             - Get organization details & member list
 * PUT    /v2/organizations/:id             - Update organization metadata
 * DELETE /v2/organizations/:id             - Delete organization
 * POST   /v2/organizations/:id/members     - Add/invite member by email
 * PUT    /v2/organizations/:id/members/:id - Update member role
 * DELETE /v2/organizations/:id/members/:id - Remove member from organization
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware.js';
import { pool } from '../db/index.js';
import {
  createOrganization,
  deleteOrganization,
  getOrganizationById,
  getOrganizationMember,
  getOrganizationMembers,
  getUserOrganizations,
  removeMember,
  updateMemberRole,
  updateOrganization,
  addOrganizationMember,
  verifyOrgAccess,
  getUnassignedResourcesCount,
  transferResourcesToOrganization,
  type OrgRole,
} from '../storage/organizations.js';

const createOrgSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  oidcGroup: z.string().max(100).optional(),
});

const updateOrgSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  slug: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  oidcGroup: z.string().max(100).optional(),
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

export const organizationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/organizations - List organizations for the logged in user
   */
  fastify.get('/organizations', async (request, reply) => {
    const userId = request.user!.id;
    const orgs = await getUserOrganizations(userId);
    return reply.send({ data: { items: orgs } });
  });

  /**
   * POST /v2/organizations - Create a new organization
   */
  fastify.post('/organizations', async (request, reply) => {
    const userId = request.user!.id;
    const body = createOrgSchema.parse(request.body);

    const org = await createOrganization({
      name: body.name,
      slug: body.slug,
      description: body.description,
      oidcGroup: body.oidcGroup,
      ownerId: userId,
    });

    return reply.status(201).send({ data: org });
  });

  /**
   * GET /v2/organizations/:id - Get organization details and member list
   */
  fastify.get('/organizations/:id', async (request, reply) => {
    const userId = request.user!.id;
    const { id } = request.params as { id: string };

    const member = await getOrganizationMember(id, userId);
    if (!member && request.user?.role !== 'admin') {
      return reply.status(403).send({ error: { message: 'Access denied to this organization' } });
    }

    const org = await getOrganizationById(id);
    if (!org) {
      return reply.status(404).send({ error: { message: 'Organization not found' } });
    }

    const members = await getOrganizationMembers(id);
    return reply.send({
      data: {
        ...org,
        myRole: member?.role || (request.user?.role === 'admin' ? 'admin' : 'viewer'),
        members,
      },
    });
  });

  /**
   * PUT /v2/organizations/:id - Update organization (admin or owner only)
   */
  fastify.put('/organizations/:id', async (request, reply) => {
    const userId = request.user!.id;
    const { id } = request.params as { id: string };
    const body = updateOrgSchema.parse(request.body);

    const hasAccess = await verifyOrgAccess(userId, id, 'admin');
    if (!hasAccess && request.user?.role !== 'admin') {
      return reply.status(403).send({ error: { message: 'Admin or Owner privileges required' } });
    }

    const updated = await updateOrganization(id, {
      name: body.name,
      slug: body.slug,
      description: body.description,
      oidc_group: body.oidcGroup,
    });

    return reply.send({ data: updated });
  });

  /**
   * DELETE /v2/organizations/:id - Delete organization (owner only)
   */
  fastify.delete('/organizations/:id', async (request, reply) => {
    const userId = request.user!.id;
    const { id } = request.params as { id: string };

    const isOwner = await verifyOrgAccess(userId, id, 'owner');
    if (!isOwner && request.user?.role !== 'admin') {
      return reply
        .status(403)
        .send({ error: { message: 'Only the Organization Owner can delete it' } });
    }

    await deleteOrganization(id);
    return reply.send({ data: { success: true } });
  });

  /**
   * POST /v2/organizations/:id/members - Add member by email
   */
  fastify.post('/organizations/:id/members', async (request, reply) => {
    const userId = request.user!.id;
    const { id } = request.params as { id: string };
    const body = addMemberSchema.parse(request.body);

    const hasAccess = await verifyOrgAccess(userId, id, 'admin');
    if (!hasAccess && request.user?.role !== 'admin') {
      return reply.status(403).send({ error: { message: 'Admin or Owner privileges required' } });
    }

    // Lookup target user by email
    const userRes = await pool.query<{ id: string; email: string; name: string | null }>(
      'SELECT id, email, name FROM users WHERE email = $1',
      [body.email.toLowerCase().trim()]
    );

    const targetUser = userRes.rows[0];
    if (!targetUser) {
      return reply.status(404).send({
        error: {
          message: `User with email "${body.email}" is not registered on this platform yet`,
        },
      });
    }

    await addOrganizationMember(id, targetUser.id, body.role as OrgRole);
    const members = await getOrganizationMembers(id);

    return reply.status(201).send({
      data: {
        success: true,
        member: {
          org_id: id,
          user_id: targetUser.id,
          role: body.role,
          user_email: targetUser.email,
          user_name: targetUser.name,
        },
        members,
      },
    });
  });

  /**
   * PUT /v2/organizations/:id/members/:memberUserId - Update member role
   */
  fastify.put('/organizations/:id/members/:memberUserId', async (request, reply) => {
    const userId = request.user!.id;
    const { id, memberUserId } = request.params as { id: string; memberUserId: string };
    const body = updateMemberRoleSchema.parse(request.body);

    const hasAccess = await verifyOrgAccess(userId, id, 'admin');
    if (!hasAccess && request.user?.role !== 'admin') {
      return reply.status(403).send({ error: { message: 'Admin or Owner privileges required' } });
    }

    // Only owner can assign owner role
    if (body.role === 'owner') {
      const isOwner = await verifyOrgAccess(userId, id, 'owner');
      if (!isOwner && request.user?.role !== 'admin') {
        return reply
          .status(403)
          .send({ error: { message: 'Only an existing owner can transfer ownership' } });
      }
    }

    await updateMemberRole(id, memberUserId, body.role as OrgRole);
    return reply.send({ data: { success: true, role: body.role } });
  });

  /**
   * DELETE /v2/organizations/:id/members/:memberUserId - Remove member
   */
  fastify.delete('/organizations/:id/members/:memberUserId', async (request, reply) => {
    const userId = request.user!.id;
    const { id, memberUserId } = request.params as { id: string; memberUserId: string };

    const isSelf = userId === memberUserId;
    const hasAdmin = await verifyOrgAccess(userId, id, 'admin');

    if (!isSelf && !hasAdmin && request.user?.role !== 'admin') {
      return reply.status(403).send({ error: { message: 'Permission denied' } });
    }

    // Check if target is owner
    const targetMember = await getOrganizationMember(id, memberUserId);
    if (targetMember?.role === 'owner') {
      return reply.status(400).send({
        error: {
          message:
            'Cannot remove organization owner. Transfer ownership or delete the organization.',
        },
      });
    }

    await removeMember(id, memberUserId);
    return reply.send({ data: { success: true } });
  });

  /**
   * GET /v2/organizations/:id/transfer-preview - Preview resources eligible for transfer
   */
  fastify.get('/organizations/:id/transfer-preview', async (request, reply) => {
    const userId = request.user!.id;
    const { id } = request.params as { id: string };

    const hasAccess = await verifyOrgAccess(userId, id, 'admin');
    if (!hasAccess && request.user?.role !== 'admin') {
      return reply.status(403).send({ error: { message: 'Admin or Owner privileges required' } });
    }

    const [personal, allUnassigned] = await Promise.all([
      getUnassignedResourcesCount(userId),
      request.user?.role === 'admin'
        ? getUnassignedResourcesCount(undefined)
        : Promise.resolve(null),
    ]);

    return reply.send({
      data: {
        personal,
        allUnassigned,
        isSystemAdmin: request.user?.role === 'admin',
      },
    });
  });

  /**
   * POST /v2/organizations/:id/transfer-resources - Transfer personal or unassigned resources to this team
   */
  fastify.post('/organizations/:id/transfer-resources', async (request, reply) => {
    const userId = request.user!.id;
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { transferAllUnassigned?: boolean };

    const hasAccess = await verifyOrgAccess(userId, id, 'admin');
    if (!hasAccess && request.user?.role !== 'admin') {
      return reply.status(403).send({ error: { message: 'Admin or Owner privileges required' } });
    }

    // Only system admin or org owner can transfer all unassigned resources across the system
    const transferAll = Boolean(body.transferAllUnassigned);
    if (transferAll && request.user?.role !== 'admin') {
      const isOwner = await verifyOrgAccess(userId, id, 'owner');
      if (!isOwner) {
        return reply.status(403).send({
          error: {
            message: 'System Admin or Team Owner privileges required for bulk unassigned transfer',
          },
        });
      }
    }

    const transferred = await transferResourcesToOrganization({
      targetOrgId: id,
      userId: transferAll ? undefined : userId,
      transferAllUnassigned: transferAll,
    });

    return reply.send({
      data: {
        success: true,
        targetOrgId: id,
        transferred,
      },
    });
  });
};
