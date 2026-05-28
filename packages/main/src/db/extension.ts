import {db} from '.';
import type {DB} from '../../../shared/types/db';

const SQLITE_WHERE_IN_BATCH_SIZE = 500;

const chunkArray = <T>(items: T[], size: number): T[][] => {
  if (!items.length) {
    return [];
  }

  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

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

const getExtensionsByChromeId = async (chromeExtensionId: string) => {
  const rows = await db('extension')
    .where({chrome_extension_id: chromeExtensionId})
    .orderBy('updated_at', 'desc');
  return rows.map(row => normalizeExtension(row as DB.Extension));
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

  const existingRows: Array<{window_id: number}> = [];
  const windowIdBatches = chunkArray(windows, SQLITE_WHERE_IN_BATCH_SIZE);

  for (const batch of windowIdBatches) {
    const rows = await db('window_extension')
      .where({extension_id: id})
      .whereIn('window_id', batch)
      .select('window_id');
    existingRows.push(...(rows as Array<{window_id: number}>));
  }

  const existingIds = new Set(existingRows.map(row => row.window_id));
  const payload = windows
    .filter(windowId => !existingIds.has(windowId))
    .map(windowId => ({extension_id: id, window_id: windowId}));

  if (!payload.length) {
    return [];
  }

  const payloadBatches = chunkArray(payload, SQLITE_WHERE_IN_BATCH_SIZE);
  const insertedResults: unknown[] = [];
  for (const batch of payloadBatches) {
    const result = await db('window_extension').insert(batch);
    insertedResults.push(result);
  }

  return insertedResults;
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

  let deletedCount = 0;
  const windowIdBatches = chunkArray(windowIds, SQLITE_WHERE_IN_BATCH_SIZE);

  for (const batch of windowIdBatches) {
    const deleted = await db('window_extension')
      .where({extension_id: id})
      .whereIn('window_id', batch)
      .delete();
    deletedCount += Number(deleted) || 0;
  }

  return deletedCount;
};

const deleteWindowReleted = async (windowIds: number | number[]) => {
  const targetIds = Array.isArray(windowIds) ? windowIds : [windowIds];
  if (!targetIds.length) {
    return 0;
  }

  let deletedCount = 0;
  const windowIdBatches = chunkArray(targetIds, SQLITE_WHERE_IN_BATCH_SIZE);
  for (const batch of windowIdBatches) {
    const deleted = await db('window_extension').whereIn('window_id', batch).delete();
    deletedCount += Number(deleted) || 0;
  }

  return deletedCount;
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
  getExtensionsByChromeId,
  createExtension,
  updateExtension,
  deleteExtension,
  deleteWindowReleted,
  insertExtensionWindows,
  deleteExtensionWindows,
  getExtensionWindows,
  getExtensionsByWindowId,
};
