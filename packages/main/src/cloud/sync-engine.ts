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
    let appliedCount = 0;
    for (const event of events) {
      const eventCursor = event.cursor || 0;
      if (event.device_id && event.device_id === config.deviceId) {
        if (eventCursor > maxCursor) {
          maxCursor = eventCursor;
        }
        continue;
      }

      try {
        await applySyncEvent(event);
        appliedCount++;
        if (eventCursor > maxCursor) {
          maxCursor = eventCursor;
        }
      } catch (error) {
        logger.error('Cloud sync apply event failed', {
          error: error instanceof Error ? error.message : String(error),
          entityType: event.entity_type,
          operation: event.operation,
          cloudId: event.cloud_id,
          cursor: event.cursor,
        });
        // Keep cursor at last successfully applied event so failed event can be retried.
        break;
      }
    }

    await upsertSyncCursor(config.workspaceId, maxCursor);
    return {success: true, count: appliedCount, next_cursor: maxCursor};
  } catch (error) {
    logger.error('Cloud sync pull failed', error);
    return {success: false, count: 0, error: error instanceof Error ? error.message : String(error)};
  } finally {
    isPulling = false;
  }
};

export const resetSyncCursor = async (workspaceId?: string) => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  const targetWorkspace = workspaceId || config.workspaceId;
  if (!targetWorkspace) {
    return {success: false, message: 'workspace_id is required'};
  }

  await db('sync_state').where({workspace_id: targetWorkspace, entity_type: SYNC_STATE_ENTITY}).delete();
  return {success: true, workspace_id: targetWorkspace};
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
      await repairWindowProxyReferences(cloudId);
      return;
    case 'window':
      await applyWindowSyncEvent(cloudId, event.operation, payload);
      return;
    case 'extension':
      await applyExtensionSyncEvent(cloudId, event.operation, payload);
      return;
    case 'window_extension':
      await applyWindowExtensionSyncEvent(cloudId, event.operation, payload);
      return;
    default:
      return;
  }
};

const applyExtensionSyncEvent = async (
  cloudId: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
) => {
  if (operation === 'delete') {
    await db('extension').where({cloud_id: cloudId}).delete();
    return;
  }

  const existing = await db('extension').where({cloud_id: cloudId}).first();
  const normalizedPayload: Record<string, unknown> = {
    ...payload,
    name: toNullableString(payload.name) || existing?.name || 'Synced extension',
    distribution_mode: toNullableString(payload.distribution_mode) || existing?.distribution_mode || 'manual',
  };

  const pathValue = toNullableString(payload.path);
  if (pathValue) {
    normalizedPayload.path = pathValue;
  } else if (!existing) {
    // Extension files are machine-local. A synced Chrome Web Store record can arrive
    // before this machine has downloaded the package, but the legacy schema requires path.
    normalizedPayload.path = '';
  }

  await applyEntityUpsertOrDelete('extension', cloudId, operation, normalizedPayload, [
    'name',
    'version',
    'path',
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
};

const applyWindowExtensionSyncEvent = async (
  cloudId: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
) => {
  const windowCloudId = toNullableString(payload.window_cloud_id);
  const extensionCloudId = toNullableString(payload.extension_cloud_id);

  if (operation === 'delete') {
    const query = db('window_extension');
    if (cloudId) {
      await query.where({cloud_id: cloudId}).delete();
      return;
    }
    if (windowCloudId && extensionCloudId) {
      await query.where({window_cloud_id: windowCloudId, extension_cloud_id: extensionCloudId}).delete();
    }
    return;
  }

  if (!windowCloudId || !extensionCloudId) {
    return;
  }

  const windowId = await findLocalIdByCloudId('window', windowCloudId);
  const extensionId = await findLocalIdByCloudId('extension', extensionCloudId);
  if (!windowId || !extensionId) {
    return;
  }

  const updateData = compactUndefined({
    cloud_id: cloudId || `${extensionCloudId}:${windowCloudId}`,
    workspace_id: toNullableString(payload.workspace_id),
    window_cloud_id: windowCloudId,
    extension_cloud_id: extensionCloudId,
    window_id: windowId,
    extension_id: extensionId,
    sync_dirty: false,
    sync_version: payload.sync_version,
    sync_deleted_at: payload.sync_deleted_at,
    last_synced_at: payload.last_synced_at,
    updated_by_device_id: payload.updated_by_device_id,
  });

  const existing = await db('window_extension')
    .where({window_id: windowId, extension_id: extensionId})
    .first();
  if (existing) {
    await db('window_extension').where({id: existing.id}).update(updateData);
    return;
  }

  await db('window_extension').insert(updateData);
};

const applyWindowSyncEvent = async (
  cloudId: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
) => {
  if (operation === 'delete') {
    await db('window_extension').where({window_cloud_id: cloudId}).delete();
    await applyEntityUpsertOrDelete('window', cloudId, operation, payload, []);
    return;
  }

  const groupCloudId = toNullableString(payload.group_cloud_id);
  const proxyCloudId = toNullableString(payload.proxy_cloud_id);
  const groupId = groupCloudId ? await findLocalIdByCloudId('group', groupCloudId) : null;
  const proxyId = proxyCloudId ? await findLocalIdByCloudId('proxy', proxyCloudId) : null;

  const normalizedPayload = {
    ...payload,
    ...(groupCloudId ? {group_cloud_id: groupCloudId} : {}),
    ...(proxyCloudId ? {proxy_cloud_id: proxyCloudId} : {}),
    ...(groupCloudId ? {group_id: groupId} : {}),
    ...(proxyCloudId ? {proxy_id: proxyId} : {}),
  };

  await applyEntityUpsertOrDelete('window', cloudId, operation, normalizedPayload, [
        'profile_id',
        'name',
        'group_cloud_id',
        'group_id',
        'proxy_cloud_id',
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
};

const applyEntityUpsertOrDelete = async (
  tableName: string,
  cloudId: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  allowedFields: string[],
) => {
  if (operation === 'delete') {
    if (tableName === 'extension') {
      await db('window_extension').where({extension_cloud_id: cloudId}).delete();
    }
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

const compactUndefined = (payload: Record<string, unknown>) => {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
};

const findLocalIdByCloudId = async (tableName: string, cloudId: string) => {
  const row = await db(tableName).select('id').where({cloud_id: cloudId}).first();
  return row?.id ?? null;
};

const repairWindowProxyReferences = async (proxyCloudId: string) => {
  const proxyId = await findLocalIdByCloudId('proxy', proxyCloudId);
  if (!proxyId) {
    return;
  }

  const hasProxyCloudIdColumn = await db.schema.hasColumn('window', 'proxy_cloud_id');
  if (!hasProxyCloudIdColumn) {
    return;
  }

  await db('window')
    .where({proxy_cloud_id: proxyCloudId})
    .where(builder => {
      builder.whereNull('proxy_id').orWhere('proxy_id', 0);
    })
    .update({
      proxy_id: proxyId,
      updated_at: db.fn.now(),
    });
};

const toNullableString = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
};
