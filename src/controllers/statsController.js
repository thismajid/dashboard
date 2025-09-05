const AccountModel = require('../models/knex/Account');
const ProxyModel = require('../models/knex/Proxy');
const BatchModel = require('../models/knex/Batch'); // اگر وجود داره
const statsService = require('../services/statsService');
const proxyService = require('../services/proxyService');
const accountService = require('../services/accountService');
const { db } = require('../config/database')
const os = require('os');

class StatsController {
    constructor() {
        console.log('📊 StatsController initialized');
    }

    async getSystemStats(req, res) {
        try {
            console.log('📊 Getting system stats...');

            const [
                accountStats,
                proxyStats,
                batchStats,
                instanceStats,
                systemInfo,
                redisStats
            ] = await Promise.all([
                this.getAccountStats(),
                this.getProxyStats(),
                this.getBatchStats(),
                this.getInstanceStats(),
                this.getSystemInfo(),
                this.getRedisStats()
            ]);

            const stats = {
                accounts: accountStats,
                proxies: proxyStats,
                batches: batchStats,
                instances: instanceStats,
                system: systemInfo,
                redis: redisStats,
                timestamp: Date.now(),
                healthy: this.calculateSystemHealth(accountStats, proxyStats, instanceStats)
            };

            console.log('📊 System stats compiled:', {
                totalAccounts: stats.accounts.total,
                pendingAccounts: stats.accounts.pending,
                activeProxies: stats.proxies.active,
                totalProxies: stats.proxies.total,
                activeBatches: stats.batches.processing,
                activeInstances: stats.instances.active
            });

            // اگر از route فراخوانی شده باشد
            if (res) {
                return res.json({
                    success: true,
                    data: stats,
                    timestamp: Date.now()
                });
            }

            // اگر مستقیماً فراخوانی شده باشد
            return { success: true, data: stats };

        } catch (error) {
            console.error('❌ Error getting system stats:', error);

            if (res) {
                return res.status(500).json({
                    success: false,
                    message: 'خطا در دریافت آمار سیستم',
                    error: process.env.NODE_ENV === 'development' ? error.message : undefined
                });
            }

            throw error;
        }
    }

    async getAccountStats() {
        try {
            console.log('📊 Getting account stats from database...');

            // اگر accountService آمار نداد، مستقیماً از دیتابیس بگیر
            const [
                totalResult,
                statusCounts,
                resultCounts,
                recentActivity
            ] = await Promise.all([
                AccountModel.query().count('* as count').first(),
                AccountModel.query()
                    .select('status')
                    .count('* as count')
                    .groupBy('status'),
                AccountModel.query()
                    .select('result')
                    .count('* as count')
                    .groupBy('result')
                    .whereNotNull('result'),
                AccountModel.query()
                    .where('created_at', '>', db().raw("NOW() - INTERVAL '24 hours'"))
                    .count('* as count')
                    .first()
            ]);

            // تبدیل نتایج به object
            const statusStats = {};
            statusCounts.forEach(item => {
                statusStats[item.status] = parseInt(item.count);
            });

            const resultStats = {};
            resultCounts.forEach(item => {
                resultStats[item.result] = parseInt(item.count);
            });

            const stats = {
                total: parseInt(totalResult?.count) || 0,
                pending: statusStats.pending || 0,
                processing: statusStats.processing || 0,
                completed: statusStats.completed || 0,
                failed: statusStats.failed || 0,
                good: statusStats.good || 0,
                bad: statusStats.bad || 0,
                results: {
                    good: resultStats.good || 0,
                    bad: resultStats.bad || 0,
                    invalid: resultStats.invalid || 0,
                    '2fa': resultStats['2fa'] || 0,
                    passkey: resultStats.passkey || 0,
                    error: resultStats.error || 0,
                    lock: resultStats.lock || 0,
                    guard: resultStats.guard || 0,
                    'change-pass': resultStats['change-pass'] || 0,
                    'mobile-2step': resultStats['mobile-2step'] || 0,
                    timeout: resultStats.timeout || 0,
                    'server-error': resultStats['server-error'] || 0
                },
                recentActivity: parseInt(recentActivity?.count) || 0,
                successRate: statusStats.completed > 0 ?
                    Math.round(((resultStats.good || 0) / statusStats.completed) * 100) : 0
            };

            console.log('📊 Account stats retrieved with results:', {
                total: stats.total,
                results: stats.results
            });

            return stats;

        } catch (error) {
            console.error('❌ Error getting account stats:', error);
            return {
                total: 0,
                pending: 0,
                processing: 0,
                completed: 0,
                failed: 0,
                good: 0,
                bad: 0,
                results: {
                    good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0,
                    error: 0, lock: 0, guard: 0, 'change-pass': 0,
                    'mobile-2step': 0, timeout: 0, 'server-error': 0
                },
                recentActivity: 0,
                successRate: 0
            };
        }
    }

    async getProxyStats() {
        try {
            console.log('📊 Getting proxy stats from database...');

            // استفاده از proxyService برای آمار
            let serviceStats = null;
            let serviceInfo = null;

            try {
                serviceStats = await proxyService.getProxyStats();
                // دریافت اطلاعات سرویس پروکسی
                serviceInfo = await proxyService.getServiceInfo();
            } catch (serviceError) {
                console.warn('⚠️ ProxyService not available:', serviceError.message);
            }

            // اگر proxyService آمار نداد، مستقیماً از دیتابیس بگیر
            const [
                totalResult,
                avgResponseTimeResult,
                lastUpdateResult,
            ] = await Promise.all([
                ProxyModel.query().count('* as count').first(),
                ProxyModel.query()
                    .where('status', 'active')
                    .whereNotNull('responseTime')
                    .where('responseTime', '>', 0)
                    .avg('responseTime as avg')
                    .first(),
                ProxyModel.query().orderBy('updated_at', 'desc').first(),
            ]);

            const total = parseInt(totalResult?.count) || 0;
            const active = parseInt(activeResult?.count) || 0;
            const avgResponseTime = avgResponseTimeResult?.avg ?
                Math.round(avgResponseTimeResult.avg) : 0;

            const stats = {
                total: total,
                avgResponseTime: avgResponseTime,
                successRate: total > 0 ? Math.round((active / total) * 100) : 100,
                lastUpdate: lastUpdateResult?.updated_at || lastUpdateResult?.created_at || null,
                nextUpdate: serviceInfo?.nextUpdate || null,
                avgUsage: usageStats?.avgUsage ? Math.round(usageStats.avgUsage) : 0,

                // اطلاعات سرویس
                serviceStatus: serviceInfo?.isRunning || false,
                serviceLastUpdate: serviceInfo?.lastUpdate || null,
                serviceNextUpdate: serviceInfo?.nextUpdate || null,
                updateStatus: serviceInfo?.status || 'idle'
            };

            console.log('📊 Proxy stats retrieved:', {
                total: stats.total,
                active: stats.active,
                serviceStatus: stats.serviceStatus,
                lastUpdate: stats.lastUpdate
            });

            return stats;

        } catch (error) {
            console.error('❌ Error getting proxy stats:', error);
            return {
                total: 0,
                active: 0,
                available: 0,
                inactive: 0,
                avgResponseTime: 0,
                successRate: 0,
                lastUpdate: null,
                nextUpdate: null,
                totalUsage: 0,
                avgUsage: 0,
                serviceStatus: false,
                serviceLastUpdate: null,
                serviceNextUpdate: null,
                updateStatus: 'error'
            };
        }
    }

    async getBatchStats() {
        try {
            console.log('📊 Getting batch stats from database...');

            // اگر جدول Batches وجود داره
            try {
                const [
                    totalResult,
                    statusCounts,
                    recentBatches,
                    totalAccountsInBatches
                ] = await Promise.all([
                    AccountModel.db()('Batches').count('* as count').first(),
                    AccountModel.db()('Batches')
                        .select('status')
                        .count('* as count')
                        .groupBy('status'),
                    AccountModel.db()('Batches')
                        .where('created_at', '>', db().raw("NOW() - INTERVAL '24 hours'"))
                        .count('* as count')
                        .first(),
                    AccountModel.db()('Batches')
                        .sum('accountCount as total')
                        .first()
                ]);

                const statusStats = {};
                statusCounts.forEach(item => {
                    statusStats[item.status] = parseInt(item.count);
                });

                return {
                    total: parseInt(totalResult?.count) || 0,
                    processing: statusStats.processing || 0,
                    completed: statusStats.completed || 0,
                    failed: statusStats.failed || 0,
                    recent: parseInt(recentBatches?.count) || 0,
                    totalAccounts: parseInt(totalAccountsInBatches?.total) || 0
                };
            } catch (batchError) {
                // اگر جدول Batches وجود نداره، از batchId در Accounts استفاده کن
                const [
                    uniqueBatchesResult,
                    recentBatchesResult
                ] = await Promise.all([
                    AccountModel.query()
                        .countDistinct('batchId as count')
                        .whereNotNull('batchId')
                        .first(),
                    AccountModel.query()
                        .countDistinct('batchId as count')
                        .whereNotNull('batchId')
                        .where('created_at', '>', db().raw("NOW() - INTERVAL '24 hours'"))
                        .first()
                ]);

                return {
                    total: parseInt(uniqueBatchesResult?.count) || 0,
                    processing: 0,
                    completed: parseInt(uniqueBatchesResult?.count) || 0,
                    failed: 0,
                    recent: parseInt(recentBatchesResult?.count) || 0,
                    totalAccounts: 0
                };
            }

        } catch (error) {
            console.error('❌ Error getting batch stats:', error);
            return {
                total: 0,
                processing: 0,
                completed: 0,
                failed: 0,
                recent: 0,
                totalAccounts: 0
            };
        }
    }

    async getInstanceStats() {
        try {
            console.log('📊 Getting instance stats from Redis...');

            const instanceStats = await statsService.getInstanceStats();

            if (Array.isArray(instanceStats)) {
                const total = instanceStats.length;
                const active = instanceStats.filter(i => i.status === 'working').length;
                const idle = instanceStats.filter(i => i.status === 'idle').length;
                const error = instanceStats.filter(i => i.status === 'error').length;

                return {
                    total: total,
                    active: active,
                    idle: idle,
                    error: error,
                    healthy: instanceStats.filter(i =>
                        (Date.now() - i.lastHeartbeat) < 120000
                    ).length,
                    instances: instanceStats.slice(0, 10) // فقط 10 تای اول برای نمایش
                };
            }

            return {
                total: 0,
                active: 0,
                idle: 0,
                error: 0,
                healthy: 0,
                instances: []
            };

        } catch (error) {
            console.error('❌ Error getting instance stats:', error);
            return {
                total: 0,
                active: 0,
                idle: 0,
                error: 0,
                healthy: 0,
                instances: []
            };
        }
    }

    async getRedisStats() {
        try {
            console.log('📊 Getting Redis stats...');

            const systemStats = await statsService.getStats();
            const performanceStats = await statsService.getPerformanceStats(null, 10);

            return {
                systemStats: systemStats,
                recentPerformance: performanceStats,
                connected: true
            };

        } catch (error) {
            console.error('❌ Error getting Redis stats:', error);
            return {
                systemStats: {
                    totalProcessed: 0,
                    successCount: 0,
                    failedCount: 0,
                    successRate: 0,
                    activeInstances: 0
                },
                recentPerformance: [],
                connected: false
            };
        }
    }

    getSystemInfo() {
        try {
            const memoryUsage = process.memoryUsage();
            const cpus = os.cpus();

            return {
                uptime: process.uptime(),
                memory: {
                    used: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
                    total: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
                    system: Math.round(os.totalmem() / 1024 / 1024), // MB
                    free: Math.round(os.freemem() / 1024 / 1024), // MB
                    usage: Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100) // %
                },
                cpu: {
                    count: cpus.length,
                    model: cpus[0]?.model || 'Unknown',
                    speed: cpus[0]?.speed || 0,
                    load: os.loadavg(),
                    usage: this.calculateCpuUsage()
                },
                nodeVersion: process.version,
                platform: os.platform(),
                arch: os.arch(),
                hostname: os.hostname(),
                environment: process.env.NODE_ENV || 'development',
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
            };
        } catch (error) {
            console.error('❌ Error getting system info:', error);
            return {
                uptime: 0,
                memory: { used: 0, total: 0, system: 0, free: 0, usage: 0 },
                cpu: { count: 0, model: 'Unknown', speed: 0, load: [0, 0, 0], usage: 0 },
                nodeVersion: process.version,
                platform: 'unknown',
                arch: 'unknown',
                hostname: 'unknown',
                environment: 'development',
                timezone: 'UTC'
            };
        }
    }

    calculateCpuUsage() {
        try {
            const load = os.loadavg();
            const cpuCount = os.cpus().length;
            return Math.round((load[0] / cpuCount) * 100);
        } catch (error) {
            return 0;
        }
    }

    calculateSystemHealth(accountStats, proxyStats, instanceStats) {
        try {
            let healthScore = 0;

            // بررسی پروکسی‌ها (40% وزن)
            if (proxyStats.active > 0) {
                healthScore += 40;
            }

            // بررسی instance ها (40% وزن)
            if (instanceStats.total > 0) {
                const healthyRatio = instanceStats.healthy / instanceStats.total;
                healthScore += Math.round(healthyRatio * 40);
            }

            // بررسی آمار کلی (20% وزن)
            if (accountStats.total > 0) {
                healthScore += 20;
            }

            return {
                score: healthScore,
                status: healthScore >= 80 ? 'excellent' :
                    healthScore >= 60 ? 'good' :
                        healthScore >= 40 ? 'warning' : 'critical',
                message: this.getHealthMessage(healthScore)
            };
        } catch (error) {
            return {
                score: 0,
                status: 'critical',
                message: 'خطا در محاسبه سلامت سیستم'
            };
        }
    }

    getHealthMessage(score) {
        if (score >= 80) return 'سیستم در وضعیت عالی کار می‌کند';
        if (score >= 60) return 'سیستم در وضعیت خوب کار می‌کند';
        if (score >= 40) return 'سیستم نیاز به توجه دارد';
        return 'سیستم در وضعیت بحرانی است';
    }

    async getPerformanceStats(req, res) {
        try {
            const [
                memoryStats,
                performanceHistory
            ] = await Promise.all([
                this.getDetailedMemoryStats(),
                statsService.getPerformanceStats(null, 20)
            ]);

            const stats = {
                memory: memoryStats,
                cpu: {
                    usage: this.calculateCpuUsage(),
                    load: os.loadavg(),
                    count: os.cpus().length
                },
                uptime: process.uptime(),
                performance: performanceHistory,
                timestamp: Date.now()
            };

            res.json({
                success: true,
                data: stats
            });
        } catch (error) {
            console.error('❌ Error getting performance stats:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در دریافت آمار عملکرد'
            });
        }
    }

    getDetailedMemoryStats() {
        const usage = process.memoryUsage();
        const total = os.totalmem();
        const free = os.freemem();

        return {
            heap: {
                used: Math.round(usage.heapUsed / 1024 / 1024),
                total: Math.round(usage.heapTotal / 1024 / 1024),
                usage: Math.round((usage.heapUsed / usage.heapTotal) * 100)
            },
            system: {
                total: Math.round(total / 1024 / 1024),
                free: Math.round(free / 1024 / 1024),
                used: Math.round((total - free) / 1024 / 1024),
                usage: Math.round(((total - free) / total) * 100)
            },
            process: {
                rss: Math.round(usage.rss / 1024 / 1024),
                external: Math.round(usage.external / 1024 / 1024)
            }
        };
    }

    async getRealTimeStats(req, res) {
        try {
            const stats = await this.getSystemStats();

            res.json({
                success: true,
                data: stats.data,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('❌ Error getting realtime stats:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در دریافت آمار لحظه‌ای'
            });
        }
    }

    async getHistoricalStats(req, res) {
        try {
            const days = parseInt(req.query.days) || 7;
            const limit = parseInt(req.query.limit) || 100;

            const performanceHistory = await statsService.getPerformanceStats(null, limit);

            // گروه‌بندی بر اساس روز
            const dailyStats = this.groupStatsByDay(performanceHistory, days);

            res.json({
                success: true,
                data: {
                    daily: dailyStats,
                    raw: performanceHistory,
                    period: `${days} روز گذشته`
                }
            });
        } catch (error) {
            console.error('❌ Error getting historical stats:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در دریافت آمار تاریخی'
            });
        }
    }

    groupStatsByDay(stats, days) {
        const dailyGroups = {};
        const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);

        stats
            .filter(stat => stat.timestamp > cutoffTime)
            .forEach(stat => {
                const date = new Date(stat.timestamp).toDateString();

                if (!dailyGroups[date]) {
                    dailyGroups[date] = {
                        date: date,
                        totalBatches: 0,
                        totalAccounts: 0,
                        avgProcessingTime: 0,
                        avgSuccessRate: 0,
                        count: 0
                    };
                }

                const group = dailyGroups[date];
                group.totalBatches += 1;
                group.totalAccounts += stat.batchSize || 0;
                group.avgProcessingTime += stat.processingTime || 0;
                group.avgSuccessRate += stat.successRate || 0;
                group.count += 1;
            });

        // محاسبه میانگین‌ها
        Object.values(dailyGroups).forEach(group => {
            if (group.count > 0) {
                group.avgProcessingTime = Math.round(group.avgProcessingTime / group.count);
                group.avgSuccessRate = Math.round(group.avgSuccessRate / group.count);
            }
        });

        return Object.values(dailyGroups).sort((a, b) =>
            new Date(a.date) - new Date(b.date)
        );
    }

    // Method برای تست اتصال دیتابیس
    async testDatabaseConnection() {
        try {
            console.log('🔍 Testing database connection...');

            const [accountCount, proxyCount] = await Promise.all([
                AccountModel.query().count('* as count').first(),
                ProxyModel.query().count('* as count').first()
            ]);

            const result = {
                accounts: parseInt(accountCount?.count) || 0,
                proxies: parseInt(proxyCount?.count) || 0,
                connected: true,
                timestamp: Date.now()
            };

            console.log('✅ Database connection test successful:', result);
            return result;

        } catch (error) {
            console.error('❌ Database connection test failed:', error);
            throw error;
        }
    }

    // متد برای تست اتصال Redis
    async testRedisConnection() {
        try {
            console.log('🔍 Testing Redis connection...');

            const stats = await statsService.getStats();

            console.log('✅ Redis connection test successful');
            return {
                connected: true,
                stats: stats,
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('❌ Redis connection test failed:', error);
            throw error;
        }
    }

    // متد برای دریافت آمار کامل سیستم
    async getFullSystemReport(req, res) {
        try {
            const [
                systemStats,
                dbTest,
                redisTest,
                performanceStats
            ] = await Promise.all([
                this.getSystemStats(),
                this.testDatabaseConnection(),
                this.testRedisConnection(),
                statsService.calculateSummaryStats()
            ]);

            const report = {
                overview: systemStats.data,
                connections: {
                    database: dbTest,
                    redis: redisTest
                },
                performance: performanceStats,
                generatedAt: new Date().toISOString(),
                version: process.env.npm_package_version || '1.0.0'
            };

            res.json({
                success: true,
                data: report
            });

        } catch (error) {
            console.error('❌ Error generating full system report:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در تولید گزارش کامل سیستم',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
}

module.exports = new StatsController();