import os from 'os';
import {randomUUID} from 'crypto';
import {db} from '../db';
import {getSettings} from '../utils/get-settings';
import type {CloudSyncConfig} from './types';
import {ensureCloudSyncSchema} from './schema';

const getOrCreateDeviceId = async () => {
  await ensureCloudSyncSchema();
  const settings = getSettings();
  const configuredDeviceId = settings.cloudSync?.deviceId;
  if (configuredDeviceId) {
    return configuredDeviceId;
  }

  const existing = await db('sync_device').first();
  if (existing?.device_id) {
    return existing.device_id as string;
  }

  const deviceId = randomUUID();
  await db('sync_device').insert({
    device_id: deviceId,
    device_name: os.hostname(),
    workspace_id: settings.cloudSync?.workspaceId || null,
    user_id: settings.cloudSync?.userId || null,
    updated_at: db.fn.now(),
  });

  return deviceId;
};

export const getCloudSyncConfig = async (): Promise<CloudSyncConfig> => {
  const settings = getSettings();
  const apiBaseUrl = settings.cloudSync?.apiBaseUrl || '';
  const enabled = Boolean(settings.cloudSync?.enabled && apiBaseUrl);

  return {
    enabled,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    accessToken: settings.cloudSync?.accessToken,
    workspaceId: settings.cloudSync?.workspaceId,
    userId: settings.cloudSync?.userId,
    deviceId: await getOrCreateDeviceId(),
    deviceName: settings.cloudSync?.deviceName || os.hostname(),
  };
};
