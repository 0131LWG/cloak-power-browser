import {app, ipcMain, systemPreferences, shell} from 'electron';
import path from 'path';
import type {SafeAny} from '../../../shared/types/db';
import { createLogger } from '../../../shared/utils/logger';
import { MAIN_LOGGER_LABEL } from '../constants';
import { dialog } from 'electron';
const logger = createLogger(MAIN_LOGGER_LABEL);
let addon: unknown;
if (!app.isPackaged) {
  // 开发环境：直接从构建目录加载
  addon = require(path.join(__dirname, '../src/native-addon/build/Release/', 'window-addon.node'));
} else {
  // 生产环境：根据平台和架构选择正确路径
  // const addonDir = `${process.platform}-${process.arch}`;
  
  const addonPath = path.join(
    process.resourcesPath,
    'app.asar.unpacked/node_modules/window-addon/',
    'window-addon.node',
  );

  try {
    addon = require(addonPath);
  } catch (error) {
    logger.error('Failed to load addon:', error);
    logger.error('Attempted path:', addonPath);
    logger.error('Platform and arch:', process.platform, process.arch);
  }
}

export const initSyncService = () => {
  if (!addon) {
    logger.error('Window addon not loaded properly', process.resourcesPath);
    return;
  }
  
  // 检查辅助功能权限（仅macOS）
  if (process.platform === 'darwin') {
    const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
    logger.info(`Accessibility permission: ${hasPermission ? 'granted' : 'denied'}`);
    
    if (!hasPermission) {
      // 在应用启动时提示用户授予权限
      logger.warn('应用需要辅助功能权限来排列窗口');
      dialog.showMessageBox({
        type: 'warning',
        title: '需要辅助功能权限',
        message: '请在系统偏好设置中为应用授予辅助功能权限，以启用窗口排列功能。',
        buttons: ['前往设置', '稍后再说'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          // 打开辅助功能设置
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        }
      });
    }
  }
  
  const windowManager = new (addon as SafeAny).WindowManager();
  const getBoundsWithFallback = (pid: number) => {
    const bounds = windowManager.getWindowBounds(pid);
    if (bounds?.success) return bounds;

    try {
      const windows = (windowManager.getAllWindows(pid) || []) as Array<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
      if (!windows.length) return bounds;

      const largest = windows.reduce((best, current) => {
        const bestArea = (best.width || 0) * (best.height || 0);
        const currentArea = (current.width || 0) * (current.height || 0);
        return currentArea > bestArea ? current : best;
      });

      if (largest.width > 0 && largest.height > 0) {
        return {
          success: true,
          x: largest.x,
          y: largest.y,
          width: largest.width,
          height: largest.height,
        };
      }
    } catch (error) {
      logger.warn('[WindowDebug] getBoundsWithFallback failed', {pid, error});
    }

    return bounds;
  };
  const logWindowsByPid = (pid: number, reason: string) => {
    try {
      const windows = windowManager.getAllWindows(pid) || [];
      logger.warn(`[WindowDebug] ${reason}`, {pid, windowCount: windows.length, windows});
    } catch (error) {
      logger.warn(`[WindowDebug] ${reason} (getAllWindows failed)`, {pid, error});
    }
  };

  logger.info('WindowManager initialized');

  ipcMain.handle('window-arrange', async (_, args) => {
    const {mainPid, childPids, columns, size, spacing, monitorIndex} = args;
    logger.info('Arranging windows', {mainPid, childPids, columns, size, spacing, monitorIndex});
    try {
      if (!windowManager) {
        logger.error('WindowManager not initialized');
        throw new Error('WindowManager not initialized');
      }
      const mainBounds = getBoundsWithFallback(mainPid);
      if (!mainBounds?.success) {
        logWindowsByPid(mainPid, 'Main window bounds lookup failed');
        throw new Error(`Main window not found or inaccessible (PID: ${mainPid})`);
      }
      if (!Array.isArray(childPids) || childPids.length === 0) {
        throw new Error('No child windows provided for arrangement');
      }
      const validChildPids = childPids.filter((pid: number) => {
        const bounds = getBoundsWithFallback(pid);
        if (!bounds?.success) {
          logWindowsByPid(pid, 'Child window bounds lookup failed');
        }
        return Boolean(bounds?.success);
      });
      if (validChildPids.length === 0) {
        throw new Error('No valid child windows found for arrangement');
      }
      logger.info('arrangeWindows', windowManager.arrangeWindows.toString());
      try {
        // Pass monitorIndex if provided, otherwise let native addon use default (0)
        if (monitorIndex !== undefined) {
          windowManager.arrangeWindows(mainPid, validChildPids, columns, size, spacing, monitorIndex);
        } else {
          windowManager.arrangeWindows(mainPid, validChildPids, columns, size, spacing);
        }
      } catch (e) {
        logger.error('Native function execution error:', e);
        throw e;
      }

      return {success: true};
    } catch (error) {
      logger.error('Window arrangement failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle('window-get-monitors', async () => {
    logger.info('Getting available monitors');
    try {
      if (!windowManager) {
        logger.error('WindowManager not initialized');
        throw new Error('WindowManager not initialized');
      }

      const monitors = windowManager.getMonitors();
      logger.info('Available monitors:', monitors);
      return {success: true, monitors};
    } catch (error) {
      logger.error('Failed to get monitors:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        monitors: [],
      };
    }
  });
};
