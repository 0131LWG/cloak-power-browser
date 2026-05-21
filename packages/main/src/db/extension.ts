import {db} from '.';
import type {DB} from '../../../shared/types/db';

const normalizeExtension = (extension: DB.Extension): DB.Extension => {
  return {
    ...extension,
    source_type: extension.source_type ?? 'custom',
    distribution_mode: extension.distribution_mode ?? 'manual',
    auto_update: typeof extension.auto_update === 'boolean' ? extension.auto_update : extension.auto_update !== 0,
  };
};

const getAllExtensions = async (workspaceId?: string) => {
  const query = db('extension').select('*');
  if (workspaceId) {
    query.where(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', workspaceId);
    });
  }
  const rows = await query.orderBy('created_at', 'desc');
  return rows.map(row => normalizeExtension(row as DB.Extension));
};

const getExtensionById = async (id: number) => {
  const row = await db('extension').where({id}).first();
  return row ? normalizeExtension(row as DB.Extension) : undefined;
};

const getExtensionByChromeId = async (chromeExtensionId: string) => {
  const row = await db('extension').where({chrome_extension_id: chromeExtensionId}).first();
  return row ? normalizeExtension(row as DB.Extension) : undefined;
};

const createExtension = async (extension: DB.Extension) => {
  return await db('extension').insert(extension);
};

const updateExtension = async (id: number, extension: Partial<DB.Extension>) => {
  const extensionData = await getExtensionById(id);
  if (!extensionData) {
    throw new Error('Extension not found');
  }

  return await db('extension')
    .where({id})
    .update({
      ...extensionData,
      ...extension,
    });
};

const insertExtensionWindows = async (id: number, windows: number[]) => {
  if (!windows.length) {
    return [];
  }

  const existingRows = await db('window_extension')
    .where({extension_id: id})
    .whereIn('window_id', windows)
    .select('window_id');
  const existingIds = new Set(existingRows.map(row => row.window_id));
  const payload = windows
    .filter(windowId => !existingIds.has(windowId))
    .map(windowId => ({extension_id: id, window_id: windowId}));

  if (!payload.length) {
    return [];
  }

  return await db('window_extension').insert(payload);
};

const getExtensionsByWindowId = async (windowId: number) => {
  const extensionIds = await db('window_extension')
    .where({window_id: windowId})
    .select('extension_id');
  const ids = extensionIds.map(e => e.extension_id);

  const query = db('extension').select('*').where({distribution_mode: 'global'});
  if (ids.length > 0) {
    query.orWhereIn('id', ids);
  }

  const rows = await query.orderBy('created_at', 'desc');
  return rows.map(row => normalizeExtension(row as DB.Extension));
};

const deleteExtensionWindows = async (id: number, windowIds: number[]) => {
  if (!windowIds.length) {
    return 0;
  }

  return await db('window_extension')
    .where({extension_id: id})
    .whereIn('window_id', windowIds)
    .delete();
};

const deleteWindowReleted = async (windowIds: number | number[]) => {
  return await db('window_extension')
    .whereIn('window_id', Array.isArray(windowIds) ? windowIds : [windowIds])
    .delete();
};

const getExtensionWindows = async (id: number) => {
  return await db('window_extension').where({extension_id: id}).orderBy('created_at', 'asc');
};

const deleteExtension = async (id: number) => {
  await db('window_extension').where({extension_id: id}).delete();
  return await db('extension').where({id}).delete();
};

export const ExtensionDB = {
  getAllExtensions,
  getExtensionById,
  getExtensionByChromeId,
  createExtension,
  updateExtension,
  deleteExtension,
  deleteWindowReleted,
  insertExtensionWindows,
  deleteExtensionWindows,
  getExtensionWindows,
  getExtensionsByWindowId,
};
