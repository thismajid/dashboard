exports.up = function(knex) {
    return knex.schema.createTable('Proxies', function(table) {
        table.increments('id').primary();
        table.string('host').notNullable();
        table.integer('port').notNullable();
        table.string('username').nullable();
        table.string('password').nullable();
        table.enum('protocol', ['http', 'https', 'socks4', 'socks5']).defaultTo('http');
        table.enum('status', ['active', 'inactive', 'testing', 'failed']).defaultTo('inactive');
        table.integer('responseTime').nullable();
        table.string('source').defaultTo('api');
        table.timestamps(true, true);

        table.unique(['host', 'port']);
        table.index(['status', 'responseTime']);
    });
};

exports.down = function(knex) {
    return knex.schema.dropTable('Proxies');
};
