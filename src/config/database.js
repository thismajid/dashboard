const knex = require('knex');
const knexConfig = require('../../knexfile');
require('dotenv').config();

// Initialize Knex instance
const environment = process.env.NODE_ENV || 'development';
const config = knexConfig[environment];

let db = null;

const connectDB = async () => {
    try {
        console.log(`🔄 Connecting to PostgreSQL (${environment})...`);
        console.log(`📍 Host: ${config.connection.host}:${config.connection.port}`);
        console.log(`🗄️ Database: ${config.connection.database}`);

        // Create Knex instance
        db = knex(config);

        // Test connection
        await db.raw('SELECT 1');

        console.log(`✅ PostgreSQL Connected successfully!`);

        // Run migrations
        try {
            console.log('🔄 Running database migrations...');
            const [batchNo, log] = await db.migrate.latest();

            if (log.length === 0) {
                console.log('✅ Database is up to date');
            } else {
                console.log('✅ Database migrations completed:');
                log.forEach(migration => {
                    console.log(`  📄 ${migration}`);
                });
            }
        } catch (migrationError) {
            console.warn('⚠️ Migration warning:', migrationError.message);
            // Don't exit on migration error, continue with app
        }

        return db;

    } catch (error) {
        console.error('❌ PostgreSQL connection failed:', error.message);
        console.error('💡 Make sure PostgreSQL is running and credentials are correct');
        throw error;
    }
};

// Get database instance
const getDB = () => {
    if (!db) {
        throw new Error('Database not initialized. Call connectDB() first.');
    }
    return db;
};

// Close database connection
const closeDB = async () => {
    if (db) {
        console.log('🔄 Closing database connection...');
        await db.destroy();
        db = null;
        console.log('✅ Database connection closed');
    }
};

// Export functions
module.exports = {
    connectDB,
    db: getDB,
    closeDB,
    // برای سازگاری با کد قدیمی
    default: connectDB
};