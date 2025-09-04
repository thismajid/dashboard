// src/services/statsService.js
const { redis } = require('../config/redis');

class StatsService {
    constructor() {
        this.STATS_KEY = 'system_stats';
        this.PERFORMANCE_KEY = 'performance_stats';
        this.INSTANCE_KEY = 'instance_stats';
        this.PROCESSED_KEY = 'processed_stats';
    }

    /**
    * ثبت instance جدید
    */
    async registerInstance(instanceId) {
        try {
            const key = `${this.INSTANCE_KEY}:${instanceId}`;
            const instanceData = {
                instanceId: instanceId,
                status: 'idle',
                processedCount: 0,
                successCount: 0,
                failedCount: 0,
                uptime: 0,
                lastHeartbeat: Date.now(),
                registeredAt: Date.now(),
                lastUpdate: Date.now()
            };

            await redis.hmset(key, instanceData);
            await redis.expire(key, 300); // 5 دقیقه

            // به‌روزرسانی تعداد instance های فعال
            await this.updateActiveInstanceCount();

            console.log(`📊 Instance registered in stats: ${instanceId}`);
            return true;
        } catch (error) {
            console.error('خطا در ثبت instance در آمار:', error);
            return false;
        }
    }

    /**
    * حذف ثبت instance
    */
    async unregisterInstance(instanceId) {
        try {
            const key = `${this.INSTANCE_KEY}:${instanceId}`;
            await redis.del(key);

            // به‌روزرسانی تعداد instance های فعال
            await this.updateActiveInstanceCount();

            console.log(`📊 Instance unregistered from stats: ${instanceId}`);
            return true;
        } catch (error) {
            console.error('خطا در حذف ثبت instance:', error);
            return false;
        }
    }

    /**
    * افزایش آمار پردازش شده
    */
    async incrementProcessed(success = false) {
        try {
            const multi = redis.multi();

            // افزایش کل پردازش شده
            multi.hincrby(this.STATS_KEY, 'totalProcessed', 1);

            if (success) {
                multi.hincrby(this.STATS_KEY, 'successCount', 1);
            } else {
                multi.hincrby(this.STATS_KEY, 'failedCount', 1);
            }

            // محاسبه نرخ موفقیت
            const stats = await this.getStats();
            const successRate = stats.totalProcessed > 0 ?
                Math.round((stats.successCount / stats.totalProcessed) * 100) : 0;

            multi.hset(this.STATS_KEY, 'successRate', successRate);
            multi.hset(this.STATS_KEY, 'lastUpdate', Date.now());
            multi.expire(this.STATS_KEY, 3600);

            await multi.exec();
            return true;
        } catch (error) {
            console.error('خطا در افزایش آمار پردازش:', error);
            return false;
        }
    }

    /**
    * ثبت آمار عملکرد
    */
    async recordPerformance(instanceId, performanceData) {
        try {
            const data = {
                instanceId: instanceId,
                batchSize: performanceData.batchSize || 0,
                processingTime: performanceData.processingTime || 0,
                successRate: performanceData.successRate || 0,
                avgResponseTime: performanceData.avgResponseTime || 0,
                timestamp: Date.now()
            };

            // ذخیره در کلید مخصوص instance
            const instanceKey = `${this.PERFORMANCE_KEY}:${instanceId}`;
            await redis.lpush(instanceKey, JSON.stringify(data));
            await redis.ltrim(instanceKey, 0, 999); // نگه داشتن 1000 رکورد آخر
            await redis.expire(instanceKey, 86400); // 24 ساعت

            // ذخیره در کلید کلی
            await redis.lpush(this.PERFORMANCE_KEY, JSON.stringify(data));
            await redis.ltrim(this.PERFORMANCE_KEY, 0, 999);
            await redis.expire(this.PERFORMANCE_KEY, 86400);

            console.log(`📊 Performance recorded for ${instanceId}: ${performanceData.batchSize} accounts in ${performanceData.processingTime}ms`);
            return true;
        } catch (error) {
            console.error('خطا در ثبت آمار عملکرد:', error);
            return false;
        }
    }

    /**
    * به‌روزرسانی وضعیت instance
    */
    async updateInstance(instanceId, updateData) {
        try {
            const key = `${this.INSTANCE_KEY}:${instanceId}`;

            // دریافت داده‌های موجود
            const existingData = await redis.hgetall(key);

            const instanceData = {
                ...existingData,
                ...updateData,
                instanceId: instanceId,
                lastUpdate: Date.now()
            };

            // اگر currentBatch object هست، stringify کن
            if (instanceData.currentBatch && typeof instanceData.currentBatch === 'object') {
                instanceData.currentBatch = JSON.stringify(instanceData.currentBatch);
            }

            await redis.hmset(key, instanceData);
            await redis.expire(key, 300); // 5 دقیقه

            return true;
        } catch (error) {
            console.error('خطا در به‌روزرسانی instance:', error);
            return false;
        }
    }

    /**
    * به‌روزرسانی تعداد instance های فعال
    */
    async updateActiveInstanceCount() {
        try {
            const activeInstances = await this.getActiveInstances();
            await redis.hset(this.STATS_KEY, 'activeInstances', activeInstances.length);
            await redis.expire(this.STATS_KEY, 3600);
            return true;
        } catch (error) {
            console.error('خطا در به‌روزرسانی تعداد instance های فعال:', error);
            return false;
        }
    }

    /**
    * پاک‌سازی آمار قدیمی
    */
    async cleanupOldStats(daysToKeep = 7) {
        try {
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

            // پاک‌سازی آمار عملکرد قدیمی
            const performanceKeys = await redis.keys(`${this.PERFORMANCE_KEY}*`);

            for (const key of performanceKeys) {
                const data = await redis.lrange(key, 0, -1);
                const validData = [];

                for (const item of data) {
                    try {
                        const parsed = JSON.parse(item);
                        if (parsed.timestamp > cutoffTime) {
                            validData.push(item);
                        }
                    } catch (error) {
                        // Skip invalid data
                    }
                }

                if (validData.length !== data.length) {
                    await redis.del(key);
                    if (validData.length > 0) {
                        await redis.rpush(key, ...validData);
                        await redis.expire(key, 86400);
                    }
                }
            }

            // پاک‌سازی instance های منقضی شده
            const instanceKeys = await redis.keys(`${this.INSTANCE_KEY}:*`);
            for (const key of instanceKeys) {
                const ttl = await redis.ttl(key);
                if (ttl === -1 || ttl === 0) { // کلیدهای منقضی شده
                    await redis.del(key);
                }
            }

            console.log(`🧹 Cleaned up stats older than ${daysToKeep} days`);
            return true;
        } catch (error) {
            console.error('خطا در پاک‌سازی آمار قدیمی:', error);
            return false;
        }
    }

    /**
    * دریافت آمار کلی سیستم
    */
    async getStats() {
        try {
            const statsData = await redis.hgetall(this.STATS_KEY);

            return {
                totalProcessed: parseInt(statsData.totalProcessed) || 0,
                successCount: parseInt(statsData.successCount) || 0,
                failedCount: parseInt(statsData.failedCount) || 0,
                successRate: parseFloat(statsData.successRate) || 0,
                activeInstances: parseInt(statsData.activeInstances) || 0,
                lastUpdate: parseInt(statsData.lastUpdate) || Date.now()
            };
        } catch (error) {
            console.error('خطا در دریافت آمار از Redis:', error);
            return {
                totalProcessed: 0,
                successCount: 0,
                failedCount: 0,
                successRate: 0,
                activeInstances: 0,
                lastUpdate: Date.now()
            };
        }
    }

    /**
    * به‌روزرسانی آمار سیستم
    */
    async updateStats(stats) {
        try {
            const statsData = {
                ...stats,
                lastUpdate: Date.now()
            };

            await redis.hmset(this.STATS_KEY, statsData);
            await redis.expire(this.STATS_KEY, 3600); // 1 ساعت

            return true;
        } catch (error) {
            console.error('خطا در به‌روزرسانی آمار:', error);
            return false;
        }
    }

    /**
    * دریافت آمار عملکرد
    */
    async getPerformanceStats(instanceId = null, limit = 50) {
        try {
            const key = instanceId ? `${this.PERFORMANCE_KEY}:${instanceId}` : this.PERFORMANCE_KEY;
            const performanceData = await redis.lrange(key, 0, limit - 1);

            return performanceData.map(data => {
                try {
                    return JSON.parse(data);
                } catch (error) {
                    console.error('خطا در پردازش داده عملکرد:', error);
                    return null;
                }
            }).filter(Boolean);
        } catch (error) {
            console.error('خطا در دریافت آمار عملکرد:', error);
            return [];
        }
    }

    /**
    * اضافه کردن آمار عملکرد
    */
    async addPerformanceStats(instanceId, performanceData) {
        try {
            const key = instanceId ? `${this.PERFORMANCE_KEY}:${instanceId}` : this.PERFORMANCE_KEY;
            const data = {
                ...performanceData,
                timestamp: Date.now(),
                instanceId: instanceId
            };

            await redis.lpush(key, JSON.stringify(data));
            await redis.ltrim(key, 0, 999); // نگه داشتن آخرین 1000 رکورد
            await redis.expire(key, 86400); // 24 ساعت

            // اضافه کردن به کلید کلی نیز
            if (instanceId) {
                await redis.lpush(this.PERFORMANCE_KEY, JSON.stringify(data));
                await redis.ltrim(this.PERFORMANCE_KEY, 0, 999);
                await redis.expire(this.PERFORMANCE_KEY, 86400);
            }

            return true;
        } catch (error) {
            console.error('خطا در اضافه کردن آمار عملکرد:', error);
            return false;
        }
    }

    /**
    * دریافت آمار instance ها
    */
    async getInstanceStats(instanceId = null) {
        try {
            if (instanceId) {
                const instanceData = await redis.hgetall(`${this.INSTANCE_KEY}:${instanceId}`);
                return instanceData ? this.parseInstanceData(instanceData) : null;
            } else {
                const instanceKeys = await redis.keys(`${this.INSTANCE_KEY}:*`);
                const instances = [];

                for (const key of instanceKeys) {
                    const instanceData = await redis.hgetall(key);
                    if (instanceData && Object.keys(instanceData).length > 0) {
                        instances.push(this.parseInstanceData(instanceData));
                    }
                }

                return instances;
            }
        } catch (error) {
            console.error('خطا در دریافت آمار instance:', error);
            return instanceId ? null : [];
        }
    }

    /**
    * به‌روزرسانی آمار instance
    */
    async updateInstanceStats(instanceId, stats) {
        try {
            const key = `${this.INSTANCE_KEY}:${instanceId}`;
            const instanceData = {
                ...stats,
                instanceId: instanceId,
                lastUpdate: Date.now()
            };

            await redis.hmset(key, instanceData);
            await redis.expire(key, 300); // 5 دقیقه

            return true;
        } catch (error) {
            console.error('خطا در به‌روزرسانی آمار instance:', error);
            return false;
        }
    }

    /**
    * حذف آمار instance
    */
    async removeInstanceStats(instanceId) {
        try {
            const key = `${this.INSTANCE_KEY}:${instanceId}`;
            await redis.del(key);
            return true;
        } catch (error) {
            console.error('خطا در حذف آمار instance:', error);
            return false;
        }
    }

    /**
    * دریافت لیست instance های فعال
    */
    async getActiveInstances() {
        try {
            const instanceKeys = await redis.keys(`${this.INSTANCE_KEY}:*`);
            const activeInstances = [];

            for (const key of instanceKeys) {
                const ttl = await redis.ttl(key);
                if (ttl > 0) { // instance هنوز فعال است
                    const instanceId = key.replace(`${this.INSTANCE_KEY}:`, '');
                    activeInstances.push(instanceId);
                }
            }

            return activeInstances;
        } catch (error) {
            console.error('خطا در دریافت instance های فعال:', error);
            return [];
        }
    }

    /**
    * پردازش داده‌های instance
    */
    parseInstanceData(instanceData) {
        return {
            instanceId: instanceData.instanceId,
            status: instanceData.status || 'unknown',
            processedCount: parseInt(instanceData.processedCount) || 0,
            successCount: parseInt(instanceData.successCount) || 0,
            failedCount: parseInt(instanceData.failedCount) || 0,
            uptime: parseInt(instanceData.uptime) || 0,
            lastHeartbeat: parseInt(instanceData.lastHeartbeat) || Date.now(),
            currentBatch: instanceData.currentBatch ?
                (typeof instanceData.currentBatch === 'string' ?
                    JSON.parse(instanceData.currentBatch) : instanceData.currentBatch) : null,
            serverInfo: instanceData.serverInfo ?
                (typeof instanceData.serverInfo === 'string' ?
                    JSON.parse(instanceData.serverInfo) : instanceData.serverInfo) : null,
            registeredAt: parseInt(instanceData.registeredAt) || Date.now(),
            lastUpdate: parseInt(instanceData.lastUpdate) || Date.now()
        };
    }

    /**
    * محاسبه آمار خلاصه
    */
    async calculateSummaryStats() {
        try {
            const [systemStats, instanceStats, performanceStats] = await Promise.all([
                this.getStats(),
                this.getInstanceStats(),
                this.getPerformanceStats(null, 100)
            ]);

            const summary = {
                system: systemStats,
                instances: {
                    total: instanceStats.length,
                    active: instanceStats.filter(i => i.status === 'working').length,
                    idle: instanceStats.filter(i => i.status === 'idle').length,
                    error: instanceStats.filter(i => i.status === 'error').length
                },
                performance: {
                    totalBatches: performanceStats.length,
                    avgBatchSize: performanceStats.length > 0 ?
                        Math.round(performanceStats.reduce((sum, p) => sum + (p.batchSize || 0), 0) / performanceStats.length) : 0,
                    avgProcessingTime: performanceStats.length > 0 ?
                        Math.round(performanceStats.reduce((sum, p) => sum + (p.processingTime || 0), 0) / performanceStats.length) : 0,
                    avgSuccessRate: performanceStats.length > 0 ?
                        Math.round(performanceStats.reduce((sum, p) => sum + (p.successRate || 0), 0) / performanceStats.length) : 0
                },
                timestamp: Date.now()
            };

            return summary;
        } catch (error) {
            console.error('خطا در محاسبه آمار خلاصه:', error);
            return {
                system: { totalProcessed: 0, successCount: 0, failedCount: 0, successRate: 0, activeInstances: 0 },
                instances: { total: 0, active: 0, idle: 0, error: 0 },
                performance: { totalBatches: 0, avgBatchSize: 0, avgProcessingTime: 0, avgSuccessRate: 0 },
                timestamp: Date.now()
            };
        }
    }
}

module.exports = new StatsService();