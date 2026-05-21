import {ipcMain} from 'electron';
import {existsSync, readFileSync} from 'fs';
import {rm} from 'fs/promises';
import {txtToJSON} from '../utils/txt-to-json';
import * as XLSX from 'xlsx';
import type {IWindowTemplate} from '../types/window-template';
import type {DB, SafeAny} from '../../../shared/types/db';
import {WindowDB} from '../db/window';
import {closeFingerprintWindow, openFingerprintWindow} from '../fingerprint/index';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {randomASCII, randomFloat, randomInt} from '../../../shared/utils';
import path, {isAbsolute, relative, resolve as resolvePath} from 'path';
import puppeteer from 'puppeteer';
import {presetCookie} from '../puppeteer/helpers';
import {ExtensionDB} from '../db/extension';
import * as ExcelJS from 'exceljs';
import {getRuntimePlatformKey, listCloakBrowserRuntimes} from '../cloakbrowser/runtime-manager';
import {getSettings} from '../utils/get-settings';
import {randomUUID} from 'crypto';
import {getCloudSyncConfig} from '../cloud/config';
import {enqueueSyncOutbox} from '../cloud/sync-outbox';
import {flushSyncOutbox} from '../cloud/sync-engine';
import {GroupDB} from '../db/group';
import {ProxyDB} from '../db/proxy';
import {randomUniqueProfileId} from '../../../shared/utils/random';
const logger = createLogger(SERVICE_LOGGER_LABEL);

const flushWindowSyncSoon = () => {
  flushSyncOutbox().catch(() => {
    // The scheduled sync loop will retry.
  });
};

const isPathInside = (root: string, target: string) => {
  const relativePath = relative(root, target);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath);
};

const isPidAlive = (pid: number | null | undefined): boolean => {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // EPERM means process exists but current process has no permission
    if (code === 'EPERM') return true;
    return false;
  }
};

const clearWindowCache = async (ids: number[]) => {
  const settings = getSettings();
  const cachePath = resolvePath(settings.profileCachePath);
  const cacheDirNames = ['cloakbrowser', 'chrome', 'chromium'];
  const results = {
    cleared: [] as number[],
    skipped: [] as {id: number; reason: string}[],
    failed: [] as {id: number; reason: string}[],
  };

  for (const id of ids) {
    try {
      const windowData = await WindowDB.getById(id);

      if (!windowData) {
        results.skipped.push({id, reason: 'Window not found'});
        continue;
      }

      if (windowData.status && windowData.status > 1) {
        results.skipped.push({id, reason: 'Window is running'});
        continue;
      }

      if (!windowData.profile_id) {
        results.skipped.push({id, reason: 'Profile ID is empty'});
        continue;
      }

      for (const cacheDirName of cacheDirNames) {
        const cacheRoot = resolvePath(cachePath, cacheDirName);
        const targetPath = resolvePath(cacheRoot, windowData.profile_id);

        if (!isPathInside(cacheRoot, targetPath)) {
          results.failed.push({id, reason: 'Invalid cache path'});
          continue;
        }

        if (existsSync(targetPath)) {
          await rm(targetPath, {recursive: true, force: true});
        }
      }

      results.cleared.push(id);
    } catch (error) {
      logger.error(`Failed to clear window cache ${id}`, error);
      results.failed.push({id, reason: (error as Error)?.message || String(error)});
    }
  }

  return {
    success: results.failed.length === 0,
    message: `Cleared ${results.cleared.length} window cache(s).`,
    data: results,
  };
};

const withWindowRelationCloudIds = async (windowData?: DB.Window | null) => {
  if (!windowData) {
    return windowData;
  }

  let groupCloudId: string | null = null;
  let proxyCloudId: string | null = null;

  if (windowData.group_id) {
    const group = await GroupDB.getById(windowData.group_id);
    groupCloudId = group?.cloud_id || null;
  }
  if (windowData.proxy_id) {
    const proxy = await ProxyDB.getById(windowData.proxy_id);
    proxyCloudId = proxy?.cloud_id || null;
  }

  return {
    ...windowData,
    group_cloud_id: groupCloudId,
    proxy_cloud_id: proxyCloudId,
  };
};
export const initWindowService = () => {
  logger.info('init window service...');
  ipcMain.handle('window-import', async (_, filePath: string) => {
    let fileData: IWindowTemplate[] = [];
    if (filePath.endsWith('xlsx') || filePath.endsWith('xls')) {
      const workbook = XLSX.readFile(filePath);
      const sheet_name_list = workbook.SheetNames;
      fileData = XLSX.utils.sheet_to_json(workbook.Sheets[sheet_name_list[0]]);
    } else {
      const fileContent = readFileSync(filePath, 'utf-8');
      const data = txtToJSON(fileContent);
      fileData = data.filter(f => f.id);
    }
    fileData = fileData.map(row => withStableImportFingerprint(row));
    const result = await WindowDB.externalImport(fileData);
    const cloudConfig = await getCloudSyncConfig();
    if (cloudConfig.enabled && result.data?.length) {
      for (const id of result.data) {
        const importedWindow = await WindowDB.getById(id);
        if (!importedWindow) continue;
        const cloudId = importedWindow.cloud_id || randomUUID();
        await WindowDB.update(id, {
          ...importedWindow,
          cloud_id: cloudId,
          workspace_id: importedWindow.workspace_id || cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        });
        const latestWindow = await WindowDB.getById(id);
        const syncPayload = await withWindowRelationCloudIds(latestWindow || importedWindow);
        await enqueueSyncOutbox('window', 'create', {
          localId: id,
          cloudId,
          data: syncPayload,
        });
      }
    }
    return result;
  });

  ipcMain.handle('window-create', async (_, window: DB.Window, fingerprint: SafeAny) => {
    logger.info(
      'try to create window',
      JSON.stringify({
        ...window,
        cookie: window?.cookie ? `preset ${window.cookie.length} cookies` : [],
      }),
      JSON.stringify(fingerprint),
    );
    console.log(window);
    const cloudConfig = await getCloudSyncConfig();
    const windowPayload = cloudConfig.enabled
      ? {
          ...window,
          cloud_id: window.cloud_id || randomUUID(),
          workspace_id: window.workspace_id || cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : window;
    windowPayload.fingerprint = buildStableWindowFingerprint(windowPayload, fingerprint);
    const result = await WindowDB.create(windowPayload, fingerprint);
    if (result.success && result.data?.id) {
      const syncPayload = await withWindowRelationCloudIds(result.data);
      await enqueueSyncOutbox('window', 'create', {
        localId: result.data.id,
        cloudId: result.data.cloud_id,
        data: syncPayload,
      });
    }
    return result;
  });

  ipcMain.handle('window-update', async (_, id: number, window: DB.Window) => {
    const cloudConfig = await getCloudSyncConfig();
    const windowPayload = cloudConfig.enabled
      ? {
          ...window,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : window;
    const result = await WindowDB.update(id!, windowPayload);
    if (result.success) {
      const latestWindow = await WindowDB.getById(id);
      const syncPayload = await withWindowRelationCloudIds(latestWindow || windowPayload);
      await enqueueSyncOutbox('window', 'update', {
        localId: id,
        cloudId: windowPayload.cloud_id,
        data: syncPayload,
      });
    }
    return result;
  });

  ipcMain.handle('window-delete', async (_, id: number) => {
    const windowData = await WindowDB.getById(id);
    await ExtensionDB.deleteWindowReleted(id);
    const result = await WindowDB.remove(id);
    await enqueueSyncOutbox('window', 'delete', {
      localId: id,
      cloudId: windowData?.cloud_id,
      data: windowData,
    });
    flushWindowSyncSoon();
    return result;
  });
  ipcMain.handle('window-batchClear', async (_, ids: number[]) => {
    await ExtensionDB.deleteWindowReleted(ids);
    return await WindowDB.batchClear(ids);
  });
  ipcMain.handle('window-batchDelete', async (_, ids: number[]) => {
    const windows = await Promise.all(ids.map(id => WindowDB.getById(id)));
    await ExtensionDB.deleteWindowReleted(ids);
    const result = await WindowDB.batchRemove(ids);
    if (result.success) {
      for (const windowData of windows) {
        if (!windowData) continue;
        await enqueueSyncOutbox('window', 'delete', {
          localId: windowData.id,
          cloudId: windowData.cloud_id,
          data: windowData,
        });
      }
      flushWindowSyncSoon();
    }
    return result;
  });
  ipcMain.handle('window-clear-cache', async (_, ids: number[]) => {
    return await clearWindowCache(ids);
  });

  ipcMain.handle('window-getAll', async () => {
    const cloudConfig = await getCloudSyncConfig();
    return await WindowDB.all(cloudConfig.enabled ? cloudConfig.workspaceId : undefined);
  });

  ipcMain.handle('window-getOpened', async () => {
    const cloudConfig = await getCloudSyncConfig();
    const windows = await WindowDB.getOpenedWindows(cloudConfig.enabled ? cloudConfig.workspaceId : undefined);

    const aliveWindows: typeof windows = [];
    for (const win of windows) {
      if (isPidAlive(win.pid)) {
        aliveWindows.push(win);
        continue;
      }

      // Auto-heal stale running state if PID is no longer alive
      try {
        await WindowDB.update(win.id!, {
          ...win,
          status: 1,
          pid: null,
          port: null,
        });
        logger.warn(`Detected stale window runtime state. Auto-reset window ${win.id} (pid=${win.pid})`);
      } catch (error) {
        logger.error(`Failed to auto-reset stale window ${win.id} (pid=${win.pid})`, error);
      }
    }

    return aliveWindows;
  });

  ipcMain.handle('window-export', async () => {
    console.log('export windows');
    try {
      const windows = await WindowDB.all();
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Windows');
      worksheet.addRow(['ID', 'Profile ID', 'Group', 'Name', 'Remark', 'Proxy', 'Last Open', 'Created At']);
      windows.forEach(window => {
        worksheet.addRow([window.id, window.profile_id, window.group_name, window.name, window.remark, window.proxy, window.opened_at, window.created_at]);
      });
      workbook.xlsx.writeFile('windows.xlsx');
      return {
        success: true,
        message: 'Export windows successfully',
      };
    } catch (error) {
      logger.error('export windows error', error);
      return {
        success: false,
        message: 'Export windows failed',
      };
    }
  });

  ipcMain.handle('window-fingerprint', async (_, windowId: number) => {
    if (windowId) {
      const window = await WindowDB.getById(windowId);
      if (window) {
        return {
          ...JSON.parse(window.fingerprint),
        };
      }
    } else {
      return {};
    }
  });

  ipcMain.handle('window-getById', async (_, id: number) => {
    return await WindowDB.getById(id);
  });

  ipcMain.handle('window-cloakbrowser-runtimes', async () => {
    const platform = getRuntimePlatformKey();
    return {
      platform,
      runtimes: await listCloakBrowserRuntimes(platform),
    };
  });

  ipcMain.handle('window-open', async (_, id: number) => {
    return await openFingerprintWindow(id);
  });
  ipcMain.handle('window-close', async (_, id: number, force = false) => {
    return await closeFingerprintWindow(id, force);
  });

  ipcMain.handle('window-set-cookie', async (_, id: number) => {
    const window = await WindowDB.getById(id);
    await WindowDB.update(id, {
      ...window,
      status: 3,
    });
    const {webSocketDebuggerUrl} = await openFingerprintWindow(id, true);

    const browser = await puppeteer.connect({
      browserWSEndpoint: webSocketDebuggerUrl,
      defaultViewport: null,
    });
    await presetCookie(id, browser);
    await browser.close();
    return {
      success: true,
      message: 'Set cookie successfully.',
    };
  });
};

export const randomFingerprint = () => {
  const uaPath = path.join(
    import.meta.env.MODE === 'development' ? 'assets' : 'resources/app/assets',
    'ua.txt',
  );
  const uaFile = readFileSync(uaPath, 'utf-8');
  const uaList = uaFile.split('\n');
  const randomIndex = Math.floor(Math.random() * uaList.length);
  const ua = uaList[randomIndex];
  const result = {
    ua,
    pathStr: randomASCII(),
    webgl: randomFloat(),
    audio: randomInt(),
  };
  return result;
};

const buildStableWindowFingerprint = (windowData: DB.Window, fallbackFingerprint?: SafeAny) => {
  const fingerprint = {
    ...parseWindowFingerprint(fallbackFingerprint),
    ...parseWindowFingerprint(windowData.fingerprint),
  };

  if (!fingerprint.ua && !windowData.ua) {
    fingerprint.ua = randomFingerprint().ua;
  }
  if (!fingerprint.ua && windowData.ua) {
    fingerprint.ua = windowData.ua;
  }
  if (!fingerprint.platform) {
    fingerprint.platform = getCurrentFingerprintPlatform();
  }
  if (!fingerprint.fingerprintSeed && windowData.profile_id) {
    fingerprint.fingerprintSeed = stableFingerprintSeed(windowData.profile_id);
  }

  return fingerprint;
};

const parseWindowFingerprint = (fingerprint?: SafeAny) => {
  if (!fingerprint || fingerprint === '{}') {
    return {};
  }
  if (typeof fingerprint !== 'string') {
    return fingerprint;
  }
  try {
    return JSON.parse(fingerprint);
  } catch {
    return {};
  }
};

const getCurrentFingerprintPlatform = () => {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
};

const stableFingerprintSeed = (profileId: string) => {
  let hash = 0;
  for (let index = 0; index < profileId.length; index++) {
    hash = (hash * 31 + profileId.charCodeAt(index)) >>> 0;
  }
  return String(10000 + (hash % 90000));
};

const withStableImportFingerprint = (row: IWindowTemplate) => {
  const nextRow = {...row} as IWindowTemplate & Record<string, unknown>;
  const profileId = String(
    nextRow.id || nextRow.profile_id || nextRow.profileId || nextRow['Profile ID'] || randomUniqueProfileId(),
  );
  const existingUa = nextRow.ua || nextRow.user_agent || nextRow['User Agent'] || nextRow.UA;
  const existingSeed =
    nextRow.fingerprint_seed || nextRow.fingerprintSeed || nextRow.seed || nextRow.Seed || nextRow['指纹种子'];
  const existingPlatform = nextRow.platform || nextRow.Platform || nextRow['指纹平台'];

  nextRow.id = profileId;
  if (!existingUa) {
    nextRow.ua = randomFingerprint().ua;
  }
  if (!existingSeed) {
    nextRow.fingerprint_seed = stableFingerprintSeed(profileId);
  }
  if (!existingPlatform) {
    nextRow.platform = getCurrentFingerprintPlatform();
  }

  return nextRow;
};
