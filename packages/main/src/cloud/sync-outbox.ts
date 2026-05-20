import {db} from '../db';
import {getCloudSyncConfig} from './config';

export type SyncEntityType =
  | 'group'
  | 'proxy'
  | 'tag'
  | 'window'
  | 'extension'
  | 'window_extension';

export type SyncOperation = 'create' | 'update' | 'delete';

export const enqueueSyncOutbox = async (
  entityType: SyncEntityType,
  operation: SyncOperation,
  payload: {
    localId?: number;
    cloudId?: string | null;
    data?: unknown;
  },
) => {
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
    payload: JSON.stringify(payload.data || {}),
    updated_at: db.fn.now(),
  });
};
