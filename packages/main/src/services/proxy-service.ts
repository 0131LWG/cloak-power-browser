import {ipcMain} from 'electron';
import type {DB} from '../../../shared/types/db';
import {ProxyDB} from '../db/proxy';
import {testProxy} from '../fingerprint/prepare';
import {randomUUID} from 'crypto';
import {getCloudSyncConfig} from '../cloud/config';
import {enqueueSyncOutbox} from '../cloud/sync-outbox';

export const initProxyService = () => {
  ipcMain.handle('proxy-create', async (_, proxy: DB.Proxy) => {
    const cloudConfig = await getCloudSyncConfig();
    const payload = cloudConfig.enabled
      ? {
          ...proxy,
          cloud_id: proxy.cloud_id || randomUUID(),
          workspace_id: proxy.workspace_id || cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : proxy;
    const result = await ProxyDB.create(payload);
    await enqueueSyncOutbox('proxy', 'create', {
      localId: result?.[0],
      cloudId: payload.cloud_id,
      data: payload,
    });
    return result;
  });

  ipcMain.handle('proxy-import', async (_, proxies: DB.Proxy[]) => {
    const cloudConfig = await getCloudSyncConfig();
    const payload = cloudConfig.enabled
      ? proxies.map(proxy => ({
          ...proxy,
          cloud_id: proxy.cloud_id || randomUUID(),
          workspace_id: proxy.workspace_id || cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }))
      : proxies;
    const result = await ProxyDB.importProxies(payload);
    for (const proxy of payload) {
      await enqueueSyncOutbox('proxy', 'create', {
        cloudId: proxy.cloud_id,
        data: proxy,
      });
    }
    return result;
  });

  ipcMain.handle('proxy-update', async (_, id: number, proxy: DB.Proxy) => {
    const cloudConfig = await getCloudSyncConfig();
    const payload = cloudConfig.enabled
      ? {
          ...proxy,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : proxy;
    const result = await ProxyDB.update(id, payload);
    await enqueueSyncOutbox('proxy', 'update', {
      localId: id,
      cloudId: payload.cloud_id,
      data: payload,
    });
    return result;
  });

  ipcMain.handle('proxy-delete', async (_, proxy: DB.Proxy) => {
    const result = await ProxyDB.remove(proxy.id!);
    await enqueueSyncOutbox('proxy', 'delete', {
      localId: proxy.id,
      cloudId: proxy.cloud_id,
      data: proxy,
    });
    return result;
  });

  ipcMain.handle('proxy-getAll', async () => {
    return await ProxyDB.all();
  });
  ipcMain.handle('proxy-batchDelete', async (_, ids: number[]) => {
    return await ProxyDB.batchDelete(ids);
  });

  ipcMain.handle('proxy-getById', async (_, id: number) => {
    return await ProxyDB.getById(id);
  });

  ipcMain.handle('proxy-test', async (_, testParams: number | DB.Proxy) => {
    if (typeof testParams === 'number') {
      const proxy = await ProxyDB.getById(testParams);
      return await testProxy(proxy);
    } else {
      return await testProxy(testParams);
    }
  });
};
