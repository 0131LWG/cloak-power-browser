import {existsSync} from 'fs';
import {mkdir, readdir, readFile, stat, writeFile} from 'fs/promises';
import {join, relative, resolve, sep} from 'path';
import puppeteer from 'puppeteer';
import type {DB, SafeAny} from '../../../shared/types/db';
import {createLogger} from '../../../shared/utils/logger';
import api from '../../../shared/api/api';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {getSettings} from '../utils/get-settings';
import {shouldUseCloakBrowser} from '../cloakbrowser/launcher';
import {cloudApiClient} from './client';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const HOST = '127.0.0.1';
const COOKIE_SYNC_INTERVAL_MS = 15000;
const MAX_PROFILE_FILE_BYTES = 20 * 1024 * 1024;

type ProfileDataPayload = {
  success?: boolean;
  revision?: number;
  files?: Record<string, string>;
  cookies?: SafeAny[];
};

const cookieSyncTimers = new Map<number, NodeJS.Timeout>();
const latestCookieSnapshots = new Map<number, SafeAny[]>();

const snapshotRoots = [
  'Local State',
  join('Default', 'History'),
  join('Default', 'Favicons'),
  join('Default', 'Top Sites'),
  join('Default', 'Visited Links'),
  join('Default', 'Bookmarks'),
  join('Default', 'Preferences'),
  join('Default', 'Local Storage'),
  join('Default', 'Session Storage'),
  join('Default', 'IndexedDB'),
  join('Default', 'Extension State'),
  join('Default', 'Local Extension Settings'),
  join('Default', 'Sync Extension Settings'),
];

const ignoredPathParts = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'ShaderCache',
  'GrShaderCache',
  'Crashpad',
  'Safe Browsing',
]);

const ignoredFileNames = new Set([
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'DevToolsActivePort',
  'Cookies',
  'Cookies-journal',
  'Network Persistent State',
]);

export const getProfileDataDir = (windowData: DB.Window) => {
  const settings = getSettings();
  const profileDirName = shouldUseCloakBrowser(settings, windowData)
    ? 'cloakbrowser'
    : settings.useLocalChrome
    ? 'chrome'
    : 'chromium';

  return join(settings.profileCachePath, profileDirName, windowData.profile_id || String(windowData.id));
};

export const downloadCloudProfileData = async (windowData: DB.Window, profileDir = getProfileDataDir(windowData)) => {
  if (!windowData.cloud_id || !(await cloudApiClient.isEnabled())) {
    return undefined;
  }

  const result = await cloudApiClient.request<ProfileDataPayload>('get', `/profiles/${windowData.cloud_id}/data`);
  if (!result?.success) {
    return undefined;
  }

  await restoreProfileFiles(profileDir, result.files || {});
  logger.info('Cloud profile data downloaded', {
    localWindowId: windowData.id,
    cloudId: windowData.cloud_id,
    fileCount: Object.keys(result.files || {}).length,
    cookieCount: result.cookies?.length || 0,
    revision: result.revision,
  });

  return result;
};

export const uploadCloudProfileData = async (windowData: DB.Window, profileDir = getProfileDataDir(windowData)) => {
  if (!windowData.cloud_id || !(await cloudApiClient.isEnabled()) || !existsSync(profileDir)) {
    return;
  }

  const files = await collectProfileFiles(profileDir);
  const cookies = latestCookieSnapshots.get(windowData.id!) || [];
  await cloudApiClient.request('post', `/profiles/${windowData.cloud_id}/data`, {
    profile_id: windowData.profile_id,
    browser_engine: windowData.browser_engine,
    browser_runtime_platform: windowData.browser_runtime_platform,
    browser_version: windowData.browser_version,
    files,
    cookies,
  });

  logger.info('Cloud profile data uploaded', {
    localWindowId: windowData.id,
    cloudId: windowData.cloud_id,
    fileCount: Object.keys(files).length,
    cookieCount: cookies.length,
  });
};

export const startCloudCookieSync = (windowData: DB.Window, port: number) => {
  stopCloudCookieSync(windowData.id!);

  const captureAndUpload = async () => {
    try {
      const cookies = await exportCookiesFromBrowser(port);
      latestCookieSnapshots.set(windowData.id!, cookies);
      if (windowData.cloud_id && (await cloudApiClient.isEnabled())) {
        await cloudApiClient.request('post', `/profiles/${windowData.cloud_id}/data`, {
          profile_id: windowData.profile_id,
          cookies,
        });
      }
    } catch (error) {
      logger.warn('Cloud cookie sync failed', {
        localWindowId: windowData.id,
        cloudId: windowData.cloud_id,
        message: (error as Error).message,
      });
    }
  };

  captureAndUpload();
  cookieSyncTimers.set(windowData.id!, setInterval(captureAndUpload, COOKIE_SYNC_INTERVAL_MS));
};

export const stopCloudCookieSync = (localWindowId: number) => {
  const timer = cookieSyncTimers.get(localWindowId);
  if (timer) {
    clearInterval(timer);
    cookieSyncTimers.delete(localWindowId);
  }
};

export const captureCloudCookiesOnce = async (windowData: DB.Window, port?: number | null) => {
  if (!port) return;
  try {
    const cookies = await exportCookiesFromBrowser(port);
    latestCookieSnapshots.set(windowData.id!, cookies);
  } catch (error) {
    logger.warn('Cloud cookie capture failed', {
      localWindowId: windowData.id,
      cloudId: windowData.cloud_id,
      message: (error as Error).message,
    });
  }
};

export const importCloudCookies = async (port: number, cookies?: SafeAny[]) => {
  if (!cookies?.length) return;

  const browser = await connectBrowser(port);
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    const client = await page.target().createCDPSession();
    await client.send('Network.setCookies', {
      cookies: cookies.map(normalizeCookieForImport).filter(Boolean),
    });
    logger.info('Cloud cookies imported', {port, cookieCount: cookies.length});
  } finally {
    browser.disconnect();
  }
};

const connectBrowser = async (port: number) => {
  const {data} = await api.get(`http://${HOST}:${port}/json/version`);
  return await puppeteer.connect({
    browserWSEndpoint: data.webSocketDebuggerUrl,
    defaultViewport: null,
  });
};

const exportCookiesFromBrowser = async (port: number) => {
  const browser = await connectBrowser(port);
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    const client = await page.target().createCDPSession();
    const result = await client.send('Network.getAllCookies');
    return (result.cookies || []) as SafeAny[];
  } finally {
    browser.disconnect();
  }
};

const normalizeCookieForImport = (cookie: SafeAny) => {
  if (!cookie?.name || typeof cookie.value !== 'string') {
    return undefined;
  }

  const normalized: SafeAny = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
  };

  if (typeof cookie.expires === 'number' && cookie.expires > 0) {
    normalized.expires = cookie.expires;
  }
  if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
    normalized.sameSite = cookie.sameSite;
  }
  if (cookie.priority) {
    normalized.priority = cookie.priority;
  }
  if (cookie.sourceScheme) {
    normalized.sourceScheme = cookie.sourceScheme;
  }

  return normalized;
};

const collectProfileFiles = async (profileDir: string) => {
  const files: Record<string, string> = {};

  for (const root of snapshotRoots) {
    const absolutePath = join(profileDir, root);
    if (!existsSync(absolutePath)) continue;
    await collectPath(profileDir, absolutePath, files);
  }

  return files;
};

const collectPath = async (profileDir: string, absolutePath: string, files: Record<string, string>) => {
  const pathStat = await stat(absolutePath);
  const relativePath = normalizeRelativePath(relative(profileDir, absolutePath));
  if (!relativePath || shouldIgnoreRelativePath(relativePath)) return;

  if (pathStat.isDirectory()) {
    const entries = await readdir(absolutePath);
    for (const entry of entries) {
      await collectPath(profileDir, join(absolutePath, entry), files);
    }
    return;
  }

  if (!pathStat.isFile() || pathStat.size > MAX_PROFILE_FILE_BYTES) {
    return;
  }

  const buffer = await readFile(absolutePath);
  files[relativePath] = buffer.toString('base64');
};

const restoreProfileFiles = async (profileDir: string, files: Record<string, string>) => {
  await mkdir(profileDir, {recursive: true});

  for (const [relativePath, content] of Object.entries(files)) {
    const safeRelativePath = normalizeRelativePath(relativePath);
    if (!safeRelativePath || shouldIgnoreRelativePath(safeRelativePath)) continue;

    const targetPath = resolve(profileDir, safeRelativePath);
    if (!isPathInside(profileDir, targetPath)) continue;

    await mkdir(join(targetPath, '..'), {recursive: true});
    await writeFile(targetPath, Buffer.from(content, 'base64'));
  }
};

const normalizeRelativePath = (pathValue: string) => pathValue.split(/[\\/]+/).filter(Boolean).join(sep);

const shouldIgnoreRelativePath = (relativePath: string) => {
  const parts = relativePath.split(/[\\/]+/);
  return parts.some(part => ignoredPathParts.has(part)) || ignoredFileNames.has(parts[parts.length - 1]);
};

const isPathInside = (root: string, target: string) => {
  const relativePath = relative(resolve(root), resolve(target));
  return Boolean(relativePath) && !relativePath.startsWith('..') && !relativePath.startsWith(sep);
};
