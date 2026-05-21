import {db} from '../db';

let ensured = false;

export const ensureCloudSyncSchema = async () => {
  if (ensured) {
    return;
  }

  const hasSyncDevice = await db.schema.hasTable('sync_device');
  if (!hasSyncDevice) {
    await db.schema.createTable('sync_device', table => {
      table.increments('id').primary();
      table.string('device_id').notNullable().unique();
      table.string('device_name').nullable();
      table.string('workspace_id').nullable();
      table.string('user_id').nullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').nullable();
    });
  }

  const hasSyncOutbox = await db.schema.hasTable('sync_outbox');
  if (!hasSyncOutbox) {
    await db.schema.createTable('sync_outbox', table => {
      table.increments('id').primary();
      table.string('workspace_id').nullable();
      table.string('entity_type').notNullable();
      table.integer('local_id').nullable();
      table.string('cloud_id').nullable();
      table.string('operation').notNullable();
      table.json('payload').nullable();
      table.integer('attempt_count').defaultTo(0);
      table.text('last_error').nullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').nullable();
      table.timestamp('processed_at').nullable();
    });
  }

  const hasSyncState = await db.schema.hasTable('sync_state');
  if (!hasSyncState) {
    await db.schema.createTable('sync_state', table => {
      table.increments('id').primary();
      table.string('workspace_id').notNullable();
      table.string('entity_type').notNullable();
      table.string('cursor').nullable();
      table.timestamp('last_pulled_at').nullable();
      table.timestamp('updated_at').nullable();
      table.unique(['workspace_id', 'entity_type']);
    });
  }

  const hasSyncConflict = await db.schema.hasTable('sync_conflict');
  if (!hasSyncConflict) {
    await db.schema.createTable('sync_conflict', table => {
      table.increments('id').primary();
      table.string('workspace_id').nullable();
      table.string('entity_type').notNullable();
      table.integer('local_id').nullable();
      table.string('cloud_id').nullable();
      table.json('local_payload').nullable();
      table.json('remote_payload').nullable();
      table.string('status').defaultTo('open');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('resolved_at').nullable();
    });
  }

  ensured = true;
};
