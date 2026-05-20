export interface CloudSyncConfig {
  enabled: boolean;
  apiBaseUrl: string;
  accessToken?: string;
  workspaceId?: string;
  userId?: string;
  deviceId: string;
  deviceName: string;
}

export interface ProfileLockOwner {
  user_id?: string;
  user_name?: string;
  device_id?: string;
  device_name?: string;
  locked_at?: string;
  heartbeat_at?: string;
}

export interface ProfileLockResult {
  success: boolean;
  lock_id?: string;
  reason?: 'disabled' | 'locked' | 'network_error' | 'missing_cloud_id' | 'unknown';
  message?: string;
  locked_by?: ProfileLockOwner;
}

export interface RuntimeCapabilityManifestEntry {
  version?: string;
  tag?: string;
  asset?: string;
  sha256?: string;
  executable?: string;
  capabilities?: string[];
}

export interface CloudRuntimeManifest {
  coreFamilies?: Record<
    string,
    Record<string, Record<string, RuntimeCapabilityManifestEntry | RuntimeCapabilityManifestEntry[]>>
  >;
}
