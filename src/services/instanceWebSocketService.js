const socketIo = require('socket.io');
const accountService = require('./accountService');
const proxyService = require('./proxyService');
const statsService = require('./statsService');

class InstanceWebSocketService {
    constructor(server) {
        console.log('🔧 Setting up WebSocket on path: /instance-socket');

        this.instanceIO = socketIo(server, {
            path: '/instance-socket',
            cors: {
                origin: "*",
                methods: ["GET", "POST"],
                credentials: false
            },
            transports: ['polling', 'websocket'], // اول polling سپس websocket
            allowEIO3: true,
            pingTimeout: 60000, // 1 دقیقه
            pingInterval: 25000 // 25 ثانیه
        });

        // اضافه کردن لاگ اتصال
        this.instanceIO.engine.on("connection_error", (err) => {
            console.log('❌ Connection error:', err.req);
            console.log('❌ Error code:', err.code);
            console.log('❌ Error message:', err.message);
            console.log('❌ Error context:', err.context);
        });

        this.connectedInstances = new Map();
        this.setupEventHandlers();
        this.startMaintenanceTasks();

        console.log('✅ InstanceWebSocketService initialized successfully');
    }

    setupEventHandlers() {
        this.instanceIO.on('connection', (socket) => {
            console.log(`🔗 Instance connected: ${socket.id} from ${socket.handshake.address}`);

            socket.on('register-instance', async (data) => {
                try {
                    const { instanceId, serverInfo, capabilities } = data;

                    if (!instanceId) {
                        socket.emit('registration-error', { error: 'instanceId is required' });
                        return;
                    }

                    const instanceData = {
                        socketId: socket.id,
                        instanceId: instanceId,
                        serverInfo: serverInfo || {},
                        capabilities: capabilities || { batchSize: 2 },
                        status: 'idle',
                        lastHeartbeat: Date.now(),
                        connectedAt: Date.now(),
                        processedCount: 0,
                        successCount: 0,
                        failedCount: 0,
                        currentBatch: null,
                        totalUptime: 0,
                        errors: []
                    };

                    this.connectedInstances.set(socket.id, instanceData);

                    // ثبت در statsService
                    const registered = await statsService.registerInstance(instanceId);
                    if (!registered) {
                        console.warn(`⚠️ Failed to register instance ${instanceId} in stats`);
                    }

                    // به‌روزرسانی اطلاعات instance در statsService
                    await statsService.updateInstance(instanceId, {
                        status: 'idle',
                        processedCount: 0,
                        successCount: 0,
                        failedCount: 0,
                        serverInfo: JSON.stringify(serverInfo || {}),
                        currentBatch: null
                    });

                    socket.emit('registration-confirmed', {
                        success: true,
                        instanceData: {
                            instanceId: instanceData.instanceId,
                            status: instanceData.status,
                            capabilities: instanceData.capabilities,
                            serverTime: new Date().toISOString()
                        }
                    });

                    console.log(`✅ Instance registered: ${instanceId} (${socket.id})`);

                    // ارسال کار اولیه با تأخیر
                    setTimeout(() => this.checkAndSendWork(socket), 1000);

                } catch (error) {
                    console.error('❌ خطا در ثبت instance:', error);
                    socket.emit('registration-error', {
                        error: error.message,
                        timestamp: Date.now()
                    });
                }
            });

            socket.on('request-work', async () => {
                await this.checkAndSendWork(socket);
            });

            socket.on('submit-results', async (data) => {
                try {
                    const instanceData = this.connectedInstances.get(socket.id);
                    if (!instanceData) {
                        socket.emit('error', {
                            message: 'Instance not registered',
                            code: 'INSTANCE_NOT_REGISTERED'
                        });
                        return;
                    }

                    const { results, proxyResult, batchInfo } = data;

                    // ثبت نتایج اکانت‌ها
                    if (results && results.length > 0) {
                        try {
                            await accountService.submitBatchResults(socket.id, results);

                            // آپدیت آمار local instance
                            const successCount = results.filter(r =>
                                ['good'].includes(r.status)
                            ).length;
                            const failedCount = results.length - successCount;

                            instanceData.processedCount += results.length;
                            instanceData.successCount += successCount;
                            instanceData.failedCount += failedCount;
                            instanceData.status = 'idle';
                            instanceData.currentBatch = null;
                            instanceData.lastHeartbeat = Date.now();

                            // آمار کلی سیستم
                            for (let i = 0; i < successCount; i++) {
                                await statsService.incrementProcessed(true);
                            }
                            for (let i = 0; i < failedCount; i++) {
                                await statsService.incrementProcessed(false);
                            }

                            // ثبت آمار عملکرد
                            if (batchInfo && batchInfo.processingTime) {
                                await statsService.recordPerformance(instanceData.instanceId, {
                                    batchSize: results.length,
                                    processingTime: batchInfo.processingTime,
                                    successRate: Math.round((successCount / results.length) * 100),
                                    avgResponseTime: results.reduce((sum, r) => sum + (r.responseTime || 0), 0) / results.length
                                });
                            }

                            // به‌روزرسانی آمار instance در Redis
                            await statsService.updateInstance(instanceData.instanceId, {
                                status: instanceData.status,
                                processedCount: instanceData.processedCount,
                                successCount: instanceData.successCount,
                                failedCount: instanceData.failedCount,
                                currentBatch: null
                            });

                        } catch (error) {
                            console.error('❌ خطا در ثبت نتایج اکانت‌ها:', error);
                            socket.emit('error', {
                                message: 'Failed to submit account results',
                                details: error.message
                            });
                            return;
                        }
                    }

                    // گزارش وضعیت پروکسی
                    if (proxyResult) {
                        try {
                            await proxyService.reportProxyStatus(
                                proxyResult.proxyId,
                                instanceData.instanceId,
                                proxyResult.success,
                                proxyResult.responseTime,
                                proxyResult.error
                            );
                        } catch (error) {
                            console.error('❌ خطا در گزارش وضعیت پروکسی:', error);
                        }
                    }

                    socket.emit('results-acknowledged', {
                        success: true,
                        processed: results?.length || 0,
                        successCount: results ? results.filter(r => ['good'].includes(r.status)).length : 0,
                        failedCount: results ? results.filter(r => !['good'].includes(r.status)).length : 0,
                        timestamp: Date.now()
                    });

                    console.log(`📊 Results from ${instanceData.instanceId}: ${results?.length || 0} accounts (${results ? results.filter(r => ['good'].includes(r.status)).length : 0} success)`);

                    // ارسال کار جدید با تأخیر کوتاه
                    setTimeout(() => this.checkAndSendWork(socket), 2000);

                } catch (error) {
                    console.error('❌ خطا در پردازش نتایج:', error);
                    socket.emit('error', {
                        message: error.message,
                        code: 'RESULTS_PROCESSING_ERROR',
                        timestamp: Date.now()
                    });
                }
            });

            socket.on('heartbeat', async (data) => {
                try {
                    const instanceData = this.connectedInstances.get(socket.id);
                    if (instanceData) {
                        instanceData.lastHeartbeat = Date.now();
                        instanceData.status = data.status || instanceData.status;

                        if (data.currentBatch) {
                            instanceData.currentBatch = data.currentBatch;
                        }

                        // آپدیت uptime
                        instanceData.totalUptime = Date.now() - instanceData.connectedAt;

                        // به‌روزرسانی در statsService
                        await statsService.updateInstance(instanceData.instanceId, {
                            status: instanceData.status,
                            processedCount: instanceData.processedCount,
                            successCount: instanceData.successCount,
                            failedCount: instanceData.failedCount,
                            uptime: instanceData.totalUptime,
                            currentBatch: instanceData.currentBatch ? JSON.stringify(instanceData.currentBatch) : null
                        });

                        socket.emit('heartbeat-ack', {
                            timestamp: Date.now(),
                            serverTime: new Date().toISOString(),
                            uptime: instanceData.totalUptime
                        });
                    }
                } catch (error) {
                    console.error('❌ خطا در پردازش heartbeat:', error);
                }
            });

            socket.on('error-report', async (data) => {
                try {
                    const instanceData = this.connectedInstances.get(socket.id);
                    if (instanceData) {
                        const errorEntry = {
                            ...data,
                            timestamp: Date.now()
                        };

                        instanceData.errors.push(errorEntry);

                        // نگه داشتن فقط 50 خطای آخر
                        if (instanceData.errors.length > 50) {
                            instanceData.errors = instanceData.errors.slice(-50);
                        }

                        console.warn(`⚠️ Error from ${instanceData.instanceId}:`, data);

                        // به‌روزرسانی وضعیت instance در صورت خطای جدی
                        if (data.severity === 'critical') {
                            instanceData.status = 'error';
                            await statsService.updateInstance(instanceData.instanceId, {
                                status: 'error'
                            });
                        }
                    }
                } catch (error) {
                    console.error('❌ خطا در پردازش گزارش خطا:', error);
                }
            });

            socket.on('disconnect', async (reason) => {
                try {
                    const instanceData = this.connectedInstances.get(socket.id);
                    if (instanceData) {
                        console.log(`❌ Instance disconnected: ${instanceData.instanceId} (${reason})`);

                        // آزادسازی منابع
                        try {
                            await accountService.releaseLockedAccounts(instanceData.instanceId);
                        } catch (error) {
                            console.error('❌ خطا در آزادسازی اکانت‌ها:', error);
                        }

                        try {
                            await statsService.unregisterInstance(instanceData.instanceId);
                        } catch (error) {
                            console.error('❌ خطا در حذف ثبت instance:', error);
                        }

                        this.connectedInstances.delete(socket.id);
                    }
                } catch (error) {
                    console.error('❌ خطا در پردازش قطع اتصال:', error);
                }
            });

            socket.on('connect_error', (error) => {
                console.error(`❌ Connection error from ${socket.id}:`, error);
            });
        });
    }

    /**
    * چک کردن و ارسال کار به instance
    */
    async checkAndSendWork(socket) {
        try {
            const instanceData = this.connectedInstances.get(socket.id);
            if (!instanceData || instanceData.status === 'working') {
                return;
            }

            const batchSize = instanceData.capabilities?.batchSize || 2;

            // دریافت اکانت‌ها
            const accounts = await accountService.getAccountBatch(instanceData.instanceId, batchSize);

            if (accounts.length === 0) {
                socket.emit('no-work-available', {
                    message: 'اکانتی برای پردازش موجود نیست',
                    retryAfter: 30000,
                    timestamp: Date.now()
                });
                return;
            }

            // دریافت پروکسی
            const proxy = await proxyService.getProxyForInstance(instanceData.instanceId);

            if (!proxy) {
                // آزاد کردن اکانت‌ها
                try {
                    await accountService.releaseAccountsByIds(accounts.map(a => a.id));
                } catch (error) {
                    console.error('❌ خطا در آزادسازی اکانت‌ها:', error);
                }

                socket.emit('no-proxy-available', {
                    message: 'پروکسی در دسترس نیست',
                    retryAfter: 60000,
                    timestamp: Date.now()
                });
                return;
            }

            // ارسال کار
            const workPackage = {
                accounts: accounts,
                proxy: proxy,
                batchId: accounts[0]?.batchId,
                timestamp: Date.now(),
                serverInfo: {
                    version: '1.0.0',
                    environment: process.env.NODE_ENV || 'development',
                    instanceId: instanceData.instanceId
                }
            };

            instanceData.status = 'working';
            instanceData.currentBatch = {
                accounts: accounts.length,
                batchId: workPackage.batchId,
                proxyId: proxy.id,
                accountIds: accounts.map(a => a.id)
            };

            // به‌روزرسانی وضعیت در statsService
            await statsService.updateInstance(instanceData.instanceId, {
                status: 'working',
                currentBatch: JSON.stringify(instanceData.currentBatch)
            });

            socket.emit('work-assigned', workPackage);

            console.log(`📦 Work sent to ${instanceData.instanceId}: ${accounts.length} accounts + proxy ${proxy.host}:${proxy.port}`);

        } catch (error) {
            console.error('❌ خطا در ارسال کار:', error);
            socket.emit('error', {
                message: error.message,
                type: 'WORK_ASSIGNMENT_ERROR',
                timestamp: Date.now()
            });
        }
    }

    /**
    * broadcast کردن پیام به همه instance ها
    */
    broadcastToInstances(event, data) {
        this.instanceIO.emit(event, {
            ...data,
            timestamp: Date.now(),
            server: process.env.NODE_ENV || 'development'
        });

        console.log(`📢 Broadcast to ${this.connectedInstances.size} instances: ${event}`);
    }

    /**
    * ارسال پیام به instance خاص
    */
    sendToInstance(instanceId, event, data) {
        for (const [socketId, instanceData] of this.connectedInstances.entries()) {
            if (instanceData.instanceId === instanceId) {
                const socket = this.instanceIO.sockets.sockets.get(socketId);
                if (socket) {
                    socket.emit(event, {
                        ...data,
                        timestamp: Date.now()
                    });
                    console.log(`📤 Message sent to ${instanceId}: ${event}`);
                    return true;
                }
            }
        }
        console.warn(`⚠️ Instance ${instanceId} not found for message: ${event}`);
        return false;
    }

    /**
    * دریافت آمار instance های متصل
    */
    getConnectedInstancesStats() {
        const instances = Array.from(this.connectedInstances.values());
        const now = Date.now();

        return {
            total: instances.length,
            idle: instances.filter(i => i.status === 'idle').length,
            working: instances.filter(i => i.status === 'working').length,
            error: instances.filter(i => i.status === 'error').length,
            instances: instances.map(i => ({
                instanceId: i.instanceId,
                status: i.status,
                processedCount: i.processedCount,
                successCount: i.successCount,
                failedCount: i.failedCount,
                successRate: i.processedCount > 0 ? Math.round((i.successCount / i.processedCount) * 100) : 0,
                connectedAt: i.connectedAt,
                lastHeartbeat: i.lastHeartbeat,
                uptime: now - i.connectedAt,
                currentBatch: i.currentBatch,
                serverInfo: i.serverInfo,
                capabilities: i.capabilities,
                recentErrors: i.errors.slice(-5), // 5 خطای آخر
                isHealthy: (now - i.lastHeartbeat) < 120000 // سالم اگر کمتر از 2 دقیقه پیش heartbeat داده
            }))
        };
    }

    /**
    * تسک‌های نگهداری
    */
    startMaintenanceTasks() {
        console.log('🔧 Starting maintenance tasks...');

        // چک کردن heartbeat هر دقیقه
        setInterval(async () => {
            await this.checkInstanceHeartbeats();
        }, 60000);

        // آزادسازی پروکسی‌های stuck هر 5 دقیقه
        setInterval(async () => {
            try {
                await proxyService.releaseStuckProxies(10);
            } catch (error) {
                console.error('❌ خطا در آزادسازی پروکسی‌های stuck:', error);
            }
        }, 5 * 60 * 1000);

        // پاک‌سازی آمار قدیمی هر ساعت
        setInterval(async () => {
            try {
                await statsService.cleanupOldStats(7);
            } catch (error) {
                console.error('❌ خطا در پاک‌سازی آمار قدیمی:', error);
            }
        }, 60 * 60 * 1000);

        // به‌روزرسانی آمار کلی هر 30 ثانیه
        setInterval(async () => {
            try {
                await this.updateSystemStats();
            } catch (error) {
                console.error('❌ خطا در به‌روزرسانی آمار سیستم:', error);
            }
        }, 30000);

        console.log('✅ Maintenance tasks started');
    }

    /**
    * چک کردن heartbeat instance ها
    */
    async checkInstanceHeartbeats() {
        const now = Date.now();
        const timeout = 3 * 60 * 1000; // 3 دقیقه
        const disconnectedInstances = [];

        for (const [socketId, instanceData] of this.connectedInstances.entries()) {
            if (now - instanceData.lastHeartbeat > timeout) {
                console.log(`💀 Instance timeout: ${instanceData.instanceId} (last heartbeat: ${new Date(instanceData.lastHeartbeat).toISOString()})`);
                disconnectedInstances.push({ socketId, instanceData });
            }
        }

        // پردازش instance های قطع شده
        for (const { socketId, instanceData } of disconnectedInstances) {
            try {
                // آزادسازی منابع
                await accountService.releaseLockedAccounts(instanceData.instanceId);
                await statsService.unregisterInstance(instanceData.instanceId);

                this.connectedInstances.delete(socketId);

                // قطع اتصال socket
                const socket = this.instanceIO.sockets.sockets.get(socketId);
                if (socket) {
                    socket.disconnect(true);
                }
            } catch (error) {
                console.error(`❌ خطا در پاک‌سازی instance ${instanceData.instanceId}:`, error);
            }
        }

        if (disconnectedInstances.length > 0) {
            console.log(`🧹 Cleaned up ${disconnectedInstances.length} timed-out instances`);
        }
    }

    /**
    * به‌روزرسانی آمار سیستم
    */
    async updateSystemStats() {
        try {
            const connectedStats = this.getConnectedInstancesStats();

            await statsService.updateStats({
                connectedInstances: connectedStats.total,
                workingInstances: connectedStats.working,
                idleInstances: connectedStats.idle,
                errorInstances: connectedStats.error
            });
        } catch (error) {
            console.error('❌ خطا در به‌روزرسانی آمار سیستم:', error);
        }
    }

    /**
    * آمار کلی سیستم
    */
    async getSystemHealth() {
        try {
            const [accountStats, proxyStats, instanceStats, systemStats] = await Promise.all([
                accountService.getStats(),
                proxyService.getProxyStats(),
                this.getConnectedInstancesStats(),
                statsService.getStats()
            ]);

            return {
                accounts: accountStats,
                proxies: proxyStats,
                instances: instanceStats,
                system: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    nodeVersion: process.version,
                    platform: process.platform,
                    stats: systemStats
                },
                timestamp: Date.now(),
                healthy: this.isSystemHealthy(accountStats, proxyStats, instanceStats)
            };
        } catch (error) {
            console.error('❌ خطا در دریافت وضعیت سیستم:', error);
            return {
                error: error.message,
                timestamp: Date.now(),
                healthy: false
            };
        }
    }

    /**
    * بررسی سلامت سیستم
    */
    isSystemHealthy(accountStats, proxyStats, instanceStats) {
        try {
            // بررسی وجود instance های فعال
            if (instanceStats.total === 0) return false;

            // بررسی وجود پروکسی
            if (proxyStats.total === 0) return false;

            // بررسی وجود اکانت برای پردازش
            if (accountStats.accounts && accountStats.accounts.pending === 0 && accountStats.accounts.processing === 0) {
                return true; // اگر کاری نباشه، سیستم سالم هست
            }

            // بررسی instance های سالم
            const healthyInstances = instanceStats.instances.filter(i => i.isHealthy).length;
            const healthyRatio = healthyInstances / instanceStats.total;

            return healthyRatio >= 0.5; // حداقل 50% instance ها سالم باشن
        } catch (error) {
            console.error('❌ خطا در بررسی سلامت سیستم:', error);
            return false;
        }
    }

    /**
    * اجبار قطع اتصال instance
    */
    forceDisconnectInstance(instanceId) {
        for (const [socketId, instanceData] of this.connectedInstances.entries()) {
            if (instanceData.instanceId === instanceId) {
                const socket = this.instanceIO.sockets.sockets.get(socketId);
                if (socket) {
                    socket.disconnect(true);
                    console.log(`🔌 Force disconnected instance: ${instanceId}`);
                    return true;
                }
            }
        }
        return false;
    }

    /**
    * دریافت اطلاعات instance خاص
    */
    getInstanceInfo(instanceId) {
        for (const instanceData of this.connectedInstances.values()) {
            if (instanceData.instanceId === instanceId) {
                return {
                    ...instanceData,
                    uptime: Date.now() - instanceData.connectedAt,
                    isHealthy: (Date.now() - instanceData.lastHeartbeat) < 120000
                };
            }
        }
        return null;
    }
}

module.exports = InstanceWebSocketService;