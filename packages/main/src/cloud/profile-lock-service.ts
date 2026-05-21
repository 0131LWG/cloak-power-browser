import {app} from 'electron';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import type {DB} from '../../../shared/types/db';
import {cloudApiClient} from './client';
import type {ProfileLockResult} from './types';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const HEARTBEAT_INTERVAL_MS = 15000;

type HeldLock = {
  profileCloudId: string;
  localWindowId: number;
  lockId?: string;
  timer?: NodeJS.Timeout;
};

const heldLocks = new Map<number, HeldLock>();

const isCloudLockedWindow = (windowData: DB.Window) => Boolean(windowData.cloud_id);

export const acquireProfileLock = async (windowData: DB.Window): Promise<ProfileLockResult> => {
  const config = await cloudApiClient.getConfig();
  if (!config.enabled) {
    return {success: true, reason: 'disabled'};
  }

  if (!isCloudLockedWindow(windowData)) {
    return {
      success: false,
      reason: 'missing_cloud_id',
      message: 'Window has no cloud_id. Please sync this window before opening it on team mode.',
    };
  }

  const profileCloudId = windowData.cloud_id!;
  const result = await cloudApiClient.request<ProfileLockResult>(
    'post',
    `/profiles/${profileCloudId}/lock`,
    {
      device_id: config.deviceId,
      device_name: config.deviceName,
      user_id: config.userId,
      app_instance_id: `${process.pid}`,
    },
  );

  if (!result?.success) {
    return {
      success: false,
      reason: result?.reason || 'unknown',
      message: result?.message || 'Profile is locked by another device.',
      locked_by: result?.locked_by,
    };
  }

  heldLocks.set(windowData.id!, {
    profileCloudId,
    localWindowId: windowData.id!,
    lockId: result.lock_id,
  });
  startProfileLockHeartbeat(windowData.id!);

  return result;
};

export const startProfileLockHeartbeat = (localWindowId: number) => {
  const lock = heldLocks.get(localWindowId);
  if (!lock || lock.timer) {
    return;
  }

  lock.timer = setInterval(() => {
    heartbeatProfileLock(localWindowId).catch(error => {
      logger.error(`Profile lock heartbeat failed for window ${localWindowId}`, error);
    });
  }, HEARTBEAT_INTERVAL_MS);
};

export const heartbeatProfileLock = async (localWindowId: number) => {
  const config = await cloudApiClient.getConfig();
  const lock = heldLocks.get(localWindowId);
  if (!config.enabled || !lock) {
    return;
  }

  await cloudApiClient.request('post', `/profiles/${lock.profileCloudId}/lock/heartbeat`, {
    lock_id: lock.lockId,
    device_id: config.deviceId,
    app_instance_id: `${process.pid}`,
  });
};

export const releaseProfileLock = async (localWindowId: number) => {
  const config = await cloudApiClient.getConfig();
  const lock = heldLocks.get(localWindowId);
  if (!lock) {
    return;
  }

  if (lock.timer) {
    clearInterval(lock.timer);
  }
  heldLocks.delete(localWindowId);

  if (!config.enabled) {
    return;
  }

  try {
    await cloudApiClient.request('delete', `/profiles/${lock.profileCloudId}/lock`, {
      lock_id: lock.lockId,
      device_id: config.deviceId,
      app_instance_id: `${process.pid}`,
    });
  } catch (error) {
    logger.error(`Profile lock release failed for window ${localWindowId}`, error);
  }
};

export const releaseAllProfileLocks = async () => {
  const localWindowIds = [...heldLocks.keys()];
  await Promise.all(localWindowIds.map(id => releaseProfileLock(id)));
};

app.on('before-quit', () => {
  releaseAllProfileLocks().catch(error => {
    logger.error('Failed to release profile locks before quit', error);
  });
});
