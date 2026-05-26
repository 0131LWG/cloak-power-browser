import {db} from '../db';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {cloudApiClient} from './client';
import {ensureCloudSyncSchema} from './schema';
import {randomUUID} from 'crypto';
import {enqueueSyncOutbox} from './sync-outbox';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const DEFAULT_FLUSH_LIMIT = 50;
const DEFAULT_PULL_LIMIT = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MAX_DRAIN_ROUNDS = 40;
const SYNC_STATE_ENTITY = 'all';

let flushTimer: NodeJS.Timeout | undefined;
let isFlushing = false;
let isPulling = false;
let maxPendingOutbox = 0;
let lastSyncActivityAt = 0;
const hasUpdatedAtColumnCache = new Map<string, boolean>();

const updateWithTimestampIfSupported = async (
  tableName: string,
  where: Record<string, unknown>,
  payload: Record<string, unknown>,
) => {
  let hasUpdatedAt = hasUpdatedAtColumnCache.get(tableName);
  if (hasUpdatedAt === undefined) {
    hasUpdatedAt = await db.schema.hasColumn(tableName, 'updated_at');
    hasUpdatedAtColumnCache.set(tableName, hasUpdatedAt);
  }
  const updatePayload = hasUpdatedAt ? {...payload, updated_at: db.fn.now()} : payload;
  await db(tableName).where(where).update(updatePayload);
};

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

    lastSyncActivityAt = Date.now();
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
  await backfillLegacyCloudSyncData();
  await mergeDuplicateGroupsByName();
  await repairWindowRelationsFromCloudIds();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || flushTimer) {
    return;
  }

  flushTimer = setInterval(() => {
    Promise.all([flushSyncOutboxUntilIdle(), pullSyncEventsUntilIdle()]).catch(error => {
      logger.error('Scheduled cloud sync failed', error);
    });
  }, DEFAULT_FLUSH_INTERVAL_MS);

  Promise.all([flushSyncOutboxUntilIdle(), pullSyncEventsUntilIdle()]).catch(error => {
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
    if (appliedCount > 0) {
      lastSyncActivityAt = Date.now();
    }
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

export const rebuildCloudSyncOutboxForWorkspace = async () => {
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || !config.workspaceId) {
    return {success: false, message: 'cloud sync is disabled or workspace_id is empty'};
  }

  await backfillLegacyCloudSyncData();
  await mergeDuplicateGroupsByName();
  await repairWindowRelationsFromCloudIds();

  let groupsEnqueued = 0;
  let proxiesEnqueued = 0;
  let windowsEnqueued = 0;

  const groups = await db('group')
    .where(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId);
    })
    .select('*');
  for (const group of groups) {
    const cloudId = group.cloud_id || randomUUID();
    if (!group.cloud_id || !group.workspace_id) {
      await updateWithTimestampIfSupported('group', {id: group.id}, {
        cloud_id: cloudId,
        workspace_id: group.workspace_id || config.workspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      });
    }
    const latestGroup = await db('group').where({id: group.id}).first();
    await enqueueSyncOutbox('group', group.cloud_id ? 'update' : 'create', {
      localId: group.id,
      cloudId,
      data: latestGroup,
    });
    groupsEnqueued++;
  }

  const proxies = await db('proxy')
    .where(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId);
    })
    .select('*');
  for (const proxy of proxies) {
    const cloudId = proxy.cloud_id || randomUUID();
    if (!proxy.cloud_id || !proxy.workspace_id) {
      await updateWithTimestampIfSupported('proxy', {id: proxy.id}, {
        cloud_id: cloudId,
        workspace_id: proxy.workspace_id || config.workspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      });
    }
    const latestProxy = await db('proxy').where({id: proxy.id}).first();
    await enqueueSyncOutbox('proxy', proxy.cloud_id ? 'update' : 'create', {
      localId: proxy.id,
      cloudId,
      data: latestProxy,
    });
    proxiesEnqueued++;
  }

  const windows = await db('window')
    .where('status', '>', 0)
    .andWhere(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId);
    })
    .select('*');
  for (const windowData of windows) {
    const cloudId = windowData.cloud_id || randomUUID();
    if (!windowData.cloud_id || !windowData.workspace_id) {
      await updateWithTimestampIfSupported('window', {id: windowData.id}, {
        cloud_id: cloudId,
        workspace_id: windowData.workspace_id || config.workspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      });
    }
    const latestWindow = await db('window').where({id: windowData.id}).first();
    await enqueueSyncOutbox('window', windowData.cloud_id ? 'update' : 'create', {
      localId: windowData.id,
      cloudId,
      data: latestWindow,
    });
    windowsEnqueued++;
  }

  const flushResult = await flushSyncOutboxUntilIdle();
  logger.info('Cloud sync outbox rebuilt for workspace', {
    workspaceId: config.workspaceId,
    groupsEnqueued,
    proxiesEnqueued,
    windowsEnqueued,
    flushed: flushResult?.count || 0,
  });

  return {
    success: true,
    workspaceId: config.workspaceId,
    groupsEnqueued,
    proxiesEnqueued,
    windowsEnqueued,
    flushed: flushResult?.count || 0,
  };
};

export const getCloudSyncProgress = async () => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      pendingOutbox: 0,
      progressPercent: 100,
      syncing: false,
      lastSyncActivityAt: lastSyncActivityAt || null,
    };
  }

  const pendingRow = await db('sync_outbox')
    .whereNull('processed_at')
    .where(builder => {
      builder.whereNull('workspace_id');
      if (config.workspaceId) {
        builder.orWhere('workspace_id', config.workspaceId);
      }
    })
    .count<{count: number}[]>('* as count')
    .first();

  const pendingOutbox = Number(pendingRow?.count || 0) || 0;
  if (pendingOutbox > maxPendingOutbox) {
    maxPendingOutbox = pendingOutbox;
  }
  if (pendingOutbox === 0) {
    maxPendingOutbox = 0;
  }

  const baseline = Math.max(maxPendingOutbox, pendingOutbox, 1);
  const progressPercent = pendingOutbox === 0 ? 100 : Math.max(1, Math.min(99, Math.round(((baseline - pendingOutbox) / baseline) * 100)));

  return {
    enabled: true,
    pendingOutbox,
    progressPercent,
    syncing: isFlushing || isPulling || pendingOutbox > 0,
    lastSyncActivityAt: lastSyncActivityAt || null,
  };
};

const flushSyncOutboxUntilIdle = async () => {
  let total = 0;
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    const result = await flushSyncOutbox();
    const count = Number(result?.count || 0);
    total += count;
    if (!result?.success || result?.skipped || count < DEFAULT_FLUSH_LIMIT) {
      break;
    }
  }
  return {success: true, count: total};
};

const pullSyncEventsUntilIdle = async () => {
  let total = 0;
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    const result = await pullSyncEvents();
    const count = Number(result?.count || 0);
    total += count;
    if (!result?.success || result?.skipped || count < DEFAULT_PULL_LIMIT) {
      break;
    }
  }
  await repairWindowRelationsFromCloudIds();
  return {success: true, count: total};
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
      await repairWindowGroupReferences(cloudId);
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

const repairWindowGroupReferences = async (groupCloudId: string) => {
  const groupId = await findLocalIdByCloudId('group', groupCloudId);
  if (!groupId) {
    return;
  }

  const hasGroupCloudIdColumn = await db.schema.hasColumn('window', 'group_cloud_id');
  if (!hasGroupCloudIdColumn) {
    return;
  }

  await db('window')
    .where({group_cloud_id: groupCloudId})
    .where(builder => {
      builder.whereNull('group_id').orWhere('group_id', 0);
    })
    .update({
      group_id: groupId,
      updated_at: db.fn.now(),
    });
};

const repairWindowRelationsFromCloudIds = async () => {
  const hasWindowTable = await db.schema.hasTable('window');
  if (!hasWindowTable) {
    return;
  }

  const hasGroupCloudIdColumn = await db.schema.hasColumn('window', 'group_cloud_id');
  const hasProxyCloudIdColumn = await db.schema.hasColumn('window', 'proxy_cloud_id');
  if (!hasGroupCloudIdColumn && !hasProxyCloudIdColumn) {
    return;
  }

  const windows = await db('window')
    .select('id', 'group_id', 'group_cloud_id', 'proxy_id', 'proxy_cloud_id')
    .where('status', '>', 0);

  let updatedWindows = 0;
  let repairedGroupIdCount = 0;
  let repairedProxyIdCount = 0;
  let repairedGroupCloudIdCount = 0;
  let repairedProxyCloudIdCount = 0;

  for (const row of windows) {
    const updates: Record<string, unknown> = {};

    if (hasGroupCloudIdColumn && row.group_id && (!row.group_cloud_id || String(row.group_cloud_id).trim() === '')) {
      const group = await db('group').select('cloud_id').where({id: row.group_id}).first();
      if (group?.cloud_id) {
        updates.group_cloud_id = group.cloud_id;
        repairedGroupCloudIdCount++;
      }
    }

    if (hasGroupCloudIdColumn && row.group_cloud_id && (!row.group_id || row.group_id === 0)) {
      const groupId = await findLocalIdByCloudId('group', String(row.group_cloud_id));
      if (groupId) {
        updates.group_id = groupId;
        repairedGroupIdCount++;
      }
    }

    if (hasProxyCloudIdColumn && row.proxy_id && (!row.proxy_cloud_id || String(row.proxy_cloud_id).trim() === '')) {
      const proxy = await db('proxy').select('cloud_id').where({id: row.proxy_id}).first();
      if (proxy?.cloud_id) {
        updates.proxy_cloud_id = proxy.cloud_id;
        repairedProxyCloudIdCount++;
      }
    }

    if (hasProxyCloudIdColumn && row.proxy_cloud_id && (!row.proxy_id || row.proxy_id === 0)) {
      const proxyId = await findLocalIdByCloudId('proxy', String(row.proxy_cloud_id));
      if (proxyId) {
        updates.proxy_id = proxyId;
        repairedProxyIdCount++;
      }
    }

    if (Object.keys(updates).length > 0) {
      await updateWithTimestampIfSupported('window', {id: row.id}, updates);
      updatedWindows++;
    }
  }

  logger.info('Window relation repair completed', {
    scanned: windows.length,
    updatedWindows,
    repairedGroupIdCount,
    repairedProxyIdCount,
    repairedGroupCloudIdCount,
    repairedProxyCloudIdCount,
  });
};

const backfillLegacyCloudSyncData = async () => {
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || !config.workspaceId) {
    return;
  }

  let groupsPatched = 0;
  let proxiesPatched = 0;
  let windowsPatched = 0;

  const groups = await db('group').select('*');
  for (const group of groups) {
    const nextCloudId = group.cloud_id || randomUUID();
    const nextWorkspaceId = group.workspace_id || config.workspaceId;
    const shouldPatch = !group.cloud_id || !group.workspace_id;
    if (!shouldPatch) continue;

    await updateWithTimestampIfSupported('group', {id: group.id}, {
        cloud_id: nextCloudId,
        workspace_id: nextWorkspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      });

    const latestGroup = await db('group').where({id: group.id}).first();
    await enqueueSyncOutbox('group', group.cloud_id ? 'update' : 'create', {
      localId: group.id,
      cloudId: nextCloudId,
      data: latestGroup,
    });
    groupsPatched++;
  }

  const proxies = await db('proxy').select('*');
  for (const proxy of proxies) {
    const nextCloudId = proxy.cloud_id || randomUUID();
    const nextWorkspaceId = proxy.workspace_id || config.workspaceId;
    const shouldPatch = !proxy.cloud_id || !proxy.workspace_id;
    if (!shouldPatch) continue;

    await updateWithTimestampIfSupported('proxy', {id: proxy.id}, {
        cloud_id: nextCloudId,
        workspace_id: nextWorkspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      });

    const latestProxy = await db('proxy').where({id: proxy.id}).first();
    await enqueueSyncOutbox('proxy', proxy.cloud_id ? 'update' : 'create', {
      localId: proxy.id,
      cloudId: nextCloudId,
      data: latestProxy,
    });
    proxiesPatched++;
  }

  const groupCloudById = new Map<number, string>();
  for (const group of await db('group').select('id', 'cloud_id')) {
    if (group?.id && group?.cloud_id) {
      groupCloudById.set(Number(group.id), String(group.cloud_id));
    }
  }
  const proxyCloudById = new Map<number, string>();
  for (const proxy of await db('proxy').select('id', 'cloud_id')) {
    if (proxy?.id && proxy?.cloud_id) {
      proxyCloudById.set(Number(proxy.id), String(proxy.cloud_id));
    }
  }

  const windows = await db('window').where('status', '>', 0).select('*');
  for (const windowData of windows) {
    const nextCloudId = windowData.cloud_id || randomUUID();
    const nextWorkspaceId = windowData.workspace_id || config.workspaceId;
    const nextGroupCloudId =
      windowData.group_cloud_id || (windowData.group_id ? groupCloudById.get(Number(windowData.group_id)) : null);
    const nextProxyCloudId =
      windowData.proxy_cloud_id || (windowData.proxy_id ? proxyCloudById.get(Number(windowData.proxy_id)) : null);

    const shouldPatch =
      !windowData.cloud_id ||
      !windowData.workspace_id ||
      (windowData.group_id && !windowData.group_cloud_id && Boolean(nextGroupCloudId)) ||
      (windowData.proxy_id && !windowData.proxy_cloud_id && Boolean(nextProxyCloudId));
    if (!shouldPatch) continue;

    await updateWithTimestampIfSupported('window', {id: windowData.id}, {
        cloud_id: nextCloudId,
        workspace_id: nextWorkspaceId,
        group_cloud_id: nextGroupCloudId || null,
        proxy_cloud_id: nextProxyCloudId || null,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      });

    const latestWindow = await db('window').where({id: windowData.id}).first();
    await enqueueSyncOutbox('window', windowData.cloud_id ? 'update' : 'create', {
      localId: windowData.id,
      cloudId: nextCloudId,
      data: latestWindow,
    });
    windowsPatched++;
  }

  if (groupsPatched || proxiesPatched || windowsPatched) {
    logger.info('Legacy cloud sync backfill completed', {
      workspaceId: config.workspaceId,
      groupsPatched,
      proxiesPatched,
      windowsPatched,
    });
  }
};

const normalizeGroupNameKey = (name: unknown) => String(name || '').trim().toLowerCase();

const mergeDuplicateGroupsByName = async () => {
  const hasGroupTable = await db.schema.hasTable('group');
  const hasWindowTable = await db.schema.hasTable('window');
  if (!hasGroupTable || !hasWindowTable) {
    return;
  }

  const groups = await db('group')
    .select('id', 'name', 'workspace_id', 'cloud_id', 'created_at')
    .orderBy('id', 'asc');

  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const group of groups) {
    const key = `${String(group.workspace_id || '')}::${normalizeGroupNameKey(group.name)}`;
    if (!normalizeGroupNameKey(group.name)) continue;
    const list = buckets.get(key) || [];
    list.push(group as Record<string, unknown>);
    buckets.set(key, list);
  }

  let mergedGroups = 0;
  let reassignedWindows = 0;

  for (const list of buckets.values()) {
    if (list.length <= 1) continue;

    const canonical =
      list.find(item => item.cloud_id) ||
      list[0];

    const canonicalId = Number(canonical.id);
    const duplicateIds = list
      .map(item => Number(item.id))
      .filter(id => id !== canonicalId);

    if (!duplicateIds.length) continue;

    const affected = await db('window')
      .whereIn('group_id', duplicateIds)
      .update({
        group_id: canonicalId,
        updated_at: db.fn.now(),
      });
    reassignedWindows += Number(affected || 0);

    // Keep the canonical group and remove duplicates.
    await db('group').whereIn('id', duplicateIds).delete();
    mergedGroups += duplicateIds.length;
  }

  if (mergedGroups > 0) {
    logger.info('Merged duplicate groups by name', {
      mergedGroups,
      reassignedWindows,
    });
  }
};

const toNullableString = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
};
