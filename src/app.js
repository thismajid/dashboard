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

// Import services and controllers
const InstanceWebSocketService = require('./services/instanceWebSocketService');
const uploadController = require('./controllers/uploadController');
const statsController = require('./controllers/statsController');
const proxyService = require('./services/proxyService');
const proxyUpdaterService = require('./services/proxyUpdaterService');
const upload = require('./config/multer');
const connectDB = require('./config/database');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Configure Socket.IO
const io = socketIo(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ? false : "*",
        methods: ["GET", "POST"]
    }
});

// Dashboard WebSocket (جدا از instance websocket)
const dashboardIO = io.of('/dashboard');

// Instance WebSocket Service
const instanceWS = new InstanceWebSocketService(server);

// Connect to database
connectDB().then(async () => {
    try {
        // تست اتصال دیتابیس
        const testResult = await statsController.testDatabaseConnection();
        console.log('📊 Database test result:', testResult);
    } catch (error) {
        console.error('❌ Database test failed:', error);
    }
});

// Start proxy updater service
proxyUpdaterService.start();

// Add proxy updater listeners for dashboard updates
proxyUpdaterService.on('update-started', () => {
    console.log('📡 Proxy update started');
    dashboardIO.emit('proxy-update-status', {
        status: 'updating',
        message: 'شروع به‌روزرسانی پروکسی‌ها...',
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
        error: data.error?.message,
        timestamp: Date.now()
    });
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // اضافه کردن unsafe-inline
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
    origin: process.env.NODE_ENV === 'production' ? false : "*",
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Create necessary directories
const requiredDirs = ['uploads', 'logs', 'screenshots'];
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
        const health = await instanceWS.getSystemHealth();
        res.json({
            status: 'ok',
            timestamp: Date.now(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            ...health
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: Date.now()
        });
    }
});

app.use('/api', (req, res, next) => {
    console.log(`🔍 API Request: ${req.method} ${req.url}`);
    console.log('📋 Headers:', req.headers);
    console.log('📋 Content-Type:', req.get('Content-Type'));
    next();
});

// API Routes
app.post('/api/upload', upload.single('file'), uploadController.uploadFile.bind(uploadController));
app.get('/api/stats', statsController.getSystemStats.bind(statsController));
app.get('/api/stats/performance', statsController.getPerformanceStats.bind(statsController));
app.get('/api/stats/realtime', statsController.getRealTimeStats.bind(statsController));
app.get('/api/stats/historical', statsController.getHistoricalStats.bind(statsController));

// Batch management routes
app.get('/api/batches', uploadController.getBatches.bind(uploadController));
app.get('/api/batches/:batchId', uploadController.getBatchDetails.bind(uploadController));

// Proxy Routes
app.post('/api/proxies/update', async (req, res) => {
    try {
        await proxyUpdaterService.triggerUpdate();

        res.json({
            success: true,
            message: 'به‌روزرسانی پروکسی‌ها آغاز شد'
        });

    } catch (error) {
        console.error('Manual proxy update error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'خطا در به‌روزرسانی پروکسی‌ها'
        });
    }
});

app.get('/api/proxies/status', (req, res) => {
    try {
        const status = proxyUpdaterService.getStatus();
        res.json({
            success: true,
            data: status
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Instance management routes
app.get('/api/instances', (req, res) => {
    try {
        const stats = instanceWS.getConnectedInstancesStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('خطا در دریافت آمار instance ها:', error);
        res.status(500).json({
            success: false,
            message: 'خطا در دریافت آمار instance ها'
        });
    }
});

// Instance Control Routes
app.post('/api/instances/control-all', async (req, res) => {
    try {
        const { action } = req.body;

        if (!['start', 'stop', 'restart', 'pause', 'resume'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'عملیات نامعتبر'
            });
        }

        // Get all connected instances
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

        // Send control command to all instances
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

        // Broadcast to all instances for PM2 control
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
        const { instanceId } = req.params;
        const { action } = req.body;

        if (!['start', 'stop', 'restart', 'pause', 'resume'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'عملیات نامعتبر'
            });
        }

        // Send control command to specific instance
        const success = instanceWS.sendToInstance(instanceId, 'control-command', {
            action,
            timestamp: Date.now(),
            source: 'dashboard'
        });

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

app.get('/api/stats/test', async (req, res) => {
    try {
        const Account = require('./models/Account');
        const Proxy = require('./models/Proxy');

        const [
            accountCount,
            proxyCount,
            pendingAccounts,
            accountsByStatus
        ] = await Promise.all([
            Account.countDocuments({}),
            Proxy.countDocuments({}),
            Account.countDocuments({ status: 'pending' }),
            Account.aggregate([
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ])
        ]);

        res.json({
            success: true,
            data: {
                directCounts: {
                    accounts: accountCount,
                    proxies: proxyCount,
                    pendingAccounts: pendingAccounts
                },
                accountsByStatus: accountsByStatus,
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
        'resume': 'ادامه'
    };
    return actionTexts[action] || action;
}

// Dashboard WebSocket namespace
dashboardIO.on('connection', (socket) => {
    console.log('📊 Dashboard client connected:', socket.id);

    // Send initial stats immediately
    // Send initial stats immediately
    socket.on('request-stats', async () => {
        console.log('📊 ===== STATS REQUEST RECEIVED =====');
        console.log('📊 Dashboard requesting stats from:', socket.id);

        try {
            // تست مستقیم دیتابیس
            const Account = require('./models/Account');
            const Proxy = require('./models/Proxy');

            console.log('🔍 Testing direct database access...');
            const accountCount = await Account.countDocuments({});
            const proxyCount = await Proxy.countDocuments({});

            console.log('📊 Direct DB counts:', { accounts: accountCount, proxies: proxyCount });

            // دریافت جزئیات بیشتر
            const [
                pendingAccounts,
                activeProxies,
                accountResults
            ] = await Promise.all([
                Account.countDocuments({ status: 'pending' }),
                Proxy.countDocuments({ status: 'active' }),
                Account.aggregate([
                    { $match: { result: { $ne: null } } },
                    { $group: { _id: '$result', count: { $sum: 1 } } }
                ])
            ]);

            console.log('📊 Detailed counts:', {
                pendingAccounts,
                activeProxies,
                accountResults
            });

            // ساخت شیء stats به صورت مستقیم
            const systemStats = {
                accounts: {
                    total: accountCount,
                    pending: pendingAccounts,
                    processing: 0,
                    completed: 0,
                    failed: 0,
                    results: {
                        good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0,
                        error: 0, lock: 0, guard: 0, 'change-pass': 0,
                        'mobile-2step': 0, timeout: 0, 'server-error': 0
                    }
                },
                proxies: {
                    total: proxyCount,
                    active: activeProxies || proxyCount, // اگر همه active هستند
                    available: activeProxies || proxyCount,
                    used: 0,
                    failed: 0,
                    avgResponseTime: 0,
                    successRate: 100,
                    lastUpdate: new Date(),
                    nextUpdate: null
                },
                system: {
                    uptime: process.uptime(),
                    memory: {
                        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
                    }
                },
                batches: {
                    total: 0,
                    completed: 0
                }
            };

            // پردازش نتایج اکانت‌ها
            accountResults.forEach(item => {
                if (systemStats.accounts.results.hasOwnProperty(item._id)) {
                    systemStats.accounts.results[item._id] = item.count;
                }
            });

            console.log('📊 System stats object created:', JSON.stringify(systemStats, null, 2));

            // Get instance stats
            const instanceStats = instanceWS.getConnectedInstancesStats();
            console.log('📊 Instance stats:', instanceStats);

            // Get proxy service status
            const proxyStatus = proxyUpdaterService.getStatus();
            console.log('📊 Proxy service status:', proxyStatus);

            const responseData = {
                system: systemStats,
                instances: instanceStats,
                proxyService: proxyStatus,
                timestamp: Date.now()
            };

            console.log('📊 ===== SENDING STATS TO DASHBOARD =====');
            console.log('📊 Final response data:', {
                totalAccounts: responseData.system?.accounts?.total,
                pendingAccounts: responseData.system?.accounts?.pending,
                totalProxies: responseData.system?.proxies?.total,
                activeProxies: responseData.system?.proxies?.active
            });

            socket.emit('stats-update', responseData);
            console.log('📊 ✅ Stats sent to dashboard via socket.emit');

        } catch (error) {
            console.error('❌ ===== ERROR IN STATS REQUEST =====');
            console.error('❌ Error details:', error);
            console.error('❌ Error stack:', error.stack);

            socket.emit('error', {
                message: 'خطا در دریافت آمار سیستم',
                error: error.message,
                timestamp: Date.now()
            });
        }
    });

    // Handle instance control
    socket.on('start-all-instances', () => {
        console.log('🚀 Dashboard requested start all instances');
        instanceWS.broadcastToInstances('start-processing', {});
        socket.emit('notification', {
            message: 'درخواست شروع همه instance ها ارسال شد',
            type: 'info'
        });
    });

    socket.on('stop-all-instances', () => {
        console.log('⏹️ Dashboard requested stop all instances');
        instanceWS.broadcastToInstances('stop-processing', {});
        socket.emit('notification', {
            message: 'درخواست توقف همه instance ها ارسال شد',
            type: 'warning'
        });
    });

    socket.on('start-instance', (data) => {
        console.log('🚀 Dashboard requested start instance:', data.instanceId);
        instanceWS.sendToInstance(data.instanceId, 'start-processing', {});
        socket.emit('notification', {
            message: `درخواست شروع instance ${data.instanceId} ارسال شد`,
            type: 'info'
        });
    });

    socket.on('stop-instance', (data) => {
        console.log('⏹️ Dashboard requested stop instance:', data.instanceId);
        instanceWS.sendToInstance(data.instanceId, 'stop-processing', {});
        socket.emit('notification', {
            message: `درخواست توقف instance ${data.instanceId} ارسال شد`,
            type: 'warning'
        });
    });

    socket.on('disconnect', (reason) => {
        console.log('📊 Dashboard client disconnected:', socket.id, 'Reason:', reason);
    });
});


setInterval(async () => {
    try {
        if (dashboardIO.sockets.size > 0) {
            console.log(`🔄 Broadcasting stats to ${dashboardIO.sockets.size} dashboard clients...`);

            // مستقیماً از دیتابیس بخوانیم
            const Account = require('./models/Account');
            const Proxy = require('./models/Proxy');

            const [accountCount, proxyCount] = await Promise.all([
                Account.countDocuments({}),
                Proxy.countDocuments({})
            ]);

            console.log('📊 Broadcast counts:', { accounts: accountCount, proxies: proxyCount });

            const systemStats = {
                accounts: {
                    total: accountCount,
                    pending: await Account.countDocuments({ status: 'pending' }),
                    processing: 0,
                    completed: 0,
                    failed: 0,
                    results: {
                        good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0,
                        error: 0, lock: 0, guard: 0, 'change-pass': 0,
                        'mobile-2step': 0, timeout: 0, 'server-error': 0
                    }
                },
                proxies: {
                    total: proxyCount,
                    active: proxyCount,
                    available: proxyCount,
                    used: 0,
                    failed: 0,
                    avgResponseTime: 0,
                    successRate: 100,
                    lastUpdate: new Date()
                }
            };

            const responseData = {
                system: systemStats,
                instances: instanceWS.getConnectedInstancesStats(),
                proxyService: proxyUpdaterService.getStatus(),
                timestamp: Date.now()
            };

            dashboardIO.emit('stats-update', responseData);
            console.log('📊 ✅ Broadcast completed');
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
    console.log(`💾 MongoDB: ${process.env.MONGODB_URI}`);
    console.log(`🔴 Redis: ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
    console.log('='.repeat(60));
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

    // Stop proxy updater
    proxyUpdaterService.stop();

    server.close(() => {
        console.log('✅ HTTP server closed');

        // Close database connections
        require('mongoose').connection.close(() => {
            console.log('✅ MongoDB connection closed');

            // Close Redis connections
            const { redis, redisStats, redisPubSub } = require('./config/redis');
            Promise.all([
                redis.quit(),
                redisStats.quit(),
                redisPubSub.quit()
            ]).then(() => {
                console.log('✅ Redis connections closed');
                console.log('✅ Graceful shutdown completed');
                process.exit(0);
            }).catch((err) => {
                console.error('❌ Error closing Redis connections:', err);
                process.exit(1);
            });
        });
    });
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