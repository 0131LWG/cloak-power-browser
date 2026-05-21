import {db} from '../db';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {cloudApiClient} from './client';
import {ensureCloudSyncSchema} from './schema';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const DEFAULT_FLUSH_LIMIT = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30000;

let flushTimer: NodeJS.Timeout | undefined;
let isFlushing = false;

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
    flushSyncOutbox().catch(error => {
      logger.error('Scheduled cloud sync failed', error);
    });
  }, DEFAULT_FLUSH_INTERVAL_MS);

  flushSyncOutbox().catch(error => {
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
