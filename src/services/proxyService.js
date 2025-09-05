const { db } = require('../config/database');
const ProxyModel = require('../models/knex/Proxy');

class ProxyService {
    constructor() {
        console.log('🌐 ProxyService initialized - Single use mode');

        // تنظیم Redis با ioredis
        this.redis = null;
        this.serviceInfo = {
            isRunning: true,
            lastUpdate: new Date(),
            nextUpdate: this.calculateNextUpdateTime(),
            status: 'idle'
        };

        // اتصال به Redis
        this.initializeRedis();
    }

    async initializeRedis() {
        try {
            // اتصال به Redis با ioredis
            const { redis } = require('../config/redis');
            this.redis = redis;

            // تست اتصال
            await this.redis.ping();
            console.log('✅ ProxyService Redis connected');

        } catch (error) {
            console.warn('⚠️ ProxyService Redis initialization failed:', error.message);
            this.redis = null;
        }
    }

    // محاسبه زمان به‌روزرسانی بعدی
    calculateNextUpdateTime(currentTime = new Date()) {
        const now = new Date(currentTime);
        const minutes = now.getMinutes();

        // پیدا کردن نزدیک‌ترین نیم ساعت بعدی (00 یا 30)
        let nextMinutes;
        if (minutes < 30) {
            nextMinutes = 30;
        } else {
            nextMinutes = 60; // یعنی ساعت بعد، دقیقه 0
        }

        const nextUpdate = new Date(now);

        if (nextMinutes === 60) {
            nextUpdate.setHours(now.getHours() + 1);
            nextUpdate.setMinutes(0);
        } else {
            nextUpdate.setMinutes(nextMinutes);
        }

        nextUpdate.setSeconds(0);
        nextUpdate.setMilliseconds(0);

        return nextUpdate;
    }

    async getServiceInfo() {
        try {
            // اگر Redis موجود باشه
            if (this.redis) {
                try {
                    const serviceInfo = await this.redis.hgetall('proxy:service:info');

                    // اگر اطلاعات موجود باشه
                    if (serviceInfo && Object.keys(serviceInfo).length > 0) {
                        let nextUpdate = null;
                        if (serviceInfo.nextUpdate) {
                            nextUpdate = new Date(serviceInfo.nextUpdate);
                            // اگر nextUpdate گذشته، دوباره محاسبه کن
                            if (nextUpdate < new Date()) {
                                nextUpdate = this.calculateNextUpdateTime();
                                await this.updateServiceInfo({ nextUpdate });
                            }
                        } else {
                            nextUpdate = this.calculateNextUpdateTime();
                            await this.updateServiceInfo({ nextUpdate });
                        }

                        return {
                            isRunning: serviceInfo.isRunning === 'true',
                            lastUpdate: serviceInfo.lastUpdate ? new Date(serviceInfo.lastUpdate) : new Date(),
                            nextUpdate: nextUpdate,
                            status: serviceInfo.status || 'idle'
                        };
                    }
                } catch (redisError) {
                    console.warn('⚠️ Redis hgetall error, falling back to memory:', redisError.message);
                }
            }

            // Fallback به حافظه محلی
            // اگر nextUpdate گذشته، دوباره محاسبه کن
            if (this.serviceInfo.nextUpdate < new Date()) {
                this.serviceInfo.nextUpdate = this.calculateNextUpdateTime();
            }

            return {
                isRunning: this.serviceInfo.isRunning,
                lastUpdate: this.serviceInfo.lastUpdate,
                nextUpdate: this.serviceInfo.nextUpdate,
                status: this.serviceInfo.status
            };

        } catch (error) {
            console.error('❌ Error getting service info:', error);
            return {
                isRunning: false,
                lastUpdate: new Date(),
                nextUpdate: this.calculateNextUpdateTime(),
                status: 'error'
            };
        }
    }

    async updateServiceInfo(info) {
        try {
            // اگر lastUpdate جدید داده شده، nextUpdate رو هم محاسبه کن
            if (info.lastUpdate && !info.nextUpdate) {
                info.nextUpdate = this.calculateNextUpdateTime();
            }

            // بروزرسانی حافظه محلی
            this.serviceInfo = {
                ...this.serviceInfo,
                ...info
            };

            // اگر Redis موجود باشه، در آن هم ذخیره کن
            if (this.redis) {
                try {
                    const redisData = {
                        isRunning: (info.isRunning !== undefined ? info.isRunning : this.serviceInfo.isRunning).toString(),
                        lastUpdate: info.lastUpdate ? info.lastUpdate.toISOString() :
                            (this.serviceInfo.lastUpdate ? this.serviceInfo.lastUpdate.toISOString() : new Date().toISOString()),
                        nextUpdate: info.nextUpdate ? info.nextUpdate.toISOString() :
                            (this.serviceInfo.nextUpdate ? this.serviceInfo.nextUpdate.toISOString() : this.calculateNextUpdateTime().toISOString()),
                        status: info.status || this.serviceInfo.status || 'idle'
                    };

                    await this.redis.hmset('proxy:service:info', redisData);
                    console.log('📊 Service info saved to Redis:', redisData);

                } catch (redisError) {
                    console.warn('⚠️ Redis hmset error:', redisError.message);
                }
            }

            console.log('📊 Service info updated:', {
                isRunning: this.serviceInfo.isRunning,
                lastUpdate: this.serviceInfo.lastUpdate,
                nextUpdate: this.serviceInfo.nextUpdate,
                status: this.serviceInfo.status
            });

        } catch (error) {
            console.error('❌ Error updating service info:', error);
        }
    }

    // متد برای شروع به‌روزرسانی پروکسی‌ها
    async startProxyUpdate() {
        const now = new Date();
        const nextUpdate = this.calculateNextUpdateTime(now);

        console.log('🚀 Starting proxy update...');
        await this.updateServiceInfo({
            isRunning: true,
            lastUpdate: now,
            nextUpdate: nextUpdate,
            status: 'updating'
        });
    }

    // متد برای پایان به‌روزرسانی
    async finishProxyUpdate(success = true) {
        const now = new Date();
        const nextUpdate = this.calculateNextUpdateTime(now);

        console.log(`✅ Proxy update finished: ${success ? 'SUCCESS' : 'FAILED'}`);
        await this.updateServiceInfo({
            isRunning: true,
            lastUpdate: now,
            nextUpdate: nextUpdate,
            status: success ? 'success' : 'error'
        });
    }

    /**
    * دریافت پروکسی برای instance خاص
    */
    async getProxyForInstance(instanceId) {
        try {
            // پیدا کردن یک پروکسی فعال و حذف آن در همان عملیات
            const proxy = await ProxyModel.findOneAndDelete(
                { status: 'active' },
                {
                    sort: {
                        created_at: 1 // قدیمی‌ترین
                    }
                }
            );

            if (!proxy) {
                console.log(`⚠️ No available proxy found for instance: ${instanceId}`);
                return null;
            }

            console.log(`🌐 Proxy assigned to ${instanceId}: ${proxy.host}:${proxy.port}`);

            return {
                id: proxy.id,
                host: proxy.host,
                port: proxy.port,
                username: proxy.username,
                password: proxy.password,
                protocol: proxy.protocol || 'http',
                responseTime: proxy.responseTime || 0,
                assignedTo: instanceId,
                assignedAt: new Date(),
                url: this.buildProxyUrl(proxy)
            };

        } catch (error) {
            console.error(`❌ Error getting proxy for instance ${instanceId}:`, error);
            return null;
        }
    }

    /**
    * گزارش وضعیت پروکسی
    */
    async reportProxyStatus(proxyId, instanceId, success, responseTime, error = null) {
        try {
            const status = success ? '✅ SUCCESS' : '❌ FAILED';
            const errorMsg = error ? ` - Error: ${error}` : '';

            console.log(`📊 Proxy Report [${proxyId}] by ${instanceId}: ${status} (${responseTime}ms)${errorMsg}`);

            return true;
        } catch (err) {
            console.error('❌ خطا در گزارش وضعیت پروکسی:', err);
            return false;
        }
    }

    /**
    * آزادسازی پروکسی‌های stuck
    */
    async releaseStuckProxies(timeoutMinutes = 10) {
        try {
            console.log(`🔄 Checking for stuck proxies (timeout: ${timeoutMinutes}min)`);

            const cleanedCount = await this.cleanupOldProxies(24);

            console.log(`🧹 Cleaned up ${cleanedCount} old proxies`);
            return cleanedCount;
        } catch (error) {
            console.error('❌ خطا در آزادسازی پروکسی‌های stuck:', error);
            return 0;
        }
    }

    /**
    * دریافت آمار پروکسی‌ها
    */
    async getProxyStats() {
        return await ProxyModel.getProxyStats();
    }

    /**
    * دریافت و حذف پروکسی (استفاده یکبار)
    */
    async getAndConsumeProxy() {
        return await this.getProxyForInstance('direct-consume');
    }

    /**
    * ساخت URL پروکسی
    */
    buildProxyUrl(proxy) {
        const auth = proxy.username && proxy.password ?
            `${proxy.username}:${proxy.password}@` : '';
        const protocol = proxy.protocol || 'http';
        return `${protocol}://${auth}${proxy.host}:${proxy.port}`;
    }

    /**
    * دریافت تمام پروکسی‌های موجود
    */
    async getAllProxies(limit = 100) {
        try {
            const proxies = await ProxyModel.query()
                .where('status', 'active')
                .select('id', 'host', 'port', 'protocol', 'responseTime', 'created_at')
                .orderBy('responseTime', 'asc')
                .orderBy('created_at', 'asc')
                .limit(limit);

            return proxies.map(proxy => ({
                id: proxy.id.toString(),
                host: proxy.host,
                port: proxy.port,
                protocol: proxy.protocol || 'http',
                responseTime: proxy.responseTime || 0,
                created_at: proxy.created_at,
                status: 'active'
            }));

        } catch (error) {
            console.error('❌ Error getting all proxies:', error);
            return [];
        }
    }

    /**
    * حذف پروکسی‌های قدیمی
    */
    // async cleanupOldProxies(olderThanHours = 24) {
    //     try {
    //         const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));

    //         const deletedCount = await ProxyModel.deleteMany({
    //             created_at: cutoffTime
    //         });

    //         if (deletedCount > 0) {
    //             console.log(`🗑️ Cleaned up ${deletedCount} old proxies`);
    //         }

    //         return deletedCount;

    //     } catch (error) {
    //         console.error('❌ Error cleaning up old proxies:', error);
    //         return 0;
    //     }
    // }

    /**
    * بروزرسانی پروکسی‌ها (جایگزینی کل لیست) با تراکنش
    */
    async updateProxies(newProxies) {
        const trx = await db().transaction();

        try {
            // شروع به‌روزرسانی
            await this.startProxyUpdate();

            // 🛡️ CRITICAL SAFETY CHECK: Never allow empty proxy table!
            if (!newProxies || newProxies.length === 0) {
                console.error('🚨 SAFETY ABORT: Cannot update proxies with empty list - would leave table empty!');
                await trx.rollback();
                await this.finishProxyUpdate(false);
                throw new Error('Cannot update proxies: no new proxies provided (safety check)');
            }

            const proxyModel = ProxyModel.withTransaction(trx);

            // حذف تمام پروکسی‌های موجود (only after confirming we have replacements)
            console.log(`🗑️ Deleting all existing proxies (${newProxies.length} replacements ready)...`);
            await proxyModel.query().del();

            const proxyRows = newProxies.map(proxy => ({
                host: proxy.host,
                port: proxy.port,
                username: proxy.username || null,
                password: proxy.password || null,
                protocol: proxy.protocol || 'http',
                status: proxy.status || 'active',
                responseTime: proxy.responseTime || null,
                source: proxy.source || 'api',
                created_at: new Date(),
                updated_at: new Date()
            }));

            await proxyModel.insertMany(proxyRows);

            await trx.commit();
            console.log(`✅ ${newProxies?.length || 0} پروکسی بروزرسانی شد`);

            // پایان موفق به‌روزرسانی
            await this.finishProxyUpdate(true);

            return newProxies?.length || 0;

        } catch (error) {
            await trx.rollback();
            console.error('❌ خطا در بروزرسانی پروکسی‌ها:', error);

            // پایان ناموفق به‌روزرسانی
            await this.finishProxyUpdate(false);

            throw error;
        }
    }

    /**
    * آزادسازی اکانت‌های قفل شده (برای سازگاری)
    */
    async releaseAccountsByIds(accountIds) {
        console.log(`⚠️ releaseAccountsByIds called in proxyService - should be in accountService`);
        return true;
    }

    /**
    * تست اتصال Redis
    */
    async testRedisConnection() {
        try {
            if (!this.redis) {
                return { connected: false, error: 'Redis not initialized' };
            }

            await this.redis.ping();
            return { connected: true };
        } catch (error) {
            return { connected: false, error: error.message };
        }
    }

    /**
    * دریافت اطلاعات کامل سرویس برای تست
    */
    async getFullServiceStatus() {
        try {
            const serviceInfo = await this.getServiceInfo();
            const redisStatus = await this.testRedisConnection();
            const proxyStats = await this.getProxyStats();

            return {
                service: serviceInfo,
                redis: redisStatus,
                proxies: proxyStats,
                timestamp: new Date()
            };
        } catch (error) {
            console.error('❌ Error getting full service status:', error);
            return {
                service: { isRunning: false, status: 'error' },
                redis: { connected: false, error: error.message },
                proxies: { total: 0 },
                timestamp: new Date()
            };
        }
    }
}

module.exports = new ProxyService();