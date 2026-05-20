import {createHash} from 'crypto';
import {createReadStream, createWriteStream, existsSync, mkdirSync, rmSync} from 'fs';
import {cp, readFile, readdir, stat} from 'fs/promises';
import {execFileSync} from 'child_process';
import {app} from 'electron';
import extract from 'extract-zip';
import https from 'https';
import path from 'path';
import {createLogger} from '../../../shared/utils/logger';
import {WINDOW_LOGGER_LABEL} from '../constants';
import type {DB} from '../../../shared/types/db';

const logger = createLogger(WINDOW_LOGGER_LABEL);

export interface CloakBrowserRuntime {
  tag: string;
  asset: string;
  sha256: string;
  executable: string;
  coreFamily?: string;
  channel?: string;
  capabilities?: string[];
  recommended?: boolean;
  notes?: string;
}

export interface CloakBrowserRuntimeOption extends CloakBrowserRuntime {
  platform: string;
  downloaded: boolean;
  executablePath: string;
  downloadUrl: string;
}

interface RuntimeManifest {
  source: string;
  platforms: Record<string, CloakBrowserRuntime[] | CloakBrowserRuntime>;
}

export const getRuntimePlatformKey = () => {
  return `${process.platform}-${process.arch}`;
};

export const listCloakBrowserRuntimes = async (platform = getRuntimePlatformKey()) => {
  const manifest = await readRuntimeManifest();
  const runtimes = normalizeRuntimeList(manifest.platforms[platform]);

  return runtimes.map(runtime => toRuntimeOption(manifest, platform, runtime));
};

export const getRecommendedCloakBrowserRuntime = async (platform = getRuntimePlatformKey()) => {
  const runtimes = await listCloakBrowserRuntimes(platform);
  return runtimes.find(runtime => runtime.recommended) || runtimes[0];
};

export const ensureCloakBrowserRuntime = async (versionTag?: string) => {
  const platform = getRuntimePlatformKey();
  const runtimes = await listCloakBrowserRuntimes(platform);
  const runtime =
    runtimes.find(item => item.tag === versionTag) ||
    runtimes.find(item => item.recommended) ||
    runtimes[0];

  if (!runtime) {
    throw new Error(`No CloakBrowser runtime configured for ${platform}`);
  }

  if (runtime.downloaded && existsSync(runtime.executablePath)) {
    return runtime;
  }

  await downloadAndPrepareRuntime(runtime);
  return {
    ...runtime,
    downloaded: existsSync(runtime.executablePath),
  };
};

export const ensureCloakBrowserRuntimeForWindow = async (windowData: DB.Window) => {
  const platform = getRuntimePlatformKey();
  const runtimes = await listCloakBrowserRuntimes(platform);
  const overrides = parseRuntimeOverrides(windowData.browser_runtime_overrides);
  const overrideTag = overrides[platform] || overrides[platform.replace('-', '_')];
  const requiredCapabilities = getRequiredRuntimeCapabilities(windowData);

  const runtime =
    (overrideTag
      ? findCompatibleRuntime(runtimes, {
          tag: overrideTag,
          channel: windowData.browser_channel,
          requiredCapabilities,
        })
      : undefined) ||
    (windowData.browser_core_family
      ? findCompatibleRuntime(runtimes, {
          coreFamily: windowData.browser_core_family,
          channel: windowData.browser_channel,
          requiredCapabilities,
        })
      : undefined) ||
    findCompatibleRuntime(runtimes, {
      tag: windowData.browser_version,
      channel: windowData.browser_channel,
      requiredCapabilities,
    }) ||
    findCompatibleRuntime(runtimes, {
      channel: windowData.browser_channel,
      requiredCapabilities,
    });

  if (!runtime) {
    throw new Error(
      `No compatible CloakBrowser runtime configured for ${platform}. core=${windowData.browser_core_family || 'any'}`,
    );
  }

  if (runtime.downloaded && existsSync(runtime.executablePath)) {
    return runtime;
  }

  await downloadAndPrepareRuntime(runtime);
  return {
    ...runtime,
    downloaded: existsSync(runtime.executablePath),
  };
};

const downloadAndPrepareRuntime = async (runtime: CloakBrowserRuntimeOption) => {
  logger.info(`Downloading CloakBrowser ${runtime.platform} ${runtime.tag} from ${runtime.downloadUrl}`);

  const downloadsDir = path.join(app.getPath('userData'), 'runtime-downloads', 'cloakbrowser');
  const archivePath = path.join(downloadsDir, runtime.platform, runtime.tag, runtime.asset);
  const extractDir = path.join(downloadsDir, runtime.platform, runtime.tag, 'extract');
  const runtimeDir = getRuntimeDir(runtime.platform, runtime.tag);

  mkdirSync(path.dirname(archivePath), {recursive: true});
  rmSync(extractDir, {recursive: true, force: true});
  rmSync(runtimeDir, {recursive: true, force: true});
  mkdirSync(extractDir, {recursive: true});
  mkdirSync(runtimeDir, {recursive: true});

  await downloadFile(runtime.downloadUrl, archivePath);

  const checksum = await sha256File(archivePath);
  if (checksum !== runtime.sha256) {
    rmSync(archivePath, {force: true});
    throw new Error(
      `CloakBrowser checksum mismatch for ${runtime.asset}. expected=${runtime.sha256} actual=${checksum}`,
    );
  }

  if (runtime.asset.endsWith('.zip')) {
    await extract(archivePath, {dir: extractDir});
  } else if (runtime.asset.endsWith('.tar.gz') || runtime.asset.endsWith('.tgz')) {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], {stdio: 'ignore'});
  } else {
    throw new Error(`Unsupported CloakBrowser archive: ${runtime.asset}`);
  }

  const runtimeRoot = await findRuntimeRoot(extractDir, runtime.executable);
  if (!runtimeRoot) {
    throw new Error(`Could not find ${runtime.executable} in ${runtime.asset}`);
  }

  await cp(runtimeRoot, runtimeDir, {recursive: true});
  rmSync(extractDir, {recursive: true, force: true});
  logger.info(`Prepared CloakBrowser runtime at ${runtimeDir}`);
};

const readRuntimeManifest = async (): Promise<RuntimeManifest> => {
  const manifestPath = path.join(app.getAppPath(), 'cloakbrowser.runtime.json');
  return JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest;
};

const normalizeRuntimeList = (value?: CloakBrowserRuntime[] | CloakBrowserRuntime) => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const toRuntimeOption = (
  manifest: RuntimeManifest,
  platform: string,
  runtime: CloakBrowserRuntime,
): CloakBrowserRuntimeOption => {
  const executablePath = path.join(getRuntimeDir(platform, runtime.tag), runtime.executable);
  return {
    ...runtime,
    platform,
    downloaded: existsSync(executablePath),
    executablePath,
    downloadUrl: `${manifest.source}/download/${runtime.tag}/${runtime.asset}`,
  };
};

const parseRuntimeOverrides = (value?: string | Record<string, string> | null) => {
  if (!value) {
    return {} as Record<string, string>;
  }

  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
};

const findCompatibleRuntime = (
  runtimes: CloakBrowserRuntimeOption[],
  options: {
    tag?: string;
    coreFamily?: string;
    channel?: string;
    requiredCapabilities: string[];
  },
) => {
  const candidates = runtimes.filter(runtime => {
    if (options.tag && runtime.tag !== options.tag) {
      return false;
    }
    if (options.coreFamily && runtime.coreFamily !== options.coreFamily) {
      return false;
    }
    if (options.channel && runtime.channel && runtime.channel !== options.channel) {
      return false;
    }
    return hasCapabilities(runtime, options.requiredCapabilities);
  });

  return candidates.find(item => item.recommended) || candidates[0];
};

const hasCapabilities = (runtime: CloakBrowserRuntimeOption, requiredCapabilities: string[]) => {
  if (!requiredCapabilities.length) {
    return true;
  }
  const supported = new Set(runtime.capabilities || []);
  return requiredCapabilities.every(capability => supported.has(capability));
};

export const getRequiredRuntimeCapabilities = (windowData: DB.Window) => {
  const fingerprint = parseFingerprint(windowData.fingerprint);
  const capabilities = new Set<string>();

  if (fingerprint.fingerprintSeed) capabilities.add('fingerprint.seed');
  if (fingerprint.timezone) capabilities.add('fingerprint.timezone');
  if (fingerprint.locale) capabilities.add('fingerprint.locale');
  if (fingerprint.screenWidth || fingerprint.screenHeight) capabilities.add('fingerprint.screen');
  if (fingerprint.webrtcPolicy) capabilities.add('fingerprint.webrtc');

  return [...capabilities];
};

const parseFingerprint = (fingerprint?: string | DB.WindowFingerprint) => {
  if (!fingerprint || fingerprint === '{}') {
    return {} as DB.WindowFingerprint;
  }
  if (typeof fingerprint !== 'string') {
    return fingerprint;
  }
  try {
    return JSON.parse(fingerprint) as DB.WindowFingerprint;
  } catch {
    return {} as DB.WindowFingerprint;
  }
};

const getRuntimeDir = (platform: string, tag: string) => {
  return path.join(app.getPath('userData'), 'runtimes', 'cloakbrowser', platform, tag);
};

async function findRuntimeRoot(baseDir: string, executableRelativePath: string): Promise<string> {
  const directExecutable = path.join(baseDir, executableRelativePath);
  if (existsSync(directExecutable)) {
    return baseDir;
  }

  const entries = await readdir(baseDir);
  for (const entry of entries) {
    const candidate = path.join(baseDir, entry);
    const info = await stat(candidate);
    if (!info.isDirectory()) {
      continue;
    }

    const executable = path.join(candidate, executableRelativePath);
    if (existsSync(executable)) {
      return candidate;
    }
  }

  return '';
}

function sha256File(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function downloadFile(url: string, destination: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'cloak-power-browser',
        },
      },
      response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
          response.resume();
          if (!response.headers.location || redirects > 5) {
            reject(new Error(`Too many redirects while downloading ${url}`));
            return;
          }
          downloadFile(response.headers.location, destination, redirects + 1).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Download failed: ${url} status=${response.statusCode}`));
          return;
        }

        const file = createWriteStream(destination);
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', reject);
      },
    );

    request.on('error', reject);
  });
}
