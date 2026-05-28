import {app} from 'electron';
import axios from 'axios';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import type {DB} from '../../../shared/types/db';
import {cloudApiClient} from './client';
import type {ProfileLockResult} from './types';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const HEARTBEAT_INTERVAL_MS = 15000;
const RELEASE_RETRY_DELAY_MS = 5000;

type HeldLock = {
  profileCloudId: string;
  localWindowId: number;
  lockId?: string;
  timer?: NodeJS.Timeout;
};

const heldLocks = new Map<number, HeldLock>();
const releaseRetryTimers = new Map<number, NodeJS.Timeout>();

const isCloudLockedWindow = (windowData: DB.Window) => Boolean(windowData.cloud_id);

export const acquireProfileLock = async (windowData: DB.Window): Promise<ProfileLockResult> => {
  const config = await cloudApiClient.getConfig();
  if (!config.enabled) {
    logger.info('Profile lock skipped because cloud sync is disabled', {
      localWindowId: windowData.id,
      cloudId: windowData.cloud_id,
    });
    return {success: true, reason: 'disabled'};
  }

  if (!isCloudLockedWindow(windowData)) {
    logger.warn('Profile lock denied because window has no cloud_id', {
      localWindowId: windowData.id,
      profileId: windowData.profile_id,
      workspaceId: config.workspaceId,
      deviceId: config.deviceId,
    });
    return {
      success: false,
      reason: 'missing_cloud_id',
      message: 'Window has no cloud_id. Please sync this window before opening it on team mode.',
    };
  }

  const profileCloudId = windowData.cloud_id!;
  const payload = {
      device_id: config.deviceId,
      device_name: config.deviceName,
      user_id: config.userId,
      app_instance_id: `${process.pid}`,
  };

  logger.info('Profile lock acquire requested', {
    localWindowId: windowData.id,
    profileId: windowData.profile_id,
    cloudId: profileCloudId,
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    appInstanceId: `${process.pid}`,
  });

  let result: ProfileLockResult | undefined;
  try {
    result = await cloudApiClient.request<ProfileLockResult>(
      'post',
      `/profiles/${profileCloudId}/lock`,
      payload,
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 409) {
      const lockedResult = error.response.data as ProfileLockResult;
      logger.warn('Profile lock acquire rejected by server', {
        localWindowId: windowData.id,
        cloudId: profileCloudId,
        workspaceId: config.workspaceId,
        deviceId: config.deviceId,
        lockedBy: lockedResult?.locked_by,
      });
      return {
        success: false,
        reason: 'locked',
        message: lockedResult?.message || 'Profile is locked by another device.',
        locked_by: lockedResult?.locked_by,
      };
    }
    logger.error('Profile lock acquire failed', {
      localWindowId: windowData.id,
      cloudId: profileCloudId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      reason: 'network_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!result?.success) {
    logger.warn('Profile lock acquire returned unsuccessful response', {
      localWindowId: windowData.id,
      cloudId: profileCloudId,
      result,
    });
    return {
      success: false,
      reason: result?.reason || 'unknown',
      message: result?.message || 'Profile is locked by another device.',
      locked_by: result?.locked_by,
    };
  }

  logger.info('Profile lock acquired', {
    localWindowId: windowData.id,
    cloudId: profileCloudId,
    lockId: result.lock_id,
    deviceId: config.deviceId,
  });

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
    lock.timer = undefined;
  }

  if (!config.enabled) {
    heldLocks.delete(localWindowId);
    return;
  }

  try {
    await cloudApiClient.request('delete', `/profiles/${lock.profileCloudId}/lock`, {
      lock_id: lock.lockId,
      device_id: config.deviceId,
      app_instance_id: `${process.pid}`,
    });
    const retryTimer = releaseRetryTimers.get(localWindowId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      releaseRetryTimers.delete(localWindowId);
    }
    heldLocks.delete(localWindowId);
  } catch (error) {
    logger.error(`Profile lock release failed for window ${localWindowId}`, error);
    if (!releaseRetryTimers.has(localWindowId)) {
      const retryTimer = setTimeout(() => {
        releaseRetryTimers.delete(localWindowId);
        releaseProfileLock(localWindowId).catch(retryError => {
          logger.error(`Profile lock release retry failed for window ${localWindowId}`, retryError);
        });
      }, RELEASE_RETRY_DELAY_MS);
      releaseRetryTimers.set(localWindowId, retryTimer);
    }
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
