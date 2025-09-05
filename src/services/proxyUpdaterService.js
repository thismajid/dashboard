const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const path = require('path');
const cron = require('node-cron');
const ProxyModel = require('../models/knex/Proxy'); // استفاده از ProxyModel ریفکتور شده
const { db } = require('../config/database');

class ProxyUpdaterService extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.worker = null;
        this.cronJob = null;

        this.config = {
            apiKey: process.env.PROXY_API_KEY || '14vamdyyof&pack=2',
            maxResponseTime: parseInt(process.env.MAX_PROXY_RESPONSE_TIME) || 200,
            concurrency: parseInt(process.env.PROXY_TEST_CONCURRENCY) || 100,
            timeout: parseInt(process.env.PROXY_TEST_TIMEOUT) || 5000,
            testUrl: process.env.PROXY_TEST_URL || 'https://my.account.sony.com'
        };

        this.stats = {
            lastUpdate: null,
            nextUpdate: null,
            totalProxies: 0,
            activeProxies: 0,
            isUpdating: false,
            lastError: null,
            successRate: 0,
            avgResponseTime: 0
        };

        console.log('🌐 ProxyUpdaterService initialized with config:', {
            ...this.config,
            apiKey: this.config.apiKey ? '***masked***' : 'not set'
        });
    }

    start() {
        if (this.isRunning) {
            console.log('⚠️ ProxyUpdaterService is already running');
            return;
        }

        this.isRunning = true;
        console.log('🚀 Starting ProxyUpdaterService...');

        // شروع فوری (با تأخیر کوتاه برای اطمینان از آماده بودن سیستم)
        setTimeout(() => {
            this.triggerUpdate();
        }, 5000);

        // تنظیم cron job برای اجرا در دقیقه 0 و 25 هر ساعت
        // '0,25 * * * *' = دقیقه 0 و 25 از هر ساعت
        this.cronJob = cron.schedule('0,25 * * * *', () => {
            const now = new Date();
            console.log(`⏰ Scheduled proxy update triggered at: ${now.toLocaleString('fa-IR')}`);
            this.triggerUpdate();
        }, {
            scheduled: true,
            timezone: "Asia/Tehran" // تنظیم منطقه زمانی ایران
        });

        // محاسبه زمان آپدیت بعدی
        this.calculateNextUpdate();

        console.log(`✅ ProxyUpdaterService started - Updates scheduled for :00 and :30 of every hour`);
        console.log(`📅 Next update: ${this.stats.nextUpdate?.toLocaleString('fa-IR')}`);

        // لود کردن آمار فعلی
        this.loadCurrentStats();
    }

    stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        console.log('🛑 Stopping ProxyUpdaterService...');

        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob.destroy();
            this.cronJob = null;
        }

        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }

        console.log('✅ ProxyUpdaterService stopped');
    }

    // محاسبه زمان آپدیت بعدی
    calculateNextUpdate() {
        const now = new Date();
        const currentMinute = now.getMinutes();
        const currentHour = now.getHours();

        let nextHour = currentHour;
        let nextMinute;

        if (currentMinute < 30) {
            // اگر قبل از 30 دقیقه هستیم، آپدیت بعدی در دقیقه 30 همین ساعت
            nextMinute = 30;
        } else {
            // اگر بعد از 30 دقیقه هستیم، آپدیت بعدی در دقیقه 0 ساعت بعد
            nextMinute = 0;
            nextHour = (currentHour + 1) % 24;
        }

        const nextUpdate = new Date();
        nextUpdate.setHours(nextHour, nextMinute, 0, 0);

        // اگر زمان محاسبه شده در گذشته است، یک روز اضافه کن
        if (nextUpdate <= now) {
            nextUpdate.setDate(nextUpdate.getDate() + 1);
        }

        this.stats.nextUpdate = nextUpdate;
    }

    // لود کردن آمار فعلی از دیتابیس
    async loadCurrentStats() {
        try {
            const totalCount = await ProxyModel.countDocuments({ status: 'active' });
            const avgResult = await ProxyModel.query()
                .where('status', 'active')
                .whereNotNull('responseTime')
                .where('responseTime', '>', 0)
                .avg('responseTime as avg');

            this.stats.totalProxies = totalCount;
            this.stats.activeProxies = totalCount;
            this.stats.avgResponseTime = avgResult[0]?.avg ? Math.round(avgResult[0].avg) : 0;
            this.stats.successRate = 100; // فعلاً همه پروکسی‌های موجود فعال هستن

            console.log(`📊 Current proxy stats loaded: ${totalCount} active proxies, avg response time: ${this.stats.avgResponseTime}ms`);
        } catch (error) {
            console.error('❌ Error loading current stats:', error);
        }
    }

    async triggerUpdate() {
        if (this.stats.isUpdating) {
            console.log('⚠️ Proxy update already in progress, skipping...');
            return;
        }

        try {
            const now = new Date();
            console.log(`🔄 Starting scheduled proxy update at: ${now.toLocaleString('fa-IR')}`);

            this.stats.isUpdating = true;
            this.stats.lastError = null;

            this.emit('update-started', {
                timestamp: now,
                message: 'شروع به‌روزرسانی پروکسی‌ها'
            });

            await this.updateProxies();

        } catch (error) {
            console.error('❌ Proxy update failed:', error);
            this.stats.lastError = error.message;
            this.emit('update-failed', {
                message: `خطا در به‌روزرسانی پروکسی‌ها: ${error.message}`,
                error: error.message,
                timestamp: new Date()
            });
        } finally {
            this.stats.isUpdating = false;
            this.stats.lastUpdate = new Date();
            this.calculateNextUpdate(); // محاسبه مجدد زمان آپدیت بعدی

            console.log(`📅 Next proxy update scheduled for: ${this.stats.nextUpdate?.toLocaleString('fa-IR')}`);
        }
    }

    async updateProxies() {
        return new Promise((resolve, reject) => {
            console.log('🌐 Fetching proxies from API...');

            // ایجاد worker thread
            this.worker = new Worker(path.join(__dirname, '../workers/proxyWorker.js'), {
                workerData: {
                    config: this.config
                }
            });

            // تنظیم timeout برای worker
            const workerTimeout = setTimeout(() => {
                if (this.worker) {
                    this.worker.terminate();
                    this.worker = null;
                    reject(new Error('Worker timeout after 10 minutes'));
                }
            }, 10 * 60 * 1000); // 10 دقیقه

            this.worker.on('message', async (message) => {
                try {
                    if (message.type === 'progress') {
                        console.log(`📊 Proxy test progress: ${message.tested}/${message.total} (${message.working} working)`);

                        this.emit('update-progress', {
                            tested: message.tested,
                            total: message.total,
                            working: message.working,
                            percentage: message.total > 0 ? Math.round((message.tested / message.total) * 100) : 0
                        });

                    } else if (message.type === 'completed') {
                        clearTimeout(workerTimeout);
                        console.log(`✅ Proxy testing completed: ${message.workingProxies.length} working proxies found`);

                        // ذخیره پروکسی‌ها در دیتابیس
                        const savedCount = await this.saveProxiesToDatabase(message.workingProxies);

                        this.stats.totalProxies = message.total || 0;
                        this.stats.activeProxies = savedCount;
                        this.stats.successRate = this.stats.totalProxies > 0 ?
                            Math.round((this.stats.activeProxies / this.stats.totalProxies) * 100) : 0;

                        // محاسبه میانگین زمان پاسخ
                        if (message.workingProxies.length > 0) {
                            const totalResponseTime = message.workingProxies.reduce((sum, p) => sum + (p.responseTime || 0), 0);
                            this.stats.avgResponseTime = Math.round(totalResponseTime / message.workingProxies.length);
                        }

                        this.emit('update-completed', {
                            message: `${savedCount} پروکسی فعال ذخیره شد`,
                            stats: {
                                total: this.stats.totalProxies,
                                active: this.stats.activeProxies,
                                successRate: this.stats.successRate,
                                avgResponseTime: this.stats.avgResponseTime
                            },
                            timestamp: new Date()
                        });

                        this.worker = null;
                        resolve();

                    } else if (message.type === 'error') {
                        clearTimeout(workerTimeout);
                        console.error('❌ Worker error:', message.error);
                        this.worker = null;
                        reject(new Error(message.error));
                    }
                } catch (error) {
                    clearTimeout(workerTimeout);
                    console.error('❌ Error processing worker message:', error);
                    this.worker = null;
                    reject(error);
                }
            });

            this.worker.on('error', (error) => {
                clearTimeout(workerTimeout);
                console.error('❌ Worker thread error:', error);
                this.worker = null;
                reject(error);
            });

            this.worker.on('exit', (code) => {
                clearTimeout(workerTimeout);
                if (code !== 0) {
                    console.error(`❌ Worker stopped with exit code ${code}`);
                    this.worker = null;
                    reject(new Error(`Worker stopped with exit code ${code}`));
                }
            });
        });
    }

    async saveProxiesToDatabase(workingProxies) {
        const trx = await db().transaction();

        try {
            console.log(`💾 Starting transaction to save ${workingProxies.length} working proxies...`);

            // فیلتر و مرتب‌سازی پروکسی‌ها
            const validProxies = workingProxies
                .filter(proxy => {
                    // بررسی معتبر بودن داده‌های پروکسی
                    return proxy.host &&
                        proxy.port &&
                        !isNaN(parseInt(proxy.port))
                })
                .sort((a, b) => {
                    // مرتب‌سازی بر اساس سرعت (کمترین زمان پاسخ اول)
                    const timeA = a.responseTime || 9999;
                    const timeB = b.responseTime || 9999;
                    return timeA - timeB;
                });

            console.log(`🔄 Filtered and sorted ${validProxies.length} valid proxies by response time`);

            if (validProxies.length === 0) {
                console.warn('⚠️ No valid proxies to save');
                await trx.rollback();
                return 0;
            }

            // مرحله 1: حذف تمام پروکسی‌های موجود
            console.log(`🗑️ Deleting all existing proxies...`);
            const deletedCount = await trx('Proxies').del();
            console.log(`🗑️ Deleted ${deletedCount} existing proxies`);

            // آماده‌سازی داده‌های جدید برای درج
            const newProxies = validProxies.map(proxyData => ({
                host: proxyData.host.trim(),
                port: parseInt(proxyData.port),
                username: proxyData.username?.trim() || null,
                password: proxyData.password?.trim() || null,
                protocol: proxyData.protocol || 'http',
                status: 'active',
                responseTime: Math.round(proxyData.responseTime) || 0,
                source: 'api',
                created_at: new Date(),
                updated_at: new Date()
            }));

            // مرحله 2: درج پروکسی‌های جدید به صورت batch
            console.log(`📥 Inserting ${newProxies.length} new proxies...`);

            let insertedProxies = [];
            const chunkSize = 500;

            for (let i = 0; i < newProxies.length; i += chunkSize) {
                const chunk = newProxies.slice(i, i + chunkSize);

                const insertedChunk = await trx('Proxies')
                    .insert(chunk)
                    .onConflict(['host', 'port'])
                    .merge()
                    .returning('*');

                insertedProxies.push(...insertedChunk);

                console.log(`📊 Inserted chunk ${Math.floor(i / chunkSize) + 1}: ${insertedChunk.length} proxies`);
            }

            // Commit تراکنش
            await trx.commit();

            const savedCount = insertedProxies.length;
            console.log(`✅ Transaction completed successfully: ${savedCount} proxies saved and sorted by speed`);

            // نمایش آمار سرعت
            if (savedCount > 0) {
                const fastestProxy = insertedProxies[0];
                const slowestProxy = insertedProxies[savedCount - 1];
                console.log(`🚀 Fastest proxy: ${fastestProxy.host}:${fastestProxy.port} (${fastestProxy.responseTime}ms)`);
                console.log(`🐌 Slowest proxy: ${slowestProxy.host}:${slowestProxy.port} (${slowestProxy.responseTime}ms)`);

                // آمار اضافی
                const avgResponseTime = insertedProxies.reduce((sum, p) => sum + (p.responseTime || 0), 0) / savedCount;
                console.log(`📊 Average response time: ${Math.round(avgResponseTime)}ms`);
                console.log(`📊 Response time range: ${fastestProxy.responseTime}ms - ${slowestProxy.responseTime}ms`);
            }

            return savedCount;

        } catch (error) {
            // Rollback تراکنش در صورت خطا
            await trx.rollback();
            console.error('❌ Transaction failed, rolled back. Error saving proxies:', error);
            throw error;
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            isUpdating: this.stats.isUpdating,
            lastUpdate: this.stats.lastUpdate,
            nextUpdate: this.stats.nextUpdate,
            lastError: this.stats.lastError,
            stats: {
                total: this.stats.totalProxies,
                active: this.stats.activeProxies,
                successRate: this.stats.successRate,
                avgResponseTime: this.stats.avgResponseTime
            },
            config: {
                maxResponseTime: this.config.maxResponseTime,
                concurrency: this.config.concurrency,
                timeout: this.config.timeout,
                testUrl: this.config.testUrl,
                apiKey: this.config.apiKey ? '***masked***' : 'not set',
                schedule: 'Every 30 minutes (:00 and :30)'
            },
            workerStatus: this.worker ? 'running' : 'stopped',
            uptime: this.isRunning ? Date.now() - (this.stats.lastUpdate || Date.now()) : 0
        };
    }

    // متد برای دریافت پروکسی بعدی
    async getNextProxy() {
        try {
            const proxy = await ProxyModel.query()
                .where('status', 'active')
                .orderBy('usageCount', 'asc')
                .orderBy('responseTime', 'asc')
                .first();

            if (!proxy) {
                return null;
            }

            // افزایش تعداد استفاده
            await ProxyModel.findByIdAndUpdate(proxy.id, {
                usageCount: (proxy.usageCount || 0) + 1,
                lastUsedAt: new Date()
            });

            return {
                id: proxy.id,
                host: proxy.host,
                port: proxy.port,
                username: proxy.username,
                password: proxy.password,
                protocol: proxy.protocol || 'http',
                responseTime: proxy.responseTime,
                url: this.buildProxyUrl(proxy)
            };

        } catch (error) {
            console.error('❌ Error getting next proxy:', error);
            return null;
        }
    }

    // ساخت URL پروکسی
    buildProxyUrl(proxy) {
        const auth = proxy.username && proxy.password ?
            `${proxy.username}:${proxy.password}@` : '';
        const protocol = proxy.protocol || 'http';
        return `${protocol}://${auth}${proxy.host}:${proxy.port}`;
    }

    // متد برای گزارش نتیجه استفاده از پروکسی
    async reportProxyResult(proxyHost, proxyPort, success, responseTime = null) {
        try {
            const updateData = {
                lastUsedAt: new Date(),
                updated_at: new Date()
            };

            if (success) {
                updateData.successCount = ProxyModel.db().raw('COALESCE(success_count, 0) + 1');
                if (responseTime !== null) {
                    updateData.lastResponseTime = responseTime;
                }
            } else {
                updateData.failureCount = ProxyModel.db().raw('COALESCE(failure_count, 0) + 1');
            }

            await ProxyModel.updateMany(
                { host: proxyHost, port: proxyPort },
                updateData
            );

            console.log(`📊 Proxy result reported: ${proxyHost}:${proxyPort} - ${success ? 'SUCCESS' : 'FAILED'}`);

        } catch (error) {
            console.error('❌ Error reporting proxy result:', error);
        }
    }

    // متد برای اجرای دستی آپدیت
    async manualUpdate() {
        console.log('🔧 Manual proxy update triggered');

        if (this.stats.isUpdating) {
            throw new Error('Proxy update is already in progress');
        }

        await this.triggerUpdate();
        return this.getStatus();
    }

    // متد برای دریافت آمار پروکسی‌ها
    async getProxyStats() {
        try {
            const stats = await ProxyModel.getProxyStats();
            return {
                ...stats,
                lastUpdate: this.stats.lastUpdate,
                nextUpdate: this.stats.nextUpdate,
                isUpdating: this.stats.isUpdating
            };
        } catch (error) {
            console.error('❌ Error getting proxy stats:', error);
            return {
                total: 0,
                available: 0,
                avgResponseTime: 0,
                lastUpdate: this.stats.lastUpdate,
                nextUpdate: this.stats.nextUpdate,
                isUpdating: this.stats.isUpdating
            };
        }
    }

    // متد برای پاک‌سازی پروکسی‌های قدیمی
    async cleanupOldProxies(olderThanHours = 24) {
        try {
            const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));

            const deletedCount = await ProxyModel.deleteMany({
                created_at: { '<': cutoffTime },
                status: 'inactive'
            });

            if (deletedCount > 0) {
                console.log(`🧹 Cleaned up ${deletedCount} old inactive proxies`);
                await this.loadCurrentStats(); // به‌روزرسانی آمار
            }

            return deletedCount;
        } catch (error) {
            console.error('❌ Error cleaning up old proxies:', error);
            return 0;
        }
    }

    // متد برای تست یک پروکسی خاص
    async testSingleProxy(proxyString) {
        try {
            // استفاده از proxyService برای تست
            const proxyService = require('./proxyService');
            return await proxyService.testSingleProxy(proxyString);
        } catch (error) {
            console.error('❌ Error testing single proxy:', error);
            return {
                success: false,
                error: error.message,
                responseTime: null
            };
        }
    }

    // متد برای restart کردن سرویس
    async restart() {
        console.log('🔄 Restarting ProxyUpdaterService...');

        this.stop();

        // تأخیر کوتاه قبل از شروع مجدد
        await new Promise(resolve => setTimeout(resolve, 2000));

        this.start();

        console.log('✅ ProxyUpdaterService restarted successfully');
        return this.getStatus();
    }

    // متد برای دریافت تاریخچه آپدیت‌ها
    getUpdateHistory() {
        return {
            lastUpdate: this.stats.lastUpdate,
            nextUpdate: this.stats.nextUpdate,
            lastError: this.stats.lastError,
            isUpdating: this.stats.isUpdating,
            schedule: 'Every 30 minutes (:00 and :30)',
            timezone: 'Asia/Tehran'
        };
    }
}

module.exports = new ProxyUpdaterService();