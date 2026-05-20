import {ipcMain} from 'electron';
import type {DB} from '../../../shared/types/db';
import {GroupDB} from '../db/group';
import {WindowDB} from '../db/window';
import {randomUUID} from 'crypto';
import {getCloudSyncConfig} from '../cloud/config';
import {enqueueSyncOutbox} from '../cloud/sync-outbox';
export const initGroupService = () => {
  ipcMain.handle('group-create', async (_, group: DB.Group) => {
    const cloudConfig = await getCloudSyncConfig();
    const payload = cloudConfig.enabled
      ? {
          ...group,
          cloud_id: group.cloud_id || randomUUID(),
          workspace_id: group.workspace_id || cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : group;
    const result = await GroupDB.create(payload);
    await enqueueSyncOutbox('group', 'create', {
      localId: result?.[0],
      cloudId: payload.cloud_id,
      data: payload,
    });
    return result;
  });

  ipcMain.handle('group-update', async (_, group: DB.Group) => {
    const cloudConfig = await getCloudSyncConfig();
    const payload = cloudConfig.enabled
      ? {
          ...group,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : group;
    const result = await GroupDB.update(group.id!, payload);
    await enqueueSyncOutbox('group', 'update', {
      localId: group.id,
      cloudId: payload.cloud_id,
      data: payload,
    });
    return result;
  });

  ipcMain.handle('group-delete', async (_, id: number) => {
    // group_id = id,  status > 0
    const windows = await WindowDB.find({group_id: id});
    if (windows.filter(window => window.status > 0).length > 0) {
      return {
        success: false,
        message: 'Group is used by some windows',
      };
    }
    const group = await GroupDB.getById(id);
    const res = await GroupDB.remove(id);
    await enqueueSyncOutbox('group', 'delete', {
      localId: id,
      cloudId: group?.cloud_id,
      data: group,
    });
    return {
      success: true,
      message: 'Group deleted successfully',
      data: res,
    };
  });

  ipcMain.handle('group-getAll', async () => {
    return await GroupDB.all();
  });
  ipcMain.handle('group-getById', async (_, id: number) => {
    return await GroupDB.getById(id);
  });
};
