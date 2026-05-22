import {db} from '../db';
import {getCloudSyncConfig} from './config';
import {ensureCloudSyncSchema} from './schema';

export type SyncEntityType =
  | 'group'
  | 'proxy'
  | 'tag'
  | 'window'
  | 'extension'
  | 'window_extension';

export type SyncOperation = 'create' | 'update' | 'delete';

const safeStringifyPayload = (value: unknown) => {
  const seen = new WeakSet<object>();

  return JSON.stringify(value ?? {}, (_key, currentValue) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
        code: (currentValue as NodeJS.ErrnoException).code,
      };
    }

    if (typeof currentValue === 'object' && currentValue !== null) {
      if (seen.has(currentValue)) {
        return '[Circular]';
      }
      seen.add(currentValue);
    }

    return currentValue;
  });
};

export const enqueueSyncOutbox = async (
  entityType: SyncEntityType,
  operation: SyncOperation,
  payload: {
    localId?: number;
    cloudId?: string | null;
    data?: unknown;
  },
) => {
  await ensureCloudSyncSchema();
  const config = await getCloudSyncConfig();
  if (!config.enabled) {
    return;
  }

  await db('sync_outbox').insert({
    workspace_id: config.workspaceId || null,
    entity_type: entityType,
    local_id: payload.localId || null,
    cloud_id: payload.cloudId || null,
    operation,
    payload: safeStringifyPayload(payload.data),
    updated_at: db.fn.now(),
  });
};
