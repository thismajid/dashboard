const { db } = require('../config/database');
const ProxyModel = require('../models/knex/Proxy');

class ProxyService {
    constructor() {
        console.log('🌐 ProxyService initialized - Single use mode');
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

            // اختیاری: ذخیره آمار در دیتابیس یا Redis
            // این بخش رو می‌تونی برای آمارگیری اضافه کنی

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

            // پاکسازی پروکسی‌های قدیمی
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
                usageCount: proxy.usageCount || 0,
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
    async cleanupOldProxies(olderThanHours = 24) {
        try {
            const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));

            const deletedCount = await ProxyModel.deleteMany({
                created_at: cutoffTime // کمتر از زمان مشخص شده
            });

            if (deletedCount > 0) {
                console.log(`🗑️ Cleaned up ${deletedCount} old proxies`);
            }

            return deletedCount;

        } catch (error) {
            console.error('❌ Error cleaning up old proxies:', error);
            return 0;
        }
    }

    /**
    * تست یک پروکسی
    */
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

    /**
    * دریافت پروکسی بعدی (بدون حذف)
    */
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

            return {
                id: proxy.id.toString(),
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
    * بروزرسانی پروکسی‌ها (جایگزینی کل لیست) با تراکنش
    */
    async updateProxies(newProxies) {
        const trx = await db().transaction();

        try {
            const proxyModel = ProxyModel.withTransaction(trx);

            if (newProxies && newProxies.length > 0) {
                // حذف تمام پروکسی‌های موجود
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
                    usageCount: proxy.usageCount || 0,
                    created_at: new Date(),
                    updated_at: new Date()
                }));

                await proxyModel.insertMany(proxyRows);
            }

            await trx.commit();
            console.log(`✅ ${newProxies?.length || 0} پروکسی بروزرسانی شد`);
            return newProxies?.length || 0;

        } catch (error) {
            await trx.rollback();
            console.error('❌ خطا در بروزرسانی پروکسی‌ها:', error);
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
}

module.exports = new ProxyService();