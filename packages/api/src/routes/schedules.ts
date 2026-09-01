/**
 * Schedule routes - CRUD endpoints for managing cron-based Actor schedules.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { CreateScheduleSchema, UpdateScheduleSchema } from '../schemas/schedules.js';
import { query } from '../db/index.js';
import { appendSearchCondition } from '../db/search.js';
import { authenticate } from '../auth/middleware.js';
import { computeNextRun } from '../scheduler.js';
import {
  getRequestWorkspace,
  requireWorkspaceRole,
  buildWorkspaceWhere,
  buildResourceAccessWhere,
} from '../auth/workspace.js';

interface ScheduleRow {
  id: string;
  user_id: string | null;
  org_id: string | null;
  actor_id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  is_enabled: boolean;
  input: unknown;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
  modified_at: Date;
}

export const schedulesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * POST /v2/schedules - Create schedule
   */
  fastify.post<{
    Body: {
      actorId: string;
      name: string;
      cronExpression: string;
      timezone?: string;
      isEnabled?: boolean;
      input?: unknown;
    };
  }>('/schedules', async (request, reply) => {
    const data = CreateScheduleSchema.parse(request.body);
    const ws = await getRequestWorkspace(request);
    await requireWorkspaceRole(request, ws.orgId, 'member');

    const isAdmin = request.user?.role === 'admin';
    const checkParams: unknown[] = [data.actorId];
    const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, checkParams);

    // Verify actor exists and is accessible
    const actor = await query<{ id: string; org_id: string | null }>(
      `SELECT id, org_id FROM actors WHERE (id = $1 OR name = $1) AND ${accessWhere}`,
      checkParams
    );

    if (!actor.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Actor not found' } };
    }

    const actorId = actor.rows[0].id;
    const targetOrgId = ws.orgId || actor.rows[0].org_id || null;

    let nextRunAt: Date;
    try {
      nextRunAt = computeNextRun(data.cronExpression, data.timezone ?? 'UTC');
    } catch (err) {
      reply.status(400);
      return { error: { message: `Invalid cron expression: ${(err as Error).message}` } };
    }

    const id = nanoid();
    const result = await query<ScheduleRow>(
      `INSERT INTO schedules (id, user_id, org_id, actor_id, name, cron_expression, timezone, is_enabled, input, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        request.user!.id,
        targetOrgId,
        actorId,
        data.name,
        data.cronExpression,
        data.timezone ?? 'UTC',
        data.isEnabled ?? true,
        data.input ? JSON.stringify(data.input) : null,
        nextRunAt,
      ]
    );

    reply.status(201);
    return { data: formatSchedule(result.rows[0]!) };
  });

  /**
   * GET /v2/schedules - List workspace schedules
   */
  fastify.get<{
    Querystring: { offset?: string; limit?: string; q?: string };
  }>('/schedules', async (request) => {
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    const ws = await getRequestWorkspace(request);
    const params: unknown[] = [];
    const wsWhere = buildWorkspaceWhere(ws, request.user!.id, params);
    const where = appendSearchCondition(wsWhere, params, request.query.q || '', ['id', 'name']);

    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM schedules WHERE ${where}`,
        params
      ),
      query<ScheduleRow>(
        `SELECT * FROM schedules WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    return {
      data: {
        total,
        count: pageResult.rows.length,
        offset,
        limit,
        items: pageResult.rows.map(formatSchedule),
      },
    };
  });

  /**
   * GET /v2/schedules/:scheduleId - Get single schedule (user or team scoped)
   */
  fastify.get<{ Params: { scheduleId: string } }>(
    '/schedules/:scheduleId',
    async (request, reply) => {
      const { scheduleId } = request.params;
      const isAdmin = request.user?.role === 'admin';
      const params: unknown[] = [scheduleId];
      const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

      const result = await query<ScheduleRow>(
        `SELECT * FROM schedules WHERE id = $1 AND ${accessWhere}`,
        params
      );

      if (!result.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Schedule not found' } };
      }

      return { data: formatSchedule(result.rows[0]) };
    }
  );

  /**
   * PUT /v2/schedules/:scheduleId - Update schedule (user or team scoped)
   */
  fastify.put<{
    Params: { scheduleId: string };
    Body: {
      actorId?: string;
      name?: string;
      cronExpression?: string;
      timezone?: string;
      isEnabled?: boolean;
      input?: unknown;
    };
  }>('/schedules/:scheduleId', async (request, reply) => {
    const { scheduleId } = request.params;
    const updates = UpdateScheduleSchema.parse(request.body);

    const isAdmin = request.user?.role === 'admin';

    // If actorId is being changed, verify new actor belongs to workspace
    if (updates.actorId !== undefined) {
      const actorCheckParams: unknown[] = [updates.actorId];
      const actorAccessWhere = buildResourceAccessWhere(
        request.user!.id,
        isAdmin,
        actorCheckParams
      );
      const actor = await query<{ id: string }>(
        `SELECT id FROM actors WHERE (id = $1 OR name = $1) AND ${actorAccessWhere}`,
        actorCheckParams
      );

      if (!actor.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Actor not found' } };
      }

      updates.actorId = actor.rows[0].id;
    }

    const needsRecompute =
      updates.cronExpression !== undefined ||
      updates.timezone !== undefined ||
      updates.isEnabled === true;

    let recomputedNextRunAt: Date | null = null;
    if (needsRecompute) {
      const checkParams: unknown[] = [scheduleId];
      const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, checkParams);
      const existing = await query<{ cron_expression: string; timezone: string }>(
        `SELECT cron_expression, timezone FROM schedules WHERE id = $1 AND ${accessWhere}`,
        checkParams
      );
      if (!existing.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Schedule not found' } };
      }
      const effectiveCron = updates.cronExpression ?? existing.rows[0].cron_expression;
      const effectiveTz = updates.timezone ?? existing.rows[0].timezone;
      try {
        recomputedNextRunAt = computeNextRun(effectiveCron, effectiveTz);
      } catch (err) {
        reply.status(400);
        return { error: { message: `Invalid cron expression: ${(err as Error).message}` } };
      }
    }

    const setClauses: string[] = ['modified_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.actorId !== undefined) {
      setClauses.push(`actor_id = $${paramIndex++}`);
      values.push(updates.actorId);
    }
    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.cronExpression !== undefined) {
      setClauses.push(`cron_expression = $${paramIndex++}`);
      values.push(updates.cronExpression);
    }
    if (updates.timezone !== undefined) {
      setClauses.push(`timezone = $${paramIndex++}`);
      values.push(updates.timezone);
    }
    if (updates.isEnabled !== undefined) {
      setClauses.push(`is_enabled = $${paramIndex++}`);
      values.push(updates.isEnabled);
    }
    if (updates.input !== undefined) {
      setClauses.push(`input = $${paramIndex++}`);
      values.push(JSON.stringify(updates.input));
    }
    if (recomputedNextRunAt !== null) {
      setClauses.push(`next_run_at = $${paramIndex++}`);
      values.push(recomputedNextRunAt);
    }

    values.push(scheduleId);
    const scheduleIdParam = paramIndex++;
    const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, values);

    const result = await query<ScheduleRow>(
      `UPDATE schedules SET ${setClauses.join(', ')}
       WHERE id = $${scheduleIdParam} AND ${accessWhere}
       RETURNING *`,
      values
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Schedule not found' } };
    }

    return { data: formatSchedule(result.rows[0]) };
  });

  /**
   * DELETE /v2/schedules/:scheduleId - Delete schedule (user or team scoped)
   */
  fastify.delete<{ Params: { scheduleId: string } }>(
    '/schedules/:scheduleId',
    async (request, reply) => {
      const { scheduleId } = request.params;
      const isAdmin = request.user?.role === 'admin';
      const params: unknown[] = [scheduleId];
      const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

      const result = await query(
        `DELETE FROM schedules WHERE id = $1 AND ${accessWhere} RETURNING id`,
        params
      );

      if (result.rowCount === 0) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Schedule not found' } };
      }

      reply.status(204);
    }
  );
};

function formatSchedule(row: ScheduleRow) {
  return {
    id: row.id,
    userId: row.user_id,
    actorId: row.actor_id,
    name: row.name,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    isEnabled: row.is_enabled,
    input: row.input,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}
