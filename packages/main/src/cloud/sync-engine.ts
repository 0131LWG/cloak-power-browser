import {db} from '../db';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {cloudApiClient} from './client';
import {ensureCloudSyncSchema} from './schema';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const DEFAULT_FLUSH_LIMIT = 50;
const DEFAULT_PULL_LIMIT = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 30000;
const SYNC_STATE_ENTITY = 'all';

let flushTimer: NodeJS.Timeout | undefined;
let isFlushing = false;
let isPulling = false;

export const flushSyncOutbox = async (limit = DEFAULT_FLUSH_LIMIT) => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled) {
    return {success: true, skipped: true, count: 0};
  }

  if (isFlushing) {
    return {success: true, skipped: true, count: 0};
  }

  isFlushing = true;
  try {
    const rows = await db('sync_outbox')
      .whereNull('processed_at')
      .where(builder => {
        builder.whereNull('workspace_id');
        if (config.workspaceId) {
          builder.orWhere('workspace_id', config.workspaceId);
        }
      })
      .orderBy('created_at', 'asc')
      .limit(limit);

    if (!rows.length) {
      return {success: true, count: 0};
    }

    const events = rows.map(row => ({
      id: row.id,
      entity_type: row.entity_type,
      local_id: row.local_id,
      cloud_id: row.cloud_id,
      operation: row.operation,
      payload: parsePayload(row.payload),
      created_at: row.created_at,
    }));

    await cloudApiClient.request('post', '/sync/outbox', {
      workspace_id: config.workspaceId,
      device_id: config.deviceId,
      events,
    });

    await db('sync_outbox')
      .whereIn(
        'id',
        rows.map(row => row.id),
      )
      .update({
        processed_at: db.fn.now(),
        updated_at: db.fn.now(),
        last_error: null,
      });

    return {success: true, count: rows.length};
  } catch (error) {
    logger.error('Cloud sync outbox flush failed', error);
    await db('sync_outbox')
      .whereNull('processed_at')
      .update({
        attempt_count: db.raw('attempt_count + 1'),
        updated_at: db.fn.now(),
        last_error: error instanceof Error ? error.message : String(error),
      });
    return {success: false, count: 0, error: error instanceof Error ? error.message : String(error)};
  } finally {
    isFlushing = false;
  }
};

export const startCloudSyncEngine = async () => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || flushTimer) {
    return;
  }

  flushTimer = setInterval(() => {
    Promise.all([flushSyncOutbox(), pullSyncEvents()]).catch(error => {
      logger.error('Scheduled cloud sync failed', error);
    });
  }, DEFAULT_FLUSH_INTERVAL_MS);

  Promise.all([flushSyncOutbox(), pullSyncEvents()]).catch(error => {
    logger.error('Initial cloud sync failed', error);
  });
};

export const stopCloudSyncEngine = () => {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
};

const parsePayload = (payload: unknown) => {
  if (!payload || typeof payload !== 'string') {
    return payload || {};
  }

  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
};

type CloudSyncEvent = {
  cursor?: number;
  id?: number;
  workspace_id?: string;
  device_id?: string;
  entity_type: string;
  local_id?: number;
  cloud_id?: string;
  operation: 'create' | 'update' | 'delete';
  payload?: unknown;
  created_at?: string;
  received_at?: string;
};

type PullResponse = {
  success: boolean;
  events?: CloudSyncEvent[];
  next_cursor?: number;
  has_more?: boolean;
};

export const pullSyncEvents = async (limit = DEFAULT_PULL_LIMIT) => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || !config.workspaceId) {
    return {success: true, skipped: true, count: 0};
  }

  if (isPulling) {
    return {success: true, skipped: true, count: 0};
  }

  isPulling = true;
  try {
    const state = await db('sync_state')
      .where({workspace_id: config.workspaceId, entity_type: SYNC_STATE_ENTITY})
      .first();
    const cursor = Number(state?.cursor || 0) || 0;

    const response = await cloudApiClient.request<PullResponse>('post', '/sync/pull', {
      workspace_id: config.workspaceId,
      device_id: config.deviceId,
      cursor,
      limit,
    });

    if (!response?.success) {
      return {success: true, count: 0};
    }

    const events = Array.isArray(response.events) ? response.events : [];
    if (!events.length) {
      return {success: true, count: 0};
    }

    let maxCursor = cursor;
    for (const event of events) {
      if ((event.cursor || 0) > maxCursor) {
        maxCursor = event.cursor || 0;
      }
      if (event.device_id && event.device_id === config.deviceId) {
        continue;
      }
      await applySyncEvent(event);
    }

    await upsertSyncCursor(config.workspaceId, maxCursor);
    return {success: true, count: events.length, next_cursor: maxCursor};
  } catch (error) {
    logger.error('Cloud sync pull failed', error);
    return {success: false, count: 0, error: error instanceof Error ? error.message : String(error)};
  } finally {
    isPulling = false;
  }
};

const upsertSyncCursor = async (workspaceId: string, cursor: number) => {
  const existing = await db('sync_state')
    .where({workspace_id: workspaceId, entity_type: SYNC_STATE_ENTITY})
    .first();

  if (existing) {
    await db('sync_state')
      .where({id: existing.id})
      .update({
        cursor: String(cursor),
        last_pulled_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
    return;
  }

  await db('sync_state').insert({
    workspace_id: workspaceId,
    entity_type: SYNC_STATE_ENTITY,
    cursor: String(cursor),
    last_pulled_at: db.fn.now(),
    updated_at: db.fn.now(),
  });
};

const applySyncEvent = async (event: CloudSyncEvent) => {
  const payload = parsePayload(event.payload) as Record<string, unknown>;
  const cloudId = String(event.cloud_id || payload?.cloud_id || '');
  if (!cloudId) {
    return;
  }

  switch (event.entity_type) {
    case 'group':
      await applyEntityUpsertOrDelete('group', cloudId, event.operation, payload, ['name']);
      return;
    case 'proxy':
      await applyEntityUpsertOrDelete('proxy', cloudId, event.operation, payload, [
        'ip',
        'proxy',
        'proxy_type',
        'ip_checker',
        'ip_country',
        'remark',
        'check_result',
        'workspace_id',
        'sync_version',
        'sync_deleted_at',
        'last_synced_at',
        'updated_by_device_id',
      ]);
      return;
    case 'window':
      await applyEntityUpsertOrDelete('window', cloudId, event.operation, payload, [
        'profile_id',
        'name',
        'group_id',
        'proxy_id',
        'tags',
        'remark',
        'cookie',
        'ua',
        'fingerprint',
        'browser_engine',
        'browser_core_family',
        'browser_channel',
        'browser_min_core_version',
        'browser_runtime_overrides',
        'browser_runtime_platform',
        'browser_version',
        'workspace_id',
        'sync_version',
        'sync_deleted_at',
        'last_synced_at',
        'updated_by_device_id',
      ]);
      return;
    case 'extension':
      await applyEntityUpsertOrDelete('extension', cloudId, event.operation, payload, [
        'name',
        'version',
        'icon',
        'description',
        'source_type',
        'source_url',
        'chrome_extension_id',
        'distribution_mode',
        'auto_update',
        'workspace_id',
        'sync_version',
        'sync_deleted_at',
        'last_synced_at',
        'updated_by_device_id',
      ]);
      return;
    default:
      return;
  }
};

const applyEntityUpsertOrDelete = async (
  tableName: string,
  cloudId: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  allowedFields: string[],
) => {
  if (operation === 'delete') {
    await db(tableName).where({cloud_id: cloudId}).delete();
    return;
  }

  const sanitized = sanitizePayload(payload, allowedFields);
  const updateData = {
    ...sanitized,
    cloud_id: cloudId,
    sync_dirty: false,
  };

  const existing = await db(tableName).where({cloud_id: cloudId}).first();
  if (existing) {
    await db(tableName).where({id: existing.id}).update(updateData);
    return;
  }

  await db(tableName).insert(updateData);
};

const sanitizePayload = (payload: Record<string, unknown>, allowedFields: string[]) => {
  const sanitized: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (payload[key] !== undefined) {
      sanitized[key] = payload[key];
    }
  }
  return sanitized;
};
