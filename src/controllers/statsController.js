const Account = require('../models/Account');
const Proxy = require('../models/Proxy');
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
                systemInfo
            ] = await Promise.all([
                this.getAccountStats(),
                this.getProxyStats(),
                this.getSystemInfo()
            ]);

            const stats = {
                accounts: accountStats,
                proxies: proxyStats,
                system: systemInfo,
                batches: {
                    total: 0,
                    completed: 0
                },
                timestamp: Date.now()
            };

            console.log('📊 System stats compiled:', {
                totalAccounts: stats.accounts.total,
                pendingAccounts: stats.accounts.pending,
                activeProxies: stats.proxies.active,
                totalProxies: stats.proxies.total
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

            const [
                totalAccounts,
                pendingAccounts,
                processingAccounts,
                completedAccounts,
                failedAccounts,
                accountResults
            ] = await Promise.all([
                Account.countDocuments({}),
                Account.countDocuments({ status: 'pending' }),
                Account.countDocuments({ status: 'processing' }),
                Account.countDocuments({ status: 'completed' }),
                Account.countDocuments({ status: 'failed' }),
                Account.aggregate([
                    {
                        $match: { result: { $ne: null } }
                    },
                    {
                        $group: {
                            _id: '$result',
                            count: { $sum: 1 }
                        }
                    }
                ])
            ]);

            // تبدیل نتایج aggregate به object
            const results = {};
            accountResults.forEach(item => {
                results[item._id] = item.count;
            });

            const stats = {
                total: totalAccounts,
                pending: pendingAccounts,
                processing: processingAccounts,
                completed: completedAccounts,
                failed: failedAccounts,
                results: {
                    good: results.good || 0,
                    bad: results.bad || 0,
                    invalid: results.invalid || 0,
                    '2fa': results['2fa'] || 0,
                    passkey: results.passkey || 0,
                    error: results.error || 0,
                    lock: results.lock || 0,
                    guard: results.guard || 0,
                    'change-pass': results['change-pass'] || 0,
                    'mobile-2step': results['mobile-2step'] || 0,
                    timeout: results.timeout || 0,
                    'server-error': results['server-error'] || 0
                }
            };

            console.log('📊 Account stats retrieved:', stats);
            return stats;

        } catch (error) {
            console.error('❌ Error getting account stats:', error);
            return {
                total: 0,
                pending: 0,
                processing: 0,
                completed: 0,
                failed: 0,
                results: {
                    good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0,
                    error: 0, lock: 0, guard: 0, 'change-pass': 0,
                    'mobile-2step': 0, timeout: 0, 'server-error': 0
                }
            };
        }
    }

    async getProxyStats() {
        try {
            console.log('📊 Getting proxy stats from database...');

            const [
                availableProxies,
                totalEverCreated,
                avgResponseTimeResult,
                lastUpdateProxy
            ] = await Promise.all([
                Proxy.countDocuments({ status: 'active' }), // پروکسی‌های موجود
                Proxy.countDocuments({}), // تمام پروکسی‌ها (حتی استفاده شده‌ها که حذف شده‌اند)
                Proxy.aggregate([
                    {
                        $match: {
                            status: 'active',
                            responseTime: { $ne: null, $gt: 0 }
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            avg: { $avg: '$responseTime' }
                        }
                    }
                ]),
                Proxy.findOne({}, {}, { sort: { createdAt: -1 } })
            ]);

            const avgResponseTime = avgResponseTimeResult.length > 0 ?
                Math.round(avgResponseTimeResult[0].avg) : 0;

            const stats = {
                total: availableProxies, // پروکسی‌های موجود
                active: availableProxies, // همان available
                available: availableProxies, // پروکسی‌های قابل استفاده
                used: 0, // چون بعد از استفاده حذف می‌شوند
                failed: 0, // چون پروکسی‌های failed ذخیره نمی‌شوند
                avgResponseTime,
                successRate: 100, // چون فقط پروکسی‌های موفق ذخیره می‌شوند
                lastUpdate: lastUpdateProxy?.createdAt || null,
                nextUpdate: null
            };

            console.log('📊 Proxy stats retrieved:', stats);
            return stats;

        } catch (error) {
            console.error('❌ Error getting proxy stats:', error);
            return {
                total: 0,
                active: 0,
                available: 0,
                used: 0,
                failed: 0,
                avgResponseTime: 0,
                successRate: 0,
                lastUpdate: null,
                nextUpdate: null
            };
        }
    }

    getSystemInfo() {
        try {
            const memoryUsage = process.memoryUsage();

            return {
                uptime: process.uptime(),
                memory: {
                    used: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
                    total: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
                    system: Math.round(os.totalmem() / 1024 / 1024), // MB
                    free: Math.round(os.freemem() / 1024 / 1024) // MB
                },
                cpu: {
                    count: os.cpus().length,
                    model: os.cpus()[0]?.model || 'Unknown',
                    load: os.loadavg()
                },
                nodeVersion: process.version,
                platform: os.platform(),
                arch: os.arch(),
                environment: process.env.NODE_ENV || 'development'
            };
        } catch (error) {
            console.error('❌ Error getting system info:', error);
            return {
                uptime: 0,
                memory: { used: 0, total: 0, system: 0, free: 0 },
                cpu: { count: 0, model: 'Unknown', load: [0, 0, 0] },
                nodeVersion: process.version,
                platform: 'unknown',
                arch: 'unknown',
                environment: 'development'
            };
        }
    }

    async getPerformanceStats(req, res) {
        try {
            const stats = {
                memory: process.memoryUsage(),
                cpu: os.loadavg(),
                uptime: process.uptime(),
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
            // Implementation for historical stats
            res.json({
                success: true,
                data: {
                    message: 'Historical stats - to be implemented'
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

    // Method برای تست اتصال دیتابیس
    async testDatabaseConnection() {
        try {
            console.log('🔍 Testing database connection...');

            const accountCount = await Account.countDocuments({});
            const proxyCount = await Proxy.countDocuments({});

            console.log('✅ Database connection test successful:', {
                accounts: accountCount,
                proxies: proxyCount
            });

            return { accounts: accountCount, proxies: proxyCount };
        } catch (error) {
            console.error('❌ Database connection test failed:', error);
            throw error;
        }
    }
}

module.exports = new StatsController();