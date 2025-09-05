/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema.createTable('Accounts', function (table) {
    table.increments('id').primary();
    table.string('email').notNullable().unique();
    table.string('password').notNullable();
    table.string('accountLine').nullable(); // ممکنه همیشه نباشه

    // اضافه کردن ستون‌های مورد نیاز
    table.string('batchId').nullable(); // برای گروه‌بندی اکانت‌ها
    table.string('source').nullable(); // نام فایل منبع
    table.timestamp('uploadedAt').nullable(); // زمان آپلود
    table.timestamp('checkedAt').nullable(); // زمان چک شدن
    table.string('instanceId').nullable(); // instance که اکانت رو پردازش کرده
    table.integer('responseTime').nullable(); // زمان پاسخ

    table.enum('status', ['pending', 'processing', 'completed', 'failed', 'good', 'bad']).defaultTo('pending');
    table.enum('result', [
      'pending', 'good', 'bad', 'invalid', '2fa', 'passkey', 'error',
      'lock', 'guard', 'change-pass', 'mobile-2step', 'timeout', 'server-error'
    ]).defaultTo('pending');

    table.timestamps(true, true); // created_at and updated_at

    // Indexes for performance
    table.index(['status', 'created_at']);
    table.index('email');
    table.index('result');
    table.index('created_at');
    table.index('batchId'); // اضافه کردن index برای batchId
    table.index(['status', 'batchId']);
    table.index('instanceId');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.dropTable('Accounts');
};