const BaseModel = require('./BaseModel');

class BatchModel extends BaseModel {
    constructor() {
        super('Batches');
    }

    async getBatchStats() {
        try {
            const stats = await this.groupCount('status');

            const batchStats = {
                totalBatches: 0,
                completedBatches: 0,
                processingBatches: 0,
                queuedBatches: 0
            };

            stats.forEach(stat => {
                batchStats.totalBatches += stat.count;

                switch (stat._id) {
                    case 'completed':
                        batchStats.completedBatches = stat.count;
                        break;
                    case 'processing':
                        batchStats.processingBatches = stat.count;
                        break;
                    case 'queued':
                    case 'pending':
                        batchStats.queuedBatches += stat.count;
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
                queuedBatches: 0
            };
        }
    }

    // متد افزایش نتیجه batch
    async incrementResult(batchId, resultType) {
        const columnMap = {
            'good': 'goodCount',
            'bad': 'badCount',
            'invalid': 'invalidCount',
            '2fa': 'twoFaCount',
            'passkey': 'passkeyCount',
            'error': 'errorCount'
        };

        const column = columnMap[resultType];
        if (!column) return;

        await this.query()
            .where('batchId', batchId)
            .increment(column, 1);
    }
}

module.exports = new BatchModel();