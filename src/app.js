const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Import database and Redis
const { connectDB, db } = require('./config/database');
const { redis, redisStats, redisPubSub } = require('./config/redis');

// Import models
const AccountModel = require('./models/knex/Account');
const ProxyModel = require('./models/knex/Proxy');
const BatchModel = require('./models/knex/Batch'); // اگر وجود داره

// Import services and controllers
const InstanceWebSocketService = require('./services/instanceWebSocketService');
const uploadController = require('./controllers/uploadController');
const statsController = require('./controllers/statsController');
const proxyService = require('./services/proxyService');
const proxyUpdaterService = require('./services/proxyUpdaterService');
const statsService = require('./services/statsService');
const accountService = require('./services/accountService');
const upload = require('./config/multer');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Configure Socket.IO
const io = socketIo(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ?
            [process.env.FRONTEND_URL] : "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Dashboard WebSocket (جدا از instance websocket)
const dashboardIO = io.of('/dashboard');

// Instance WebSocket Service
let instanceWS;

// Initialize services after database connection
async function initializeServices() {
    try {
        console.log('🔧 Initializing services...');

        // Initialize Instance WebSocket Service
        instanceWS = new InstanceWebSocketService(server);

        // Start proxy updater service
        proxyUpdaterService.start();

        // Setup proxy updater listeners
        setupProxyUpdaterListeners();

        console.log('✅ All services initialized successfully');

    } catch (error) {
        console.error('❌ Error initializing services:', error);
        throw error;
    }
}

// Connect to database and initialize services
connectDB().then(async () => {
    try {
        console.log('📊 Testing database connection...');

        // تست اتصال دیتابیس
        const testResult = await statsController.testDatabaseConnection();
        console.log('✅ Database test result:', testResult);

        // تست اتصال Redis
        try {
            await statsController.testRedisConnection();
            console.log('✅ Redis connection test successful');
        } catch (redisError) {
            console.warn('⚠️ Redis connection test failed:', redisError.message);
        }

        // Initialize services
        await initializeServices();

    } catch (error) {
        console.error('❌ Database/Services initialization failed:', error);
        process.exit(1);
    }
}).catch((error) => {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
});

// Setup proxy updater event listeners
function setupProxyUpdaterListeners() {
    proxyUpdaterService.on('update-started', (data) => {
        console.log('📡 Proxy update started');
        dashboardIO.emit('proxy-update-status', {
            status: 'updating',
            message: 'شروع به‌روزرسانی پروکسی‌ها...',
            timestamp: Date.now(),
            ...data
        });
    });

    proxyUpdaterService.on('update-progress', (data) => {
        dashboardIO.emit('proxy-update-progress', {
            ...data,
            timestamp: Date.now()
        });
    });

    proxyUpdaterService.on('update-completed', (data) => {
        console.log('✅ Proxy update completed:', data.message);
        dashboardIO.emit('proxy-update-status', {
            status: 'success',
            message: data.message,
            stats: data.stats,
            timestamp: Date.now(),
            lastUpdate: Date.now()
        });
    });

    proxyUpdaterService.on('update-failed', (data) => {
        console.error('❌ Proxy update failed:', data.message);
        dashboardIO.emit('proxy-update-status', {
            status: 'error',
            message: data.message,
            error: data.error,
            timestamp: Date.now()
        });
    });
}

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "ws:", "wss:"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
        },
    },
}));

// Compression middleware
app.use(compression());

// Logging middleware
if (process.env.NODE_ENV === 'production') {
    app.use(morgan('combined'));
} else {
    app.use(morgan('dev'));
}

// Basic middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ?
        [process.env.FRONTEND_URL] : "*",
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Create necessary directories
const requiredDirs = ['uploads', 'logs', 'screenshots', 'backups'];
requiredDirs.forEach(dir => {
    const dirPath = path.join(__dirname, '..', dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const health = instanceWS ? await instanceWS.getSystemHealth() : null;
        const dbHealth = await testDatabaseHealth();
        const redisHealth = await testRedisHealth();

        const overallHealth = dbHealth.connected && redisHealth.connected;

        res.status(overallHealth ? 200 : 503).json({
            status: overallHealth ? 'ok' : 'degraded',
            timestamp: Date.now(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            database: dbHealth,
            redis: redisHealth,
            system: health,
            version: process.env.npm_package_version || '1.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: Date.now()
        });
    }
});

async function testDatabaseHealth() {
    try {
        const result = await AccountModel.query().count('* as count').first();
        return {
            connected: true,
            accountCount: parseInt(result?.count) || 0,
            responseTime: Date.now()
        };
    } catch (error) {
        return {
            connected: false,
            error: error.message
        };
    }
}

async function testRedisHealth() {
    try {
        await redis.ping();
        return {
            connected: true,
            responseTime: Date.now()
        };
    } catch (error) {
        return {
            connected: false,
            error: error.message
        };
    }
}

// API middleware for logging
app.use('/api', (req, res, next) => {
    console.log(`🔍 API Request: ${req.method} ${req.url}`);
    if (process.env.NODE_ENV === 'development') {
        console.log('📋 Headers:', req.headers);
        console.log('📋 Content-Type:', req.get('Content-Type'));
    }
    next();
});

// API Routes
app.post('/api/upload', upload.single('file'), uploadController.uploadFile.bind(uploadController));

// Stats routes
app.get('/api/stats', statsController.getSystemStats.bind(statsController));
app.get('/api/stats/performance', statsController.getPerformanceStats.bind(statsController));
app.get('/api/stats/realtime', statsController.getRealTimeStats.bind(statsController));
app.get('/api/stats/historical', statsController.getHistoricalStats.bind(statsController));
app.get('/api/stats/full-report', statsController.getFullSystemReport.bind(statsController));

// Batch management routes
app.get('/api/batches', uploadController.getBatches.bind(uploadController));
app.get('/api/batches/:batchId', uploadController.getBatchDetails.bind(uploadController));
app.delete('/api/batches/:batchId', uploadController.deleteBatch.bind(uploadController));

// Account routes
app.get('/api/accounts/stats', async (req, res) => {
    try {
        const stats = await accountService.getStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Proxy Routes
app.post('/api/proxies/update', async (req, res) => {
    try {
        console.log('🔧 Manual proxy update requested via API');

        // بررسی اینکه آیا در حال به‌روزرسانی است یا نه
        const currentStatus = proxyUpdaterService.getStatus();

        if (currentStatus.isUpdating) {
            return res.status(409).json({
                success: false,
                message: 'به‌روزرسانی پروکسی در حال انجام است',
                data: {
                    status: 'already_running',
                    lastUpdate: currentStatus.lastUpdate,
                    nextUpdate: currentStatus.nextUpdate
                }
            });
        }

        // شروع به‌روزرسانی دستی
        const result = await proxyUpdaterService.manualUpdate();

        res.json({
            success: true,
            message: 'به‌روزرسانی پروکسی‌ها شروع شد',
            data: {
                status: 'started',
                timestamp: new Date(),
                serviceStatus: result
            }
        });

    } catch (error) {
        console.error('❌ Error in manual proxy update:', error);

        res.status(500).json({
            success: false,
            message: error.message || 'خطا در شروع به‌روزرسانی پروکسی‌ها',
            data: {
                status: 'error',
                error: error.message
            }
        });
    }
});

app.get('/api/proxies/status', (req, res) => {
    try {
        const status = proxyUpdaterService.getStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/proxies/stats', async (req, res) => {
    try {
        const stats = await proxyService.getProxyStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/proxies/test', async (req, res) => {
    try {
        const { proxyString } = req.body;
        if (!proxyString) {
            return res.status(400).json({
                success: false,
                message: 'proxyString الزامی است'
            });
        }

        const result = await proxyUpdaterService.testSingleProxy(proxyString);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Instance management routes
app.get('/api/instances', (req, res) => {
    try {
        if (!instanceWS) {
            return res.status(503).json({
                success: false,
                message: 'Instance WebSocket service not initialized'
            });
        }

        const stats = instanceWS.getConnectedInstancesStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        console.error('خطا در دریافت آمار instance ها:', error);
        res.status(500).json({
            success: false,
            message: 'خطا در دریافت آمار instance ها'
        });
    }
});

app.get('/api/instances/:instanceId', (req, res) => {
    try {
        if (!instanceWS) {
            return res.status(503).json({
                success: false,
                message: 'Instance WebSocket service not initialized'
            });
        }

        const { instanceId } = req.params;
        const instanceInfo = instanceWS.getInstanceInfo(instanceId);

        if (instanceInfo) {
            res.json({ success: true, data: instanceInfo });
        } else {
            res.status(404).json({
                success: false,
                message: 'Instance یافت نشد'
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Instance Control Routes
app.post('/api/instances/control-all', async (req, res) => {
    try {
        if (!instanceWS) {
            return res.status(503).json({
                success: false,
                message: 'Instance WebSocket service not initialized'
            });
        }

        const { action } = req.body;

        if (!['start', 'stop', 'restart', 'pause', 'resume'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'عملیات نامعتبر'
            });
        }

        const instanceStats = instanceWS.getConnectedInstancesStats();
        const instances = instanceStats.instances || [];

        if (instances.length === 0) {
            return res.json({
                success: true,
                message: 'هیچ instance فعالی برای کنترل یافت نشد',
                affectedInstances: 0
            });
        }

        let successCount = 0;
        let failedCount = 0;

        for (const instance of instances) {
            try {
                const success = instanceWS.sendToInstance(instance.instanceId, 'control-command', {
                    action,
                    timestamp: Date.now(),
                    source: 'dashboard'
                });

                if (success) {
                    successCount++;
                } else {
                    failedCount++;
                }
            } catch (error) {
                console.error(`خطا در کنترل instance ${instance.instanceId}:`, error);
                failedCount++;
            }
        }

        instanceWS.broadcastToInstances('pm2-control', {
            action,
            timestamp: Date.now(),
            source: 'dashboard'
        });

        const totalInstances = successCount + failedCount;
        let message = '';

        if (successCount === totalInstances) {
            message = `عملیات ${getActionText(action)} با موفقیت روی ${successCount} instance انجام شد`;
        } else if (successCount > 0) {
            message = `عملیات ${getActionText(action)} روی ${successCount} از ${totalInstances} instance انجام شد`;
        } else {
            message = `خطا در انجام عملیات ${getActionText(action)}`;
        }

        res.json({
            success: successCount > 0,
            message,
            affectedInstances: successCount,
            totalInstances,
            failedInstances: failedCount
        });

    } catch (error) {
        console.error('خطا در کنترل همه instance ها:', error);
        res.status(500).json({
            success: false,
            message: 'خطا در کنترل instance ها'
        });
    }
});

app.post('/api/instances/:instanceId/control', async (req, res) => {
    try {
        if (!instanceWS) {
            return res.status(503).json({
                success: false,
                message: 'Instance WebSocket service not initialized'
            });
        }

        const { instanceId } = req.params;
        const { action } = req.body;

        if (!['start', 'stop', 'restart', 'pause', 'resume', 'disconnect'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'عملیات نامعتبر'
            });
        }

        let success = false;

        if (action === 'disconnect') {
            success = instanceWS.forceDisconnectInstance(instanceId);
        } else {
            success = instanceWS.sendToInstance(instanceId, 'control-command', {
                action,
                timestamp: Date.now(),
                source: 'dashboard'
            });
        }

        if (success) {
            res.json({
                success: true,
                message: `عملیات ${getActionText(action)} روی instance ${instanceId} انجام شد`
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Instance یافت نشد یا غیرفعال است'
            });
        }

    } catch (error) {
        console.error(`خطا در کنترل instance ${req.params.instanceId}:`, error);
        res.status(500).json({
            success: false,
            message: 'خطا در کنترل instance'
        });
    }
});

// Test route for debugging
app.get('/api/stats/test', async (req, res) => {
    try {
        const [
            accountCount,
            proxyCount,
            pendingAccounts,
            accountsByStatus,
            redisStats
        ] = await Promise.all([
            AccountModel.query().count('* as count').first(),
            ProxyModel.query().count('* as count').first(),
            AccountModel.query().where('status', 'pending').count('* as count').first(),
            AccountModel.query()
                .select('status')
                .count('* as count')
                .groupBy('status'),
            statsService.getStats().catch(() => null)
        ]);

        res.json({
            success: true,
            data: {
                directCounts: {
                    accounts: parseInt(accountCount?.count) || 0,
                    proxies: parseInt(proxyCount?.count) || 0,
                    pendingAccounts: parseInt(pendingAccounts?.count) || 0
                },
                accountsByStatus: accountsByStatus,
                redisStats: redisStats,
                instanceStats: instanceWS ? instanceWS.getConnectedInstancesStats() : null,
                timestamp: Date.now()
            }
        });

    } catch (error) {
        console.error('❌ Test stats error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

function getActionText(action) {
    const actionTexts = {
        'start': 'شروع',
        'stop': 'توقف',
        'restart': 'راه‌اندازی مجدد',
        'pause': 'مکث',
        'resume': 'ادامه',
        'disconnect': 'قطع اتصال'
    };
    return actionTexts[action] || action;
}

// Dashboard WebSocket namespace
dashboardIO.on('connection', (socket) => {
    console.log('📊 Dashboard client connected:', socket.id);

    // Send initial stats immediately
    socket.on('request-stats', async () => {
        console.log('📊 Dashboard requesting stats from:', socket.id);

        try {
            // استفاده از statsController برای دریافت آمار کامل
            const statsResult = await statsController.getSystemStats();

            if (statsResult.success) {
                socket.emit('stats-update', {
                    system: statsResult.data,
                    timestamp: Date.now()
                });
                console.log('📊 ✅ Stats sent to dashboard');
            } else {
                throw new Error('Failed to get system stats');
            }

        } catch (error) {
            console.error('❌ Error in stats request:', error);
            socket.emit('error', {
                message: 'خطا در دریافت آمار سیستم',
                error: error.message,
                timestamp: Date.now()
            });
        }
    });

    // Handle proxy update requests
    socket.on('update-proxies', async () => {
        try {
            await proxyUpdaterService.manualUpdate();
            socket.emit('notification', {
                message: 'به‌روزرسانی پروکسی‌ها آغاز شد',
                type: 'info'
            });
        } catch (error) {
            socket.emit('notification', {
                message: `خطا در به‌روزرسانی پروکسی‌ها: ${error.message}`,
                type: 'error'
            });
        }
    });

    // Handle instance control
    socket.on('start-all-instances', () => {
        if (instanceWS) {
            console.log('🚀 Dashboard requested start all instances');
            instanceWS.broadcastToInstances('start-processing', {});
            socket.emit('notification', {
                message: 'درخواست شروع همه instance ها ارسال شد',
                type: 'info'
            });
        }
    });

    socket.on('stop-all-instances', () => {
        if (instanceWS) {
            console.log('⏹️ Dashboard requested stop all instances');
            instanceWS.broadcastToInstances('stop-processing', {});
            socket.emit('notification', {
                message: 'درخواست توقف همه instance ها ارسال شد',
                type: 'warning'
            });
        }
    });

    socket.on('start-instance', (data) => {
        if (instanceWS) {
            console.log('🚀 Dashboard requested start instance:', data.instanceId);
            instanceWS.sendToInstance(data.instanceId, 'start-processing', {});
            socket.emit('notification', {
                message: `درخواست شروع instance ${data.instanceId} ارسال شد`,
                type: 'info'
            });
        }
    });

    socket.on('stop-instance', (data) => {
        if (instanceWS) {
            console.log('⏹️ Dashboard requested stop instance:', data.instanceId);
            instanceWS.sendToInstance(data.instanceId, 'stop-processing', {});
            socket.emit('notification', {
                message: `درخواست توقف instance ${data.instanceId} ارسال شد`,
                type: 'warning'
            });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('📊 Dashboard client disconnected:', socket.id, 'Reason:', reason);
    });
});

// Broadcast stats to dashboard clients every 3 seconds
setInterval(async () => {
    try {
        if (dashboardIO.sockets.size > 0) {
            console.log(`🔄 Broadcasting stats to ${dashboardIO.sockets.size} dashboard clients...`);

            const statsResult = await statsController.getSystemStats();

            if (statsResult.success) {
                dashboardIO.emit('stats-update', {
                    system: statsResult.data,
                    timestamp: Date.now()
                });
                console.log('📊 ✅ Broadcast completed');
            }
        }
    } catch (error) {
        console.error('❌ Error broadcasting stats:', error.message);
    }
}, 3000);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
            success: false,
            message: 'حجم فایل بیش از حد مجاز است'
        });
    }

    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({
            success: false,
            message: 'فرمت JSON نامعتبر است'
        });
    }

    res.status(500).json({
        success: false,
        message: process.env.NODE_ENV === 'production'
            ? 'خطای داخلی سرور'
            : err.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'صفحه یافت نشد'
    });
});

// Server configuration
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log('='.repeat(60));
    console.log('🚀 Sony Account Management Server Started');
    console.log('='.repeat(60));
    console.log(`📍 Server: http://${HOST}:${PORT}`);
    console.log(`📊 Dashboard: http://${HOST}:${PORT}`);
    console.log(`🔗 Instance WebSocket: ws://${HOST}:${PORT}/instance-socket`);
    console.log(`📊 Dashboard WebSocket: ws://${HOST}:${PORT}/dashboard`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 PostgreSQL: ${process.env.DATABASE_URL || 'localhost:5432'}`);
    console.log(`🔴 Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
    console.log('='.repeat(60));
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

    // Stop accepting new connections
    server.close(() => {
        console.log('✅ HTTP server closed');
    });

    try {
        // Stop services
        if (proxyUpdaterService) {
            proxyUpdaterService.stop();
            console.log('✅ Proxy updater service stopped');
        }

        // Close database connections
        if (db()) {
            await db().destroy();
            console.log('✅ PostgreSQL connection closed');
        }

        // Close Redis connections
        await Promise.all([
            redis.quit(),
            redisStats.quit(),
            redisPubSub.quit()
        ]);
        console.log('✅ Redis connections closed');

        console.log('✅ Graceful shutdown completed');
        process.exit(0);

    } catch (error) {
        console.error('❌ Error during graceful shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
    process.exit(1);
});

module.exports = { app, server, instanceWS, dashboardIO };