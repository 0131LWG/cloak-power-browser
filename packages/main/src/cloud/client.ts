import axios, {type AxiosInstance} from 'axios';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {getCloudSyncConfig} from './config';
import type {CloudSyncConfig} from './types';

const logger = createLogger(SERVICE_LOGGER_LABEL);

export class CloudApiClient {
  private config?: CloudSyncConfig;
  private http?: AxiosInstance;

  async getConfig() {
    if (!this.config) {
      this.config = await getCloudSyncConfig();
    }
    return this.config;
  }

  async isEnabled() {
    const config = await this.getConfig();
    return config.enabled;
  }

  async request<T>(method: 'get' | 'post' | 'delete' | 'patch', path: string, data?: unknown) {
    const http = await this.getHttp();
    if (!http) {
      return undefined;
    }

    try {
      const response = await http.request<T>({method, url: path, data});
      return response.data;
    } catch (error) {
      logger.error(`Cloud request failed: ${method.toUpperCase()} ${path}`, error);
      throw error;
    }
  }

  async refreshConfig() {
    this.config = await getCloudSyncConfig();
    this.http = undefined;
    return this.config;
  }

  private async getHttp() {
    const config = await this.getConfig();
    if (!config.enabled) {
      return undefined;
    }

    if (!this.http) {
      this.http = axios.create({
        baseURL: config.apiBaseUrl,
        timeout: 15000,
        headers: {
          ...(config.accessToken ? {Authorization: `Bearer ${config.accessToken}`} : {}),
          'x-workspace-id': config.workspaceId || '',
          'x-device-id': config.deviceId,
          'x-device-name': config.deviceName,
        },
      });
    }

    return this.http;
  }
}

export const cloudApiClient = new CloudApiClient();
