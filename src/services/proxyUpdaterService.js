const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const path = require('path');
const cron = require('node-cron');
const ProxyModel = require('../models/knex/Proxy');
const { db } = require('../config/database');

class ProxyUpdaterService extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.worker = null;
        this.cronJob = null;

        this.config = {
            apiKey: process.env.PROXY_API_KEY || '14vamdyyof&pack=2'
        };

        this.stats = {
            lastUpdate: null,
            nextUpdate: null,
            totalProxies: 0,
            isUpdating: false,
            lastError: null
        };

        console.log('🌐 ProxyUpdaterService initialized - Fetch & Replace mode');
    }

    start() {
        // if (this.isRunning) {
        //     console.log('⚠️ ProxyUpdaterService is already running');
        //     return;
        // }

        // this.isRunning = true;
        // console.log('🚀 Starting ProxyUpdaterService...');

        // // تنظیم cron job برای اجرا در دقیقه 0 و 30 هر ساعت
        // this.cronJob = cron.schedule('0,30 * * * *', () => {
        //     const now = new Date();
        //     console.log(`⏰ Scheduled proxy update triggered at: ${now.toLocaleString('fa-IR')}`);
        //     this.triggerUpdate();
        // }, {
        //     scheduled: true,
        //     timezone: "Asia/Tehran"
        // });

        // // محاسبه زمان آپدیت بعدی
        // this.calculateNextUpdate();

        // console.log(`✅ ProxyUpdaterService started`);
        // console.log(`📅 Next update: ${this.stats.nextUpdate?.toLocaleString('fa-IR')}`);

        // لود آمار فعلی
        this.loadCurrentStats();
    }

    stop() {
        if (!this.isRunning) return;

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

    calculateNextUpdate() {
        const now = new Date();
        const currentMinute = now.getMinutes();

        let nextUpdate = new Date(now);

        if (currentMinute < 30) {
            nextUpdate.setMinutes(30, 0, 0);
        } else {
            nextUpdate.setHours(nextUpdate.getHours() + 1);
            nextUpdate.setMinutes(0, 0, 0);
        }

        this.stats.nextUpdate = nextUpdate;
    }

    async loadCurrentStats() {
        try {
            const count = await ProxyModel.query().where('status', 'active').count('* as total');
            this.stats.totalProxies = parseInt(count[0]?.total) || 0;

            console.log(`📊 Current proxy count: ${this.stats.totalProxies}`);
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
            console.log(`🔄 Starting proxy fetch at: ${now.toLocaleString('fa-IR')}`);

            this.stats.isUpdating = true;
            this.stats.lastError = null;

            this.emit('update-started', {
                timestamp: now,
                message: 'شروع دریافت پروکسی‌های جدید'
            });

            await this.fetchAndReplaceProxies();

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
            this.calculateNextUpdate();

            console.log(`📅 Next proxy update: ${this.stats.nextUpdate?.toLocaleString('fa-IR')}`);
        }
    }

    async fetchAndReplaceProxies() {
        return new Promise((resolve, reject) => {
            console.log('🌐 Fetching fresh proxies from API...');

            // ایجاد worker thread
            this.worker = new Worker(path.join(__dirname, '../workers/proxyWorker.js'), {
                workerData: {
                    config: this.config
                }
            });

            // تنظیم timeout
            const workerTimeout = setTimeout(() => {
                if (this.worker) {
                    this.worker.terminate();
                    this.worker = null;
                    reject(new Error('Worker timeout after 5 minutes'));
                }
            }, 5 * 60 * 1000);

            this.worker.on('message', async (message) => {
                try {
                    if (message.type === 'completed') {
                        clearTimeout(workerTimeout);
                        console.log(`✅ Proxy fetch completed: ${message.workingProxies.length} proxies received`);

                        // جایگزینی پروکسی‌ها در دیتابیس
                        const savedCount = await this.replaceProxiesInDatabase(message.workingProxies);

                        this.stats.totalProxies = savedCount;

                        this.emit('update-completed', {
                            message: `${savedCount} پروکسی جدید جایگزین شد`,
                            stats: {
                                total: this.stats.totalProxies
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

    async replaceProxiesInDatabase(newProxies) {
        const trx = await db().transaction();

        try {
            console.log(`💾 Attempting to replace proxies with ${newProxies.length} new ones...`);

            // 🛡️ CRITICAL SAFETY CHECK: Never allow empty proxy table!
            if (!newProxies || newProxies.length === 0) {
                console.error('🚨 SAFETY ABORT: Cannot replace proxies with empty list - would leave table empty!');
                await trx.rollback();
                throw new Error('Cannot replace proxies: no new proxies provided (safety check)');
            }

            // مرحله 1: حذف تمام پروکسی‌های موجود (only after confirming we have replacements)
            console.log(`🗑️ Deleting all existing proxies (${newProxies.length} replacements ready)...`);
            const deletedCount = await trx('Proxies').del();
            console.log(`🗑️ Deleted ${deletedCount} existing proxies`);

            // Continue with the existing logic since we know we have new proxies

            // آماده‌سازی داده‌های جدید
            const proxyRows = newProxies.map(proxy => ({
                host: proxy.host.trim(),
                port: parseInt(proxy.port),
                username: proxy.username?.trim() || null,
                password: proxy.password?.trim() || null,
                protocol: proxy.protocol || 'http',
                status: 'active',
                responseTime: 0,
                source: 'api',
                created_at: new Date(),
                updated_at: new Date()
            }));

            // مرحله 2: درج پروکسی‌های جدید
            console.log(`📥 Inserting ${proxyRows.length} new proxies...`);

            const chunkSize = 500;
            let totalInserted = 0;

            for (let i = 0; i < proxyRows.length; i += chunkSize) {
                const chunk = proxyRows.slice(i, i + chunkSize);

                await trx('Proxies').insert(chunk);
                totalInserted += chunk.length;

                console.log(`📊 Inserted chunk: ${totalInserted}/${proxyRows.length} proxies`);
            }

            await trx.commit();
            console.log(`✅ Successfully replaced all proxies: ${totalInserted} new proxies saved`);

            return totalInserted;

        } catch (error) {
            await trx.rollback();
            console.error('❌ Transaction failed, rolled back:', error);
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
            totalProxies: this.stats.totalProxies,
            config: {
                apiKey: this.config.apiKey ? '***masked***' : 'not set',
                schedule: 'Every 30 minutes (:00 and :30)'
            }
        };
    }

    // تست دستی
    async manualUpdate() {
        console.log('🔧 Manual proxy update triggered');

        if (this.stats.isUpdating) {
            throw new Error('Proxy update is already in progress');
        }

        await this.triggerUpdate();
        return this.getStatus();
    }
}


module.exports = new ProxyUpdaterService();
