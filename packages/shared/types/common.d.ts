export interface OperationResult {
  success: boolean;
  message: string;
  data?: SafeAny;
}

export interface SettingOptions {
  profileCachePath: string;
  useLocalChrome: boolean;
  localChromePath: string;
  chromiumBinPath: string;
  useCloakBrowser?: boolean;
  cloakBrowserPath?: string;
  automationConnect: boolean;
}

export type NoticeType = 'info' | 'success' | 'error' | 'warning' | 'loading';

export interface BridgeMessage {
  type: NoticeType;
  text: string;
}
