const BaseModel = require('./BaseModel');

class BatchModel extends BaseModel {
    constructor() {
        super('Batches');
    }

    async getBatchStats() {
        try {
            // استفاده از Knex برای گروه‌بندی
            const stats = await this.query()
                .select('status')
                .count('* as count')
                .groupBy('status');

            const batchStats = {
                totalBatches: 0,
                completedBatches: 0,
                processingBatches: 0,
                failedBatches: 0
            };

            stats.forEach(stat => {
                const count = parseInt(stat.count);
                batchStats.totalBatches += count;

                switch (stat.status) {
                    case 'completed':
                        batchStats.completedBatches = count;
                        break;
                    case 'processing':
                        batchStats.processingBatches = count;
                        break;
                    case 'failed':
                        batchStats.failedBatches = count;
                        break;
                }
            });

            return batchStats;
        } catch (error) {
            console.error('❌ خطا در دریافت آمار batch ها:', error);
            return {
                totalBatches: 0,
                completedBatches: 0,
                processingBatches: 0,
                failedBatches: 0
            };
        }
    }

    // دریافت جزئیات batch
    async getBatchDetails(batchId) {
        try {
            const batch = await this.findOne({ batchId });

            if (!batch) {
                return null;
            }

            const successRate = batch.accountCount > 0 ?
                Math.round((batch.statsGood / batch.accountCount) * 100) : 0;

            return {
                ...batch,
                successRate,
                remaining: batch.accountCount - batch.statsSaved,
                processed: batch.statsSaved,
                pending: batch.statsPending
            };

        } catch (error) {
            console.error(`❌ خطا در دریافت جزئیات batch ${batchId}:`, error);
            return null;
        }
    }

    // دریافت لیست batch ها
    async getAllBatches(limit = 50, offset = 0) {
        try {
            const batches = await this.query()
                .select('*')
                .orderBy('created_at', 'desc')
                .limit(limit)
                .offset(offset);

            return batches.map(batch => ({
                ...batch,
                successRate: batch.accountCount > 0 ?
                    Math.round((batch.statsGood / batch.accountCount) * 100) : 0,
                progress: batch.accountCount > 0 ?
                    Math.round((batch.statsSaved / batch.accountCount) * 100) : 0
            }));

        } catch (error) {
            console.error('❌ خطا در دریافت لیست batch ها:', error);
            return [];
        }
    }
}

module.exports = new BatchModel();