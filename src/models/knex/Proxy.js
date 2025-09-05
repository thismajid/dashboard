const BaseModel = require('./BaseModel');
const { db } = require('../../config/database')

class ProxyModel extends BaseModel {
    constructor() {
        super('Proxies');
    }

    async getProxyStats() {
        try {
            const [totalResult, avgResult] = await Promise.all([
                this.countDocuments({ status: 'active' }),
                this.query()
                    .where('status', 'active')
                    .whereNotNull('responseTime')
                    .where('responseTime', '>', 0)
                    .avg('responseTime as avg')
            ]);

            const avgResponseTime = avgResult[0]?.avg ? Math.round(avgResult[0].avg) : 0;

            return {
                total: totalResult,
                available: totalResult,
                in_use: 0,
                failed: 0,
                testing: 0,
                avgResponseTime,
                avg_response_time: avgResponseTime
            };

        } catch (error) {
            console.error('❌ خطا در دریافت آمار پروکسی‌ها:', error);
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

    // پیدا کردن و حذف پروکسی در یک عملیات اتمیک
    async findOneAndDelete(conditions, options = {}) {
        const trx = await db().transaction();

        try {
            let query = trx(this.tableName);

            // اعمال شرایط
            Object.keys(conditions).forEach(key => {
                if (conditions[key] !== undefined) {
                    query = query.where(key, conditions[key]);
                }
            });

            // اعمال مرتب‌سازی
            if (options.sort) {
                Object.keys(options.sort).forEach(field => {
                    const direction = options.sort[field] === 1 ? 'asc' : 'desc';
                    query = query.orderBy(field, direction);
                });
            }

            // گرفتن اولین رکورد
            const proxy = await query.first();

            if (!proxy) {
                await trx.commit();
                return null;
            }

            // حذف رکورد
            await trx(this.tableName).where('id', proxy.id).del();

            await trx.commit();
            return proxy;

        } catch (error) {
            await trx.rollback();
            throw error;
        }
    }
}

module.exports = new ProxyModel();