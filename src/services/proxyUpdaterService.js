const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const path = require('path');
const mongoose = require('mongoose');
const cron = require('node-cron');
const Proxy = require('../models/Proxy');

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
            lastError: null
        };

        console.log('🌐 ProxyUpdaterService initialized with config:', this.config);
    }

    start() {
        if (this.isRunning) {
            console.log('⚠️ ProxyUpdaterService is already running');
            return;
        }

        this.isRunning = true;
        console.log('🚀 Starting ProxyUpdaterService...');

        // شروع فوری
        this.triggerUpdate();

        // تنظیم cron job برای اجرا در دقیقه 0 و 30 هر ساعت
        // '0,30 * * * *' = دقیقه 0 و 30 از هر ساعت
        this.cronJob = cron.schedule('0,30 * * * *', () => {
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

            this.emit('update-started');

            await this.updateProxies();

        } catch (error) {
            console.error('❌ Proxy update failed:', error);
            this.stats.lastError = error.message;
            this.emit('update-failed', {
                message: `خطا در به‌روزرسانی پروکسی‌ها: ${error.message}`,
                error: error
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

            this.worker.on('message', async (message) => {
                try {
                    if (message.type === 'progress') {
                        console.log(`📊 Proxy test progress: ${message.tested}/${message.total} (${message.working} working)`);

                    } else if (message.type === 'completed') {
                        console.log(`✅ Proxy testing completed: ${message.workingProxies.length} working proxies found`);

                        // ذخیره پروکسی‌ها در دیتابیس
                        await this.saveProxiesToDatabase(message.workingProxies);

                        this.stats.totalProxies = message.total || 0;
                        this.stats.activeProxies = message.workingProxies.length;

                        this.emit('update-completed', {
                            message: `${message.workingProxies.length} پروکسی فعال پیدا شد`,
                            stats: {
                                total: this.stats.totalProxies,
                                active: this.stats.activeProxies,
                                successRate: this.stats.totalProxies > 0 ?
                                    Math.round((this.stats.activeProxies / this.stats.totalProxies) * 100) : 0
                            }
                        });

                        this.worker = null;
                        resolve();

                    } else if (message.type === 'error') {
                        console.error('❌ Worker error:', message.error);
                        this.worker = null;
                        reject(new Error(message.error));
                    }
                } catch (error) {
                    console.error('❌ Error processing worker message:', error);
                    reject(error);
                }
            });

            this.worker.on('error', (error) => {
                console.error('❌ Worker thread error:', error);
                this.worker = null;
                reject(error);
            });

            this.worker.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`❌ Worker stopped with exit code ${code}`);
                    this.worker = null;
                    reject(new Error(`Worker stopped with exit code ${code}`));
                }
            });
        });
    }

    async saveProxiesToDatabase(workingProxies) {
        try {
            console.log(`💾 Saving ${workingProxies.length} working proxies to database...`);

            // مرتب‌سازی پروکسی‌ها بر اساس سرعت (کمترین زمان پاسخ اول)
            const sortedProxies = workingProxies
                .filter(proxy => proxy.host && proxy.port) // فقط پروکسی‌های معتبر
                .sort((a, b) => {
                    const timeA = a.responseTime || 9999;
                    const timeB = b.responseTime || 9999;
                    return timeA - timeB;
                });

            console.log(`🔄 Sorted ${sortedProxies.length} proxies by response time`);

            // آماده‌سازی داده‌های جدید برای درج
            const newProxies = sortedProxies.map(proxyData => ({
                host: proxyData.host,
                port: parseInt(proxyData.port),
                username: proxyData.username || null,
                password: proxyData.password || null,
                protocol: proxyData.protocol || 'http',
                status: 'active',
                responseTime: proxyData.responseTime || null,
                lastTestAt: new Date(),
                usageCount: 0,
                successCount: 1,
                failureCount: 0,
                source: 'api'
            }));

            // استفاده از تراکنش برای حذف رکوردهای قدیمی و درج رکوردهای جدید
            const session = await mongoose.startSession();

            let savedCount = 0;

            await session.withTransaction(async () => {
                // حذف تمام پروکسی‌های قدیمی
                await Proxy.deleteMany({}, { session });
                console.log('🗑️ Cleared old proxies from database (in transaction)');

                // درج پروکسی‌های جدید به‌صورت batch
                if (newProxies.length > 0) {
                    const savedProxies = await Proxy.insertMany(newProxies, { session });
                    savedCount = savedProxies.length;
                    console.log(`✅ Inserted ${savedCount} new proxies (in transaction)`);
                }
            });

            await session.endSession();

            console.log(`✅ Transaction completed successfully: ${savedCount} proxies saved and sorted by speed`);

            // به‌روزرسانی آمار
            this.stats.totalProxies = savedCount;
            this.stats.activeProxies = savedCount;

            return savedCount;

        } catch (error) {
            console.error('❌ Error saving proxies to database:', error);
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
                successRate: this.stats.totalProxies > 0 ?
                    Math.round((this.stats.activeProxies / this.stats.totalProxies) * 100) : 100
            },
            config: {
                maxResponseTime: this.config.maxResponseTime,
                concurrency: this.config.concurrency,
                timeout: this.config.timeout,
                apiKey: this.config.apiKey ? '***' : 'not set',
                schedule: 'Every 30 minutes (:00 and :30)'
            },
            workerStatus: this.worker ? 'running' : 'stopped'
        };
    }

    // متد برای دریافت پروکسی بعدی
    async getNextProxy() {
        try {
            const proxy = await Proxy.findOneAndUpdate(
                { status: 'active' },
                {
                    $inc: { usageCount: 1 },
                    lastUsedAt: new Date()
                },
                {
                    new: true,
                    sort: { usageCount: 1, lastUsedAt: 1 } // کم‌استفاده‌ترین را انتخاب کن
                }
            );

            if (!proxy) {
                return null;
            }

            return {
                host: proxy.host,
                port: proxy.port,
                username: proxy.username,
                password: proxy.password,
                protocol: proxy.protocol,
                url: proxy.url
            };

        } catch (error) {
            console.error('❌ Error getting next proxy:', error);
            return null;
        }
    }

    // متد برای گزارش نتیجه استفاده از پروکسی
    async reportProxyResult(proxyHost, proxyPort, success) {
        try {
            const updateData = success ?
                { $inc: { successCount: 1 } } :
                { $inc: { failureCount: 1 } };

            await Proxy.findOneAndUpdate(
                { host: proxyHost, port: proxyPort },
                updateData
            );

        } catch (error) {
            console.error('❌ Error reporting proxy result:', error);
        }
    }

    // متد برای اجرای دستی آپدیت
    async manualUpdate() {
        console.log('🔧 Manual proxy update triggered');
        await this.triggerUpdate();
    }
}

module.exports = new ProxyUpdaterService();