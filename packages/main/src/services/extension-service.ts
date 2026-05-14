import {ipcMain} from 'electron';
import axios from 'axios';
import extract from 'extract-zip';
import {existsSync} from 'fs';
import {cp, mkdir, readFile, readdir, rm, writeFile} from 'fs/promises';
import {extname, join} from 'path';
import type {DB} from '../../../shared/types/db';
import {ExtensionDB} from '../db/extension';
import {db} from '../db';
import {getSettings} from '../utils/get-settings';

type ExtensionManifest = {
  name?: string;
  description?: string;
  version?: string;
  default_locale?: string;
  icons?: Record<string, string>;
};

type PersistOptions = {
  chromeExtensionId?: string;
  defaultDistributionMode?: 'global' | 'manual';
  existingExtension?: DB.Extension;
  manifestDir: string;
  sourceType: 'chrome_web_store' | 'custom';
  sourceUrl?: string;
};

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CHROME_PROD_VERSION = '131.0.6778.265';

const getProxyEnv = () =>
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  '';

const isLocalProxy = (proxyValue: string) => {
  return /:\/\/(127\.0\.0\.1|localhost):\d+/i.test(proxyValue) || /(127\.0\.0\.1|localhost):\d+/i.test(proxyValue);
};

const isProxyConnectionRefused = (error: unknown) => {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const proxyEnv = getProxyEnv();
  return (
    error.code === 'ECONNREFUSED' &&
    isLocalProxy(proxyEnv) &&
    error.message.includes('ECONNREFUSED')
  );
};

const normalizeDownloadError = (error: unknown, directRetried = false) => {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error : new Error('扩展下载失败');
  }

  const proxyEnv = getProxyEnv();
  if (isProxyConnectionRefused(error)) {
    return new Error(
      directRetried
        ? `检测到本机代理 ${proxyEnv} 不可用，且直连 Chrome 应用商店也失败了，请先启动代理后重试。`
        : `检测到本机代理 ${proxyEnv} 不可用，请先启动代理后重试，或清理系统 HTTP_PROXY/HTTPS_PROXY 配置。`,
    );
  }

  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    return new Error('下载 Chrome 扩展超时，请检查网络或代理后重试');
  }

  if (error.response?.status === 404) {
    return new Error('未找到该扩展，请确认 Chrome 扩展地址是否正确');
  }

  if (error.response?.status === 403) {
    return new Error('Chrome 应用商店拒绝了下载请求，请稍后重试');
  }

  return new Error(error.message || '扩展下载失败');
};

const downloadChromeExtensionPackage = async (chromeExtensionId: string) => {
  const requestConfig = {
    responseType: 'arraybuffer' as const,
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  };

  try {
    return await axios.get<ArrayBuffer>(getChromeDownloadUrl(chromeExtensionId), requestConfig);
  } catch (error) {
    if (!isProxyConnectionRefused(error)) {
      throw normalizeDownloadError(error);
    }

    try {
      return await axios.get<ArrayBuffer>(getChromeDownloadUrl(chromeExtensionId), {
        ...requestConfig,
        proxy: false,
      });
    } catch (directError) {
      throw normalizeDownloadError(directError, true);
    }
  }
};

const getManagedExtensionsRoot = async () => {
  const settings = getSettings();
  const extensionsPath = join(settings.profileCachePath, 'extensions');
  await mkdir(extensionsPath, {recursive: true});
  return extensionsPath;
};

const getManagedExtensionPath = async (extensionId: number) => {
  const extensionsPath = await getManagedExtensionsRoot();
  const extensionDir = join(extensionsPath, extensionId.toString());
  await mkdir(extensionDir, {recursive: true});
  return extensionDir;
};

const extractChromeExtensionId = (source: string) => {
  const match = source.trim().match(/([a-p]{32})/i);
  return match?.[1]?.toLowerCase() ?? '';
};

const getChromeDownloadUrl = (chromeExtensionId: string) => {
  const query = encodeURIComponent(`id=${chromeExtensionId}&installsource=ondemand&uc`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CHROME_PROD_VERSION}&acceptformat=crx3&x=${query}`;
};

const extractCrxArchive = async (archiveBuffer: Buffer, tempDir: string) => {
  const zipStartIndex = archiveBuffer.indexOf(ZIP_SIGNATURE);
  if (zipStartIndex < 0) {
    throw new Error('未能解析扩展安装包，请确认输入的是有效的 Chrome 扩展地址');
  }

  const zipPath = join(tempDir, 'extension.zip');
  await writeFile(zipPath, archiveBuffer.subarray(zipStartIndex));
  await extract(zipPath, {dir: tempDir});
  await rm(zipPath, {force: true});
};

const findManifestDirectory = async (rootDir: string) => {
  const manifestPath = join(rootDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    return rootDir;
  }

  const entries = await readdir(rootDir, {withFileTypes: true});
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedDir = join(rootDir, entry.name);
    if (existsSync(join(nestedDir, 'manifest.json'))) {
      return nestedDir;
    }
  }

  throw new Error('扩展目录中未找到 manifest.json');
};

const readManifest = async (manifestDir: string) => {
  const manifestContent = await readFile(join(manifestDir, 'manifest.json'), 'utf8');
  return JSON.parse(manifestContent) as ExtensionManifest;
};

const readLocaleMessages = async (manifestDir: string, locale: string) => {
  try {
    const localeFile = join(manifestDir, '_locales', locale, 'messages.json');
    const content = await readFile(localeFile, 'utf8');
    return JSON.parse(content) as Record<string, {message?: string}>;
  } catch {
    return undefined;
  }
};

const resolveManifestText = async (
  rawText: string | undefined,
  manifestDir: string,
  defaultLocale?: string,
) => {
  if (!rawText) {
    return '';
  }

  const matched = rawText.match(/^__MSG_(.+)__$/);
  if (!matched) {
    return rawText;
  }

  const localeCandidates = new Set<string>();
  if (defaultLocale) {
    localeCandidates.add(defaultLocale);
  }

  try {
    const localeDirs = await readdir(join(manifestDir, '_locales'));
    localeDirs.forEach(locale => localeCandidates.add(locale));
  } catch {
    return rawText;
  }

  for (const locale of localeCandidates) {
    const messages = await readLocaleMessages(manifestDir, locale);
    const message = messages?.[matched[1]]?.message;
    if (message) {
      return message;
    }
  }

  return rawText;
};

const getMimeType = (filePath: string) => {
  const extension = extname(filePath).toLowerCase();
  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.png':
    default:
      return 'image/png';
  }
};

const readExtensionIcon = async (manifestDir: string, manifest: ExtensionManifest) => {
  const iconEntries = Object.entries(manifest.icons ?? {}).sort(
    ([sizeA], [sizeB]) => Number(sizeB) - Number(sizeA),
  );

  for (const [, relativePath] of iconEntries) {
    const iconPath = join(manifestDir, relativePath);
    if (!existsSync(iconPath)) {
      continue;
    }

    const iconBuffer = await readFile(iconPath);
    return `data:${getMimeType(iconPath)};base64,${iconBuffer.toString('base64')}`;
  }

  return undefined;
};

const copyDirectoryContents = async (sourceDir: string, targetDir: string) => {
  const entries = await readdir(sourceDir, {withFileTypes: true});

  for (const entry of entries) {
    await cp(join(sourceDir, entry.name), join(targetDir, entry.name), {
      recursive: true,
      force: true,
    });
  }
};

const persistInstalledExtension = async ({
  manifestDir,
  sourceType,
  sourceUrl,
  chromeExtensionId,
  existingExtension,
  defaultDistributionMode = 'global',
}: PersistOptions) => {
  const manifest = await readManifest(manifestDir);
  const name = await resolveManifestText(manifest.name, manifestDir, manifest.default_locale);
  const description = await resolveManifestText(
    manifest.description,
    manifestDir,
    manifest.default_locale,
  );
  const version = manifest.version || `${Date.now()}`;

  const extensionId = existingExtension?.id ?? Date.now();
  const managedExtensionDir = await getManagedExtensionPath(extensionId);
  const versionDir = join(managedExtensionDir, version);

  await rm(versionDir, {recursive: true, force: true});
  await mkdir(versionDir, {recursive: true});
  await copyDirectoryContents(manifestDir, versionDir);

  const payload: DB.Extension = {
    ...(existingExtension ?? {}),
    name: name || existingExtension?.name || `扩展 ${extensionId}`,
    version,
    path: versionDir,
    description: description || existingExtension?.description,
    icon: (await readExtensionIcon(manifestDir, manifest)) ?? existingExtension?.icon,
    source_type: sourceType,
    source_url: sourceUrl,
    chrome_extension_id: chromeExtensionId ?? existingExtension?.chrome_extension_id,
    distribution_mode:
      (existingExtension?.distribution_mode as 'global' | 'manual' | undefined) ??
      defaultDistributionMode,
    auto_update:
      typeof existingExtension?.auto_update === 'boolean'
        ? existingExtension.auto_update
        : existingExtension?.auto_update === 0
          ? false
          : true,
    updated_at: db.fn.now() as unknown as string,
  };

  if (existingExtension?.id) {
    await ExtensionDB.updateExtension(existingExtension.id, payload);
  } else {
    await ExtensionDB.createExtension({
      ...payload,
      created_at: db.fn.now() as unknown as string,
    });
  }

  return {
    success: true,
    extensionId,
    extension: await ExtensionDB.getExtensionById(extensionId),
  };
};

const installFromZipPackage = async (filePath: string, existingExtensionId?: number) => {
  const existingExtension = existingExtensionId
    ? await ExtensionDB.getExtensionById(existingExtensionId)
    : undefined;
  const extensionsPath = await getManagedExtensionsRoot();
  const tempExtractDir = join(extensionsPath, `temp-zip-${Date.now()}`);

  await rm(tempExtractDir, {recursive: true, force: true});
  await mkdir(tempExtractDir, {recursive: true});

  try {
    await extract(filePath, {dir: tempExtractDir});
    const manifestDir = await findManifestDirectory(tempExtractDir);

    return await persistInstalledExtension({
      manifestDir,
      sourceType:
        (existingExtension?.source_type as 'chrome_web_store' | 'custom' | undefined) ?? 'custom',
      sourceUrl: existingExtension?.source_url,
      chromeExtensionId: existingExtension?.chrome_extension_id,
      existingExtension,
    });
  } finally {
    await rm(tempExtractDir, {recursive: true, force: true});
  }
};

const installFromWebStore = async (sourceUrl: string) => {
  const chromeExtensionId = extractChromeExtensionId(sourceUrl);
  if (!chromeExtensionId) {
    throw new Error('请输入有效的 Chrome 扩展详情地址');
  }

  const existingExtension = await ExtensionDB.getExtensionByChromeId(chromeExtensionId);
  const extensionsPath = await getManagedExtensionsRoot();
  const tempExtractDir = join(extensionsPath, `temp-store-${chromeExtensionId}-${Date.now()}`);

  await rm(tempExtractDir, {recursive: true, force: true});
  await mkdir(tempExtractDir, {recursive: true});

  try {
    const response = await downloadChromeExtensionPackage(chromeExtensionId);
    await extractCrxArchive(Buffer.from(response.data), tempExtractDir);
    const manifestDir = await findManifestDirectory(tempExtractDir);

    return await persistInstalledExtension({
      manifestDir,
      sourceType: 'chrome_web_store',
      sourceUrl,
      chromeExtensionId,
      existingExtension,
    });
  } finally {
    await rm(tempExtractDir, {recursive: true, force: true});
  }
};

const installFromDirectory = async (directoryPath: string) => {
  const manifestDir = await findManifestDirectory(directoryPath);
  return await persistInstalledExtension({
    manifestDir,
    sourceType: 'custom',
    sourceUrl: directoryPath,
  });
};

const deleteManagedExtensionFiles = async (extensionId: number) => {
  const extensionsPath = await getManagedExtensionsRoot();
  await rm(join(extensionsPath, extensionId.toString()), {recursive: true, force: true});
};

export const initExtensionService = () => {
  ipcMain.handle('extension-create', async (_, extension: DB.Extension) => {
    return await ExtensionDB.createExtension({
      ...extension,
      distribution_mode: extension.distribution_mode ?? 'global',
      auto_update:
        typeof extension.auto_update === 'boolean' ? extension.auto_update : extension.auto_update !== 0,
      updated_at: db.fn.now() as unknown as string,
    });
  });

  ipcMain.handle('extension-get-all', async () => {
    return await ExtensionDB.getAllExtensions();
  });

  ipcMain.handle('extension-install-from-web-store', async (_, sourceUrl: string) => {
    try {
      return await installFromWebStore(sourceUrl);
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  ipcMain.handle('extension-install-from-directory', async (_, directoryPath: string) => {
    try {
      return await installFromDirectory(directoryPath);
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  ipcMain.handle(
    'extension-apply-to-windows',
    async (_, extensionId: number, windowIds: number[]) => {
      return await ExtensionDB.insertExtensionWindows(extensionId, windowIds);
    },
  );

  ipcMain.handle('extension-get-windows', async (_, extensionId: number) => {
    return await ExtensionDB.getExtensionWindows(extensionId);
  });

  ipcMain.handle(
    'delete-extension-windows',
    async (_, extensionId: number, windowIds: number[]) => {
      return await ExtensionDB.deleteExtensionWindows(extensionId, windowIds);
    },
  );

  ipcMain.handle('extension-delete', async (_, extensionId: number) => {
    try {
      await ExtensionDB.deleteExtension(extensionId);
      await deleteManagedExtensionFiles(extensionId);
      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
      };
    }
  });

  ipcMain.handle(
    'extension-update',
    async (_, extensionId: number, extension: Partial<DB.Extension>) => {
      return await ExtensionDB.updateExtension(extensionId, {
        ...extension,
        updated_at: db.fn.now() as unknown as string,
      });
    },
  );

  ipcMain.handle(
    'extension-upload-package',
    async (_, filePath: string, existingExtensionId?: number) => {
      try {
        return await installFromZipPackage(filePath, existingExtensionId);
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
  );

  ipcMain.handle('extension-sync-windows', async (_, extensionId: number, windowIds: number[]) => {
    try {
      const currentWindows = await ExtensionDB.getExtensionWindows(extensionId);
      const currentWindowIds = currentWindows.map(w => w.window_id).filter(Boolean) as number[];

      const toDelete = currentWindowIds.filter(id => !windowIds.includes(id));
      if (toDelete.length > 0) {
        await ExtensionDB.deleteExtensionWindows(extensionId, toDelete);
      }

      const toAdd = windowIds.filter(id => !currentWindowIds.includes(id));
      if (toAdd.length > 0) {
        await ExtensionDB.insertExtensionWindows(extensionId, toAdd);
      }

      return {
        success: true,
        message: '同步成功',
      };
    } catch {
      return {
        success: false,
        message: '同步失败',
      };
    }
  });
};
