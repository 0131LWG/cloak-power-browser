import {existsSync} from 'fs';
import {join} from 'path';
import type {DB} from '../../../shared/types/db';
import type {SettingOptions} from '../../../shared/types/common';
import {resolveGeoConsistencyProfile} from './geo-consistency';

export interface CloakBrowserLaunchOptions {
  chromePort: number;
  finalProxy?: string;
  headless?: boolean;
  ipCountry?: string;
  ipTimeZone?: string;
  isMac: boolean;
  profileId: string;
  profileRoot: string;
  runtimeExecutablePath?: string;
  startUrl?: string;
  extensions?: string[];
  windowData: DB.Window;
}

export interface BrowserLaunchPlan {
  executablePath: string;
  profileDirName: string;
  userDataDir: string;
  args: string[];
  runtime: 'chrome' | 'cloakbrowser';
}

export const shouldUseCloakBrowser = (settings: SettingOptions, windowData?: DB.Window) => {
  return Boolean(
    windowData?.browser_engine === 'cloakbrowser' ||
    process.env.CLOAK_BROWSER_ENABLED === '1' ||
      settings.useCloakBrowser ||
      process.env.CLOAK_BROWSER_PATH,
  );
};

export const getCloakBrowserPath = (settings: SettingOptions) => {
  return (
    process.env.CLOAK_BROWSER_PATH ||
    settings.cloakBrowserPath ||
    getPackagedCloakBrowserPath() ||
    settings.chromiumBinPath
  );
};

export const buildCloakBrowserLaunchPlan = (
  settings: SettingOptions,
  options: CloakBrowserLaunchOptions,
): BrowserLaunchPlan => {
  const executablePath = options.runtimeExecutablePath || getCloakBrowserPath(settings);
  const userDataDir = join(options.profileRoot, 'cloakbrowser', options.profileId);
  const fingerprint = parseFingerprint(options.windowData.fingerprint);
  const seed = fingerprint.fingerprintSeed || stableFingerprintSeed(options.profileId);
  const geoProfile = resolveGeoConsistencyProfile({
    country: options.ipCountry,
    timezone: fingerprint.timezone || options.ipTimeZone,
    locale: fingerprint.locale,
  });

  const args = [
    ...(options.isMac ? ['--args'] : []),
    '--force-color-profile=srgb',
    '--no-first-run',
    '--no-default-browser-check',
    '--metrics-recording-only',
    '--disable-background-mode',
    `--remote-debugging-port=${options.chromePort}`,
    `--user-data-dir=${userDataDir}`,
    '--unhandled-rejections=strict',
    ...(options.isMac ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${fingerprint.platform || getDefaultFingerprintPlatform()}`,
  ];

  if (options.finalProxy) {
    args.push(`--proxy-server=${options.finalProxy}`);
  }

  if (geoProfile.timezone) {
    args.push(`--fingerprint-timezone=${geoProfile.timezone}`);
  }

  args.push(`--lang=${geoProfile.locale}`);
  args.push(`--accept-lang=${geoProfile.acceptLanguage}`);
  args.push(`--fingerprint-locale=${geoProfile.locale}`);

  if (fingerprint.ua || options.windowData.ua) {
    args.push(`--user-agent=${fingerprint.ua || options.windowData.ua}`);
  }

  if (fingerprint.screenWidth) {
    args.push(`--fingerprint-screen-width=${fingerprint.screenWidth}`);
  }

  if (fingerprint.screenHeight) {
    args.push(`--fingerprint-screen-height=${fingerprint.screenHeight}`);
  }

  if (fingerprint.webrtcPolicy === 'disabled') {
    args.push('--disable-features=WebRtcHideLocalIpsWithMdns');
  } else if (options.finalProxy || fingerprint.webrtcPolicy === 'auto') {
    args.push('--fingerprint-webrtc-ip=auto');
  }

  if (options.extensions?.length) {
    args.push(`--load-extension=${options.extensions.join(',')}`);
  }

  if (options.headless) {
    args.push('--headless=new');
    if (!options.isMac) {
      args.push('--disable-gpu');
    }
  } else {
    args.push('--new-window');
    if (options.startUrl) {
      args.push(options.startUrl);
    }
  }

  return {
    executablePath,
    profileDirName: 'cloakbrowser',
    userDataDir,
    args,
    runtime: 'cloakbrowser',
  };
};

interface FingerprintSettings {
  ua?: string;
  locale?: string;
  timezone?: string;
  platform?: string;
  fingerprintSeed?: string;
  screenWidth?: number;
  screenHeight?: number;
  webrtcPolicy?: string;
}

const parseFingerprint = (fingerprint?: string | DB.WindowFingerprint): FingerprintSettings => {
  if (!fingerprint || fingerprint === '{}') {
    return {};
  }

  if (typeof fingerprint !== 'string') {
    return fingerprint as FingerprintSettings;
  }

  try {
    return JSON.parse(fingerprint) as FingerprintSettings;
  } catch {
    return {};
  }
};

const stableFingerprintSeed = (profileId: string) => {
  let hash = 0;
  for (let index = 0; index < profileId.length; index++) {
    hash = (hash * 31 + profileId.charCodeAt(index)) >>> 0;
  }

  return String(10000 + (hash % 90000));
};

const getPackagedCloakBrowserPath = () => {
  if (!process.resourcesPath) {
    return '';
  }

  let executablePath = '';

  if (process.platform === 'darwin') {
    executablePath = join(
      process.resourcesPath,
      'app',
      'cloakbrowser',
      'Chromium.app',
      'Contents',
      'MacOS',
      'Chromium',
    );
  } else if (process.platform === 'win32') {
    executablePath = join(process.resourcesPath, 'app', 'cloakbrowser', 'chrome.exe');
  } else {
    executablePath = join(process.resourcesPath, 'app', 'cloakbrowser', 'chrome');
  }

  return existsSync(executablePath) ? executablePath : '';
};

const getDefaultFingerprintPlatform = () => {
  if (process.platform === 'darwin') {
    return 'macos';
  }

  if (process.platform === 'win32') {
    return 'windows';
  }

  return 'linux';
};
