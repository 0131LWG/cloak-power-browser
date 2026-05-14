/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('extension', table => {
    table.string('source_type').defaultTo('custom');
    table.string('source_url').nullable();
    table.string('chrome_extension_id').nullable();
    table.string('distribution_mode').defaultTo('manual');
    table.boolean('auto_update').defaultTo(true);
  });

  await knex('extension')
    .whereNull('source_type')
    .update({source_type: 'custom'});

  await knex('extension')
    .whereNull('distribution_mode')
    .update({distribution_mode: 'manual'});

  await knex('extension')
    .whereNull('auto_update')
    .update({auto_update: true});
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('extension', table => {
    table.dropColumn('source_type');
    table.dropColumn('source_url');
    table.dropColumn('chrome_extension_id');
    table.dropColumn('distribution_mode');
    table.dropColumn('auto_update');
  });
};
