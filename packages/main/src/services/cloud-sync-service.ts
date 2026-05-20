import {ipcMain} from 'electron';
import {cloudApiClient} from '../cloud/client';
import {getCloudSyncConfig} from '../cloud/config';
import {releaseAllProfileLocks} from '../cloud/profile-lock-service';
import {flushSyncOutbox, startCloudSyncEngine, stopCloudSyncEngine} from '../cloud/sync-engine';

export const initCloudSyncService = () => {
  startCloudSyncEngine().catch(() => {
    // The engine is optional; failures are surfaced by explicit status/flush calls.
  });

  ipcMain.handle('cloud-sync-status', async () => {
    const config = await getCloudSyncConfig();
    return {
      enabled: config.enabled,
      apiBaseUrl: config.apiBaseUrl,
      workspaceId: config.workspaceId,
      userId: config.userId,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
    };
  });

  ipcMain.handle('cloud-sync-refresh-config', async () => {
    const config = await cloudApiClient.refreshConfig();
    stopCloudSyncEngine();
    await startCloudSyncEngine();
    return config;
  });

  ipcMain.handle('cloud-sync-flush-outbox', async () => {
    return await flushSyncOutbox();
  });

  ipcMain.handle('cloud-sync-release-locks', async () => {
    await releaseAllProfileLocks();
    return {success: true};
  });
};
