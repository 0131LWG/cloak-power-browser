import {CommonBridge, SyncBridge} from '#preload';
import type {SettingOptions} from '../../../shared/types/common';

export type CloudTeam = {
  id: string;
  name: string;
  role?: string;
  invite_code?: string;
};

export type JoinRequest = {
  id: string;
  team_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  message?: string;
  created_at?: string;
  user?: {
    id: string;
    email: string;
    name: string;
  };
  team?: CloudTeam;
};

export const getSavedSettings = async () => {
  return (await CommonBridge.getSettings()) as SettingOptions;
};

export const saveCloudSession = async (
  settings: SettingOptions,
  cloudSync: NonNullable<SettingOptions['cloudSync']>,
) => {
  const nextSettings: SettingOptions = {
    ...settings,
    cloudSync: {
      ...(settings.cloudSync || {}),
      ...cloudSync,
      enabled: true,
    },
  };
  await CommonBridge.saveSettings(nextSettings);
  await SyncBridge.refreshCloudSyncConfig();
  return nextSettings;
};

export const clearCloudSession = async () => {
  const settings = await getSavedSettings();
  const nextSettings: SettingOptions = {
    ...settings,
    cloudSync: {
      ...(settings.cloudSync || {}),
      enabled: false,
      accessToken: '',
      workspaceId: '',
      userId: '',
    },
  };
  await CommonBridge.saveSettings(nextSettings);
  await SyncBridge.refreshCloudSyncConfig();
  return nextSettings;
};

export const normalizeApiBaseUrl = (apiBaseUrl?: string) => (apiBaseUrl || '').replace(/\/+$/, '');

export const fetchCloudJson = async <T>(
  apiBaseUrl: string,
  path: string,
  options: RequestInit = {},
) => {
  const response = await fetch(`${normalizeApiBaseUrl(apiBaseUrl)}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const result = (await response.json()) as T & {success?: boolean; message?: string};
  if (!response.ok || result.success === false) {
    throw new Error(result.message || 'Cloud request failed');
  }
  return result;
};

export const fetchTeams = async (apiBaseUrl: string, accessToken: string) => {
  const result = await fetchCloudJson<{success: boolean; data: CloudTeam[]}>(apiBaseUrl, '/teams', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return result.data || [];
};
