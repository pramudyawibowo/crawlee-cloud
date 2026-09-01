/**
 * Key-Value Store routes - Apify-compatible endpoints.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import { appendSearchCondition } from '../db/search.js';
import {
  putKVRecord,
  getKVRecord,
  deleteKVRecord,
  listKVKeys,
  presignKVRecord,
  deleteKVStoreS3Prefix,
} from '../storage/s3.js';
import { authenticate } from '../auth/middleware.js';
import { CreateKeyValueStoreSchema } from '../schemas/key-value-stores.js';
import {
  getRequestWorkspace,
  requireWorkspaceRole,
  buildWorkspaceWhere,
  buildResourceAccessWhere,
} from '../auth/workspace.js';

interface KVStoreRow {
  id: string;
  name: string | null;
  user_id: string | null;
  org_id: string | null;
  created_at: Date;
  modified_at: Date;
  accessed_at: Date;
}

export const keyValueStoresRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/key-value-stores - List stores (workspace-scoped)
   */
  fastify.get<{
    Querystring: { offset?: string; limit?: string; q?: string };
  }>('/key-value-stores', async (request) => {
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    const ws = await getRequestWorkspace(request);
    const params: unknown[] = [];
    const wsWhere = buildWorkspaceWhere(ws, request.user!.id, params);
    const where = appendSearchCondition(wsWhere, params, request.query.q || '', ['id', 'name']);

    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM key_value_stores WHERE ${where}`,
        params
      ),
      query<KVStoreRow>(
        `SELECT * FROM key_value_stores WHERE ${where}
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
        items: pageResult.rows.map(formatStore),
      },
    };
  });

  /**
   * POST /v2/key-value-stores - Create or get store
   */
  fastify.post<{ Body: { name?: string }; Querystring: { name?: string } }>(
    '/key-value-stores',
    async (request, reply) => {
      const body = CreateKeyValueStoreSchema.parse(request.body || {});
      const name = request.query.name || body.name;

      const ws = await getRequestWorkspace(request);
      await requireWorkspaceRole(request, ws.orgId, 'member');

      if (name) {
        let existingQuery = '';
        let existingParams: unknown[] = [];
        if (ws.orgId) {
          existingQuery = 'SELECT * FROM key_value_stores WHERE name = $1 AND org_id = $2';
          existingParams = [name, ws.orgId];
        } else {
          existingQuery =
            'SELECT * FROM key_value_stores WHERE name = $1 AND org_id IS NULL AND user_id = $2';
          existingParams = [name, request.user!.id];
        }
        const existing = await query<KVStoreRow>(existingQuery, existingParams);
        if (existing.rows[0]) {
          return { data: formatStore(existing.rows[0]) };
        }
      }

      const id = nanoid();
      const result = await query<KVStoreRow>(
        `INSERT INTO key_value_stores (id, name, user_id, org_id) VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, name || null, request.user!.id, ws.orgId || null]
      );

      reply.status(201);
      return { data: formatStore(result.rows[0]!) };
    }
  );

  /**
   * GET /v2/key-value-stores/:storeId - Get store info (user or team scoped)
   */
  fastify.get<{ Params: { storeId: string } }>(
    '/key-value-stores/:storeId',
    async (request, reply) => {
      const { storeId } = request.params;
      const isAdmin = request.user?.role === 'admin';
      const params: unknown[] = [storeId, storeId];
      const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

      const result = await query<KVStoreRow>(
        `SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND ${accessWhere}`,
        params
      );

      if (!result.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
      }

      await query('UPDATE key_value_stores SET accessed_at = NOW() WHERE id = $1', [
        result.rows[0].id,
      ]);

      return { data: formatStore(result.rows[0]) };
    }
  );

  /**
   * DELETE /v2/key-value-stores/:storeId - Delete store (user or team scoped)
   */
  fastify.delete<{ Params: { storeId: string } }>(
    '/key-value-stores/:storeId',
    async (request, reply) => {
      const { storeId } = request.params;
      const isAdmin = request.user?.role === 'admin';
      const params: unknown[] = [storeId, storeId];
      const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

      const result = await query<{ id: string }>(
        `DELETE FROM key_value_stores WHERE (id = $1 OR name = $2) AND ${accessWhere} RETURNING id`,
        params
      );
      if (result.rowCount === 0) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
      }
      const deletedId = result.rows[0]!.id;

      try {
        await deleteKVStoreS3Prefix(deletedId);
      } catch (err) {
        request.log.error(
          { storeId: deletedId, err },
          '[key-value-stores] DELETE: S3 prefix cleanup failed (PG row already gone)'
        );
      }

      reply.status(204);
    }
  );

  /**
   * GET /v2/key-value-stores/:storeId/keys - List keys
   */
  fastify.get<{
    Params: { storeId: string };
    Querystring: { limit?: string; exclusiveStartKey?: string };
  }>('/key-value-stores/:storeId/keys', async (request, reply) => {
    const { storeId } = request.params;
    const limit = parseInt(request.query.limit || '100', 10);
    const { exclusiveStartKey } = request.query;

    const isAdmin = request.user?.role === 'admin';
    const params: unknown[] = [storeId, storeId];
    const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

    const store = await query<KVStoreRow>(
      `SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND ${accessWhere}`,
      params
    );

    if (!store.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
    }

    const result = await listKVKeys(store.rows[0].id, { limit, exclusiveStartKey });

    return {
      data: {
        count: result.keys.length,
        limit,
        isTruncated: result.isTruncated,
        nextExclusiveStartKey: result.nextExclusiveStartKey,
        items: result.keys,
      },
    };
  });

  /**
   * GET /v2/key-value-stores/:storeId/records/:key - Get record
   *
   * This is used for Actor.getInput(), Actor.getValue(), etc.
   */
  fastify.get<{
    Params: { storeId: string; key: string };
    Querystring: { presigned?: string };
  }>('/key-value-stores/:storeId/records/:key', async (request, reply) => {
    const { storeId, key } = request.params;
    const isAdmin = request.user?.role === 'admin';
    const params: unknown[] = [storeId, storeId];
    const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

    // Get store (user or team scoped)
    const store = await query<KVStoreRow>(
      `SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND ${accessWhere}`,
      params
    );

    if (!store.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
    }

    if (request.query.presigned === '1' || request.query.presigned === 'true') {
      const presigned = await presignKVRecord(store.rows[0].id, key);
      if (!presigned) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Record not found' } };
      }
      return { data: presigned };
    }

    const record = await getKVRecord(store.rows[0].id, key);

    if (!record) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Record not found' } };
    }

    reply.header('content-type', record.contentType);
    return reply.send(record.value);
  });

  /**
   * PUT /v2/key-value-stores/:storeId/records/:key - Set record
   *
   * This is used for Actor.setValue()
   */
  fastify.put<{ Params: { storeId: string; key: string } }>(
    '/key-value-stores/:storeId/records/:key',
    async (request, reply) => {
      const { storeId, key } = request.params;
      const contentType = request.headers['content-type'] ?? 'application/json';

      const isAdmin = request.user?.role === 'admin';
      const params: unknown[] = [storeId, storeId];
      const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

      // Get or auto-create store
      let store = await query<KVStoreRow>(
        `SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND ${accessWhere}`,
        params
      );

      if (!store.rows[0]) {
        // Auto-create with user ownership
        const id = storeId === 'default' ? nanoid() : storeId;
        await query(
          `INSERT INTO key_value_stores (id, name, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [id, storeId === 'default' ? null : storeId, request.user!.id]
        );
        const recheckParams: unknown[] = [id, id];
        const recheckAccess = buildResourceAccessWhere(request.user!.id, isAdmin, recheckParams);
        store = await query<KVStoreRow>(
          `SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND ${recheckAccess}`,
          recheckParams
        );
      }

      if (!store.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Store not found' } };
      }

      const body = request.body;
      let data: Buffer | string;
      if (Buffer.isBuffer(body)) {
        data = body;
      } else if (typeof body === 'string') {
        data = body;
      } else {
        data = JSON.stringify(body);
      }

      await putKVRecord(store.rows[0].id, key, data, contentType);

      await query('UPDATE key_value_stores SET modified_at = NOW() WHERE id = $1', [
        store.rows[0].id,
      ]);

      reply.status(201);
      return {};
    }
  );

  /**
   * DELETE /v2/key-value-stores/:storeId/records/:key - Delete record
   */
  fastify.delete<{ Params: { storeId: string; key: string } }>(
    '/key-value-stores/:storeId/records/:key',
    async (request, reply) => {
      const { storeId, key } = request.params;
      const isAdmin = request.user?.role === 'admin';
      const params: unknown[] = [storeId, storeId];
      const accessWhere = buildResourceAccessWhere(request.user!.id, isAdmin, params);

      const store = await query<KVStoreRow>(
        `SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND ${accessWhere}`,
        params
      );

      if (!store.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
      }

      await deleteKVRecord(store.rows[0].id, key);

      reply.status(204);
    }
  );
};

function formatStore(row: KVStoreRow) {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    accessedAt: row.accessed_at,
  };
}
