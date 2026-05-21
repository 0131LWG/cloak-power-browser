import {db} from '.';
import type {DB} from '../../../shared/types/db';

const all = async (workspaceId?: string) => {
  const query = db('tag').select('*');
  if (workspaceId) {
    query.where(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', workspaceId);
    });
  }
  return await query;
};

const getById = async (id: number) => {
  return await db('tag').where({id}).first();
};
const getByName = async (name: string) => {
  return await db('tag').where({name}).first();
};

const update = async (id: number, updatedData: DB.Tag) => {
  return await db('tag').where({id}).update(updatedData);
};

const create = async (tagData: DB.Tag) => {
  return await db('tag').insert(tagData);
};

const remove = async (id: number) => {
  return await db('tag').where({id}).delete();
};

const deleteAll = async () => {
  return await db('tag').delete();
};

export const TagDB = {
  all,
  getById,
  getByName,
  update,
  create,
  remove,
  deleteAll,
};
