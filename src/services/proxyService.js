// src/services/proxyService.js
const Proxy = require('../models/Proxy');

class ProxyService {
    constructor() {
        console.log('🌐 ProxyService initialized - Single use mode');
    }

    /**
    * دریافت پروکسی برای instance خاص (تابع گمشده)
    */
    async getProxyForInstance(instanceId) {
        try {
            // پیدا کردن یک پروکسی فعال و حذف آن در همان عملیات
            const proxy = await Proxy.findOneAndDelete(
                { status: 'active' },
                {
                    sort: {
                        usageCount: 1, // کم‌استفاده‌ترین
                        responseTime: 1, // سریع‌ترین
                        createdAt: 1 // قدیمی‌ترین
                    }
                }
            );

            if (!proxy) {
                console.log(`⚠️ No available proxy found for instance: ${instanceId}`);
                return null;
            }

            console.log(`🌐 Proxy assigned to ${instanceId}: ${proxy.host}:${proxy.port}`);

            return {
                id: proxy._id.toString(),
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
    * گزارش وضعیت پروکسی (تابع گمشده)
    */
    async reportProxyStatus(proxyId, instanceId, success, responseTime, error = null) {
        try {
            // چون پروکسی بعد از استفاده حذف میشه، فقط لاگ می‌کنیم
            const status = success ? '✅ SUCCESS' : '❌ FAILED';
            const errorMsg = error ? ` - Error: ${error}` : '';

            console.log(`📊 Proxy Report [${proxyId}] by ${instanceId}: ${status} (${responseTime}ms)${errorMsg}`);

            // اختیاری: ذخیره آمار در دیتابیس یا Redis
            // این بخش رو می‌تونی برای آمارگیری اضافه کنی

            return true;
        } catch (err) {
            console.error('خطا در گزارش وضعیت پروکسی:', err);
            return false;
        }
    }

    /**
    * آزادسازی پروکسی‌های stuck (برای سازگاری با کد قبلی)
    */
    async releaseStuckProxies(timeoutMinutes = 10) {
        try {
            // چون پروکسی‌ها بعد از استفاده حذف میشن، نیازی به آزادسازی نیست
            // ولی برای سازگاری این تابع رو نگه می‌داریم

            console.log(`🔄 Checking for stuck proxies (timeout: ${timeoutMinutes}min)`);

            // اختیاری: پاکسازی پروکسی‌های قدیمی
            const cleanedCount = await this.cleanupOldProxies(24);

            console.log(`🧹 Cleaned up ${cleanedCount} old proxies`);
            return cleanedCount;
        } catch (error) {
            console.error('خطا در آزادسازی پروکسی‌های stuck:', error);
            return 0;
        }
    }

    /**
    * دریافت آمار پروکسی‌ها
    */
    async getProxyStats() {
        try {
            const [
                totalProxies,
                avgResponseTime
            ] = await Promise.all([
                Proxy.countDocuments({ status: 'active' }),
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
                ])
            ]);

            const stats = {
                total: totalProxies,
                available: totalProxies,
                in_use: 0, // چون پروکسی‌ها یکبار مصرف هستن
                failed: 0,
                testing: 0,
                avgResponseTime: avgResponseTime.length > 0 ?
                    Math.round(avgResponseTime[0].avg) : 0,
                avg_response_time: avgResponseTime.length > 0 ?
                    Math.round(avgResponseTime[0].avg) : 0 // برای سازگاری
            };

            return stats;

        } catch (error) {
            console.error('❌ Error getting proxy stats:', error);
            return {
                total: 0,
                available: 0,
                in_use: 0,
                failed: 0,
                testing: 0,
                avgResponseTime: 0,
                avg_response_time: 0
            };
        }
    }

    // دریافت و حذف پروکسی (استفاده یکبار)
    async getAndConsumeProxy() {
        // این تابع همون کار getProxyForInstance رو می‌کنه
        return await this.getProxyForInstance('direct-consume');
    }

    // ساخت URL پروکسی
    buildProxyUrl(proxy) {
        const auth = proxy.username && proxy.password ?
            `${proxy.username}:${proxy.password}@` : '';
        const protocol = proxy.protocol || 'http';
        return `${protocol}://${auth}${proxy.host}:${proxy.port}`;
    }

    // دریافت تمام پروکسی‌های موجود (برای نمایش)
    async getAllProxies(limit = 100) {
        try {
            const proxies = await Proxy.find({ status: 'active' })
                .select('host port protocol responseTime createdAt usageCount')
                .sort({ responseTime: 1, createdAt: 1 })
                .limit(limit);

            return proxies.map(proxy => ({
                id: proxy._id.toString(),
                host: proxy.host,
                port: proxy.port,
                protocol: proxy.protocol || 'http',
                responseTime: proxy.responseTime || 0,
                createdAt: proxy.createdAt,
                usageCount: proxy.usageCount || 0,
                status: 'active'
            }));

        } catch (error) {
            console.error('❌ Error getting all proxies:', error);
            return [];
        }
    }

    // حذف پروکسی‌های قدیمی (اختیاری - برای پاکسازی)
    async cleanupOldProxies(olderThanHours = 24) {
        try {
            const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));

            const result = await Proxy.deleteMany({
                createdAt: { $lt: cutoffTime }
            });

            if (result.deletedCount > 0) {
                console.log(`🗑️ Cleaned up ${result.deletedCount} old proxies`);
            }

            return result.deletedCount;

        } catch (error) {
            console.error('❌ Error cleaning up old proxies:', error);
            return 0;
        }
    }

    // تست یک پروکسی (بدون حذف)
    async testSingleProxy(proxyString) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            try {
                // پارس پروکسی
                const [hostPort, auth] = proxyString.includes('@') ?
                    proxyString.split('@').reverse() : [proxyString, null];

                const [host, port] = hostPort.split(':');
                const [username, password] = auth ? auth.split(':') : [null, null];

                if (!host || !port) {
                    return resolve({
                        success: false,
                        error: 'فرمت پروکسی نامعتبر',
                        responseTime: null
                    });
                }

                // تست پروکسی
                const http = require('http');
                const options = {
                    hostname: host,
                    port: parseInt(port),
                    path: 'https://my.account.sony.com',
                    method: 'GET',
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };

                if (username && password) {
                    const auth = Buffer.from(`${username}:${password}`).toString('base64');
                    options.headers['Proxy-Authorization'] = `Basic ${auth}`;
                }

                const request = http.request(options, (response) => {
                    const responseTime = Date.now() - startTime;

                    resolve({
                        success: response.statusCode < 400,
                        responseTime,
                        statusCode: response.statusCode,
                        host,
                        port: parseInt(port)
                    });
                });

                request.on('error', (error) => {
                    resolve({
                        success: false,
                        error: error.message,
                        responseTime: Date.now() - startTime,
                        host,
                        port: parseInt(port)
                    });
                });

                request.on('timeout', () => {
                    request.destroy();
                    resolve({
                        success: false,
                        error: 'Timeout',
                        responseTime: Date.now() - startTime,
                        host,
                        port: parseInt(port)
                    });
                });

                request.end();

            } catch (error) {
                resolve({
                    success: false,
                    error: error.message,
                    responseTime: Date.now() - startTime
                });
            }
        });
    }

    // دریافت پروکسی بعدی (بدون حذف - برای نمایش)
    async getNextProxy() {
        try {
            const proxy = await Proxy.findOne({ status: 'active' })
                .sort({ usageCount: 1, responseTime: 1 });

            if (!proxy) {
                return null;
            }

            return {
                id: proxy._id.toString(),
                host: proxy.host,
                port: proxy.port,
                username: proxy.username,
                password: proxy.password,
                protocol: proxy.protocol || 'http',
                responseTime: proxy.responseTime || 0,
                url: this.buildProxyUrl(proxy)
            };

        } catch (error) {
            console.error('❌ Error getting next proxy:', error);
            return null;
        }
    }

    /**
    * آزادسازی اکانت‌های قفل شده (برای سازگاری)
    */
    async releaseAccountsByIds(accountIds) {
        // این تابع در accountService باید باشه، نه proxyService
        // ولی برای جلوگیری از خطا، یه تابع خالی می‌ذاریم
        console.log(`⚠️ releaseAccountsByIds called in proxyService - should be in accountService`);
        return true;
    }
}

module.exports = new ProxyService();