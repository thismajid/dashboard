/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
    return knex.schema.createTable('Batches', function (table) {
        table.increments('id').primary();
        table.string('batchId').notNullable().unique();
        table.string('fileName').notNullable();
        table.integer('fileSize').notNullable();
        table.integer('accountCount').notNullable().defaultTo(0);

        table.enum('status', ['processing', 'completed', 'failed']).defaultTo('processing');
        table.timestamp('uploadedAt').defaultTo(knex.fn.now());
        table.timestamp('processedAt').nullable();

        table.string('originalName').nullable();
        table.string('mimeType').nullable();
        table.string('uploadIp').nullable();
        table.json('duplicateEmails').nullable();
        table.json('errorDetails').nullable();

        // آمار
        table.integer('statsSaved').defaultTo(0);
        table.integer('statsDuplicates').defaultTo(0);
        table.integer('statsErrors').defaultTo(0);
        table.integer('statsGood').defaultTo(0);
        table.integer('statsBad').defaultTo(0);
        table.integer('statsPending').defaultTo(0);

        table.timestamps(true, true);

        // Indexes
        table.index('batchId');
        table.index('status');
        table.index('created_at');
        table.index(['fileName', 'uploadedAt']);
        table.index('uploadedAt');
    }).then(() => {
        // اضافه کردن constraints با raw SQL برای جلوگیری از مشکل case sensitivity
        return knex.raw(`
 ALTER TABLE "Batches" 
 ADD CONSTRAINT "batches_filesize_check" CHECK ("fileSize" > 0),
 ADD CONSTRAINT "batches_accountcount_check" CHECK ("accountCount" >= 0),
 ADD CONSTRAINT "batches_statssaved_check" CHECK ("statsSaved" >= 0),
 ADD CONSTRAINT "batches_statsduplicates_check" CHECK ("statsDuplicates" >= 0),
 ADD CONSTRAINT "batches_statserrors_check" CHECK ("statsErrors" >= 0),
 ADD CONSTRAINT "batches_statsgood_check" CHECK ("statsGood" >= 0),
 ADD CONSTRAINT "batches_statsbad_check" CHECK ("statsBad" >= 0),
 ADD CONSTRAINT "batches_statspending_check" CHECK ("statsPending" >= 0)
 `);
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
    return knex.schema.dropTable('Batches');
};