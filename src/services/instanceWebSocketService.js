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
            allowEIO3: true
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
                        currentBatch: null,
                        totalUptime: 0,
                        errors: []
                    };

                    this.connectedInstances.set(socket.id, instanceData);
                    await statsService.registerInstance(instanceId);

                    socket.emit('registration-confirmed', {
                        success: true,
                        instanceData: {
                            instanceId: instanceData.instanceId,
                            status: instanceData.status,
                            capabilities: instanceData.capabilities
                        }
                    });

                    console.log(`✅ Instance registered: ${instanceId} (${socket.id})`);

                    // ارسال کار اولیه
                    setTimeout(() => this.checkAndSendWork(socket), 1000);

                } catch (error) {
                    console.error('خطا در ثبت instance:', error);
                    socket.emit('registration-error', { error: error.message });
                }
            });

            socket.on('request-work', async () => {
                await this.checkAndSendWork(socket);
            });

            socket.on('submit-results', async (data) => {
                try {
                    const instanceData = this.connectedInstances.get(socket.id);
                    if (!instanceData) {
                        socket.emit('error', { message: 'Instance not registered' });
                        return;
                    }

                    const { results, proxyResult, batchInfo } = data;

                    // ثبت نتایج اکانت‌ها
                    if (results && results.length > 0) {
                        await accountService.submitBatchResults(instanceData.instanceId, results);

                        instanceData.processedCount += results.length;
                        instanceData.status = 'idle';
                        instanceData.currentBatch = null;

                        // آمار کلی
                        const successCount = results.filter(r =>
                            ['good'].includes(r.status)
                        ).length;

                        for (let i = 0; i < successCount; i++) {
                            await statsService.incrementProcessed(true);
                        }
                        for (let i = 0; i < results.length - successCount; i++) {
                            await statsService.incrementProcessed(false);
                        }

                        // ثبت آمار عملکرد
                        if (batchInfo) {
                            await statsService.recordPerformance(instanceData.instanceId, {
                                batchSize: results.length,
                                processingTime: batchInfo.processingTime,
                                successRate: Math.round((successCount / results.length) * 100),
                                avgResponseTime: results.reduce((sum, r) => sum + (r.responseTime || 0), 0) / results.length
                            });
                        }
                    }

                    // گزارش وضعیت پروکسی
                    if (proxyResult) {
                        await proxyService.reportProxyStatus(
                            proxyResult.proxyId,
                            instanceData.instanceId,
                            proxyResult.success,
                            proxyResult.responseTime,
                            proxyResult.error
                        );
                    }

                    socket.emit('results-acknowledged', {
                        success: true,
                        processed: results?.length || 0,
                        timestamp: Date.now()
                    });

                    console.log(`📊 Results from ${instanceData.instanceId}: ${results?.length || 0} accounts`);

                    // ارسال کار جدید
                    setTimeout(() => this.checkAndSendWork(socket), 2000);

                } catch (error) {
                    console.error('خطا در ثبت نتایج:', error);
                    socket.emit('error', { message: error.message });
                }
            });

            socket.on('heartbeat', async (data) => {
                const instanceData = this.connectedInstances.get(socket.id);
                if (instanceData) {
                    instanceData.lastHeartbeat = Date.now();
                    instanceData.status = data.status || instanceData.status;

                    if (data.currentBatch) {
                        instanceData.currentBatch = data.currentBatch;
                    }

                    await statsService.updateInstance(instanceData.instanceId, {
                        status: instanceData.status,
                        processedCount: instanceData.processedCount,
                        currentBatch: instanceData.currentBatch
                    });

                    socket.emit('heartbeat-ack', {
                        timestamp: Date.now(),
                        serverTime: new Date().toISOString()
                    });
                }
            });

            socket.on('error-report', async (data) => {
                const instanceData = this.connectedInstances.get(socket.id);
                if (instanceData) {
                    instanceData.errors.push({
                        ...data,
                        timestamp: Date.now()
                    });

                    // نگه داشتن فقط 50 خطای آخر
                    if (instanceData.errors.length > 50) {
                        instanceData.errors = instanceData.errors.slice(-50);
                    }

                    console.warn(`⚠️ Error from ${instanceData.instanceId}:`, data);
                }
            });

            socket.on('disconnect', async (reason) => {
                const instanceData = this.connectedInstances.get(socket.id);
                if (instanceData) {
                    console.log(`❌ Instance disconnected: ${instanceData.instanceId} (${reason})`);

                    // آزادسازی منابع
                    await accountService.releaseLockedAccounts(instanceData.instanceId);
                    await statsService.unregisterInstance(instanceData.instanceId);

                    this.connectedInstances.delete(socket.id);
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
                await accountService.releaseAccountsByIds(accounts.map(a => a.id));

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
                    environment: process.env.NODE_ENV || 'development'
                }
            };

            instanceData.status = 'working';
            instanceData.currentBatch = {
                accounts: accounts.length,
                batchId: workPackage.batchId,
                startedAt: Date.now(),
                proxyId: proxy.id
            };

            socket.emit('work-assigned', workPackage);

            console.log(`📦 Work sent to ${instanceData.instanceId}: ${accounts.length} accounts + proxy ${proxy.host}:${proxy.port}`);

        } catch (error) {
            console.error('خطا در ارسال کار:', error);
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
                    return true;
                }
            }
        }
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
            instances: instances.map(i => ({
                instanceId: i.instanceId,
                status: i.status,
                processedCount: i.processedCount,
                connectedAt: i.connectedAt,
                lastHeartbeat: i.lastHeartbeat,
                uptime: now - i.connectedAt,
                currentBatch: i.currentBatch,
                serverInfo: i.serverInfo,
                capabilities: i.capabilities,
                recentErrors: i.errors.slice(-5) // 5 خطای آخر
            }))
        };
    }

    /**
    * تسک‌های نگهداری
    */
    startMaintenanceTasks() {
        // چک کردن heartbeat هر دقیقه
        setInterval(async () => {
            await this.checkInstanceHeartbeats();
        }, 60000);

        // آزادسازی پروکسی‌های stuck هر 5 دقیقه
        setInterval(async () => {
            await proxyService.releaseStuckProxies(10);
        }, 5 * 60 * 1000);

        // پاک‌سازی آمار قدیمی هر ساعت
        setInterval(async () => {
            await statsService.cleanupOldStats(7);
        }, 60 * 60 * 1000);
    }

    /**
    * چک کردن heartbeat instance ها
    */
    async checkInstanceHeartbeats() {
        const now = Date.now();
        const timeout = 3 * 60 * 1000; // 3 دقیقه

        for (const [socketId, instanceData] of this.connectedInstances.entries()) {
            if (now - instanceData.lastHeartbeat > timeout) {
                console.log(`💀 Instance timeout: ${instanceData.instanceId}`);

                // آزادسازی منابع
                await accountService.releaseLockedAccounts(instanceData.instanceId);
                await statsService.unregisterInstance(instanceData.instanceId);

                this.connectedInstances.delete(socketId);

                // قطع اتصال socket
                const socket = this.instanceIO.sockets.sockets.get(socketId);
                if (socket) {
                    socket.disconnect(true);
                }
            }
        }
    }

    /**
    * آمار کلی سیستم
    */
    async getSystemHealth() {
        try {
            const [accountStats, proxyStats, instanceStats] = await Promise.all([
                accountService.getStats(),
                proxyService.getProxyStats(),
                this.getConnectedInstancesStats()
            ]);

            return {
                accounts: accountStats,
                proxies: proxyStats,
                instances: instanceStats,
                system: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    nodeVersion: process.version,
                    platform: process.platform
                },
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('خطا در دریافت وضعیت سیستم:', error);
            return null;
        }
    }
}


module.exports = InstanceWebSocketService;
