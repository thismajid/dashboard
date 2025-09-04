const Account = require('../models/Account');
const Batch = require('../models/Batch');
const { v4: uuidv4 } = require('uuid');

class AccountService {
    /**
* دریافت آمار اکانت‌ها
*/
    async getStats() {
        try {
            const [accountStats, batchStats] = await Promise.all([
                this.getAccountStats(),
                this.getBatchStats()
            ]);

            return {
                accounts: accountStats,
                batches: batchStats
            };
        } catch (error) {
            console.error('خطا در دریافت آمار اکانت:', error);
            return {
                accounts: {
                    total: 0,
                    pending: 0,
                    processing: 0,
                    completed: 0,
                    good: 0,
                    bad: 0,
                    invalid: 0,
                    '2fa': 0,
                    passkey: 0,
                    error: 0
                },
                batches: {
                    totalBatches: 0,
                    completedBatches: 0,
                    processingBatches: 0,
                    queuedBatches: 0
                }
            };
        }
    }

    /**
    * دریافت آمار اکانت‌ها
    */
    async getAccountStats() {
        try {
            const stats = await Account.aggregate([
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 }
                    }
                }
            ]);

            const accountStats = {
                total: 0,
                pending: 0,
                processing: 0,
                completed: 0,
                good: 0,
                bad: 0,
                invalid: 0,
                '2fa': 0,
                passkey: 0,
                error: 0
            };

            stats.forEach(stat => {
                accountStats.total += stat.count;

                if (accountStats.hasOwnProperty(stat._id)) {
                    accountStats[stat._id] = stat.count;
                }

                // محاسبه completed
                if (['good', 'bad', 'invalid', '2fa', 'passkey', 'error'].includes(stat._id)) {
                    accountStats.completed += stat.count;
                }
            });

            return accountStats;
        } catch (error) {
            console.error('خطا در دریافت آمار اکانت‌ها:', error);
            return {
                total: 0,
                pending: 0,
                processing: 0,
                completed: 0,
                good: 0,
                bad: 0,
                invalid: 0,
                '2fa': 0,
                passkey: 0,
                error: 0
            };
        }
    }

    /**
    * دریافت آمار batch ها
    */
    async getBatchStats() {
        try {
            const stats = await Batch.aggregate([
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 }
                    }
                }
            ]);

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
            console.error('خطا در دریافت آمار batch ها:', error);
            return {
                totalBatches: 0,
                completedBatches: 0,
                processingBatches: 0,
                queuedBatches: 0
            };
        }
    }
    /**
     * ذخیره batch جدید اکانت‌ها
     */
    async saveBatch(accounts, batchInfo) {
        try {
                            // ایجاد batch record
                const batch = new Batch({
                    batchId: batchInfo.batchId,
                    fileName: batchInfo.fileName,
                    fileSize: batchInfo.fileSize,
                    fileType: batchInfo.fileType,
                    filePath: batchInfo.filePath,
                    totalAccounts: accounts.length,
                    status: 'queued',
                    uploadedBy: batchInfo.uploadedBy || {}
                });

                await batch.save();

                // آماده‌سازی اکانت‌ها
                const accountDocs = accounts.map((account, index) => ({
                    username: account.username || account.data || `account_${index}`,
                    password: account.password || '',
                    email: account.email || null,
                    batchId: batchInfo.batchId,
                    originalIndex: index,
                    status: 'pending',
                    metadata: {
                        originalData: account,
                        lineNumber: account.lineNumber || index + 1
                    }
                }));

                // bulk insert اکانت‌ها
                await Account.insertMany(accountDocs);

                console.log(`✅ ${accounts.length} اکانت در batch ${batchInfo.batchId} ذخیره شد`);
                return batchInfo.batchId;
        } catch (error) {
            console.error('خطا در ذخیره batch:', error);
            throw error;
        }
    }

    /**
     * دریافت batch اکانت‌ها برای instance خاص
     */
    async getAccountBatch(instanceId, batchSize = 2) {
        try {
                            // پیدا کردن اکانت‌های آماده پردازش
                const accounts = await Account.find({
                    status: 'pending',
                    $or: [
                        { lockedBy: { $exists: false } },
                        { lockedBy: null },
                        {
                            lockedAt: {
                                $lt: new Date(Date.now() - 10 * 60 * 1000) // 10 دقیقه timeout
                            }
                        }
                    ]
                })
                    .sort({ createdAt: 1, processingAttempts: 1 }) // FIFO + کم‌ترین تلاش
                    .limit(batchSize)

                if (accounts.length === 0) {
                    return [];
                }

                // قفل کردن اکانت‌ها
                const accountIds = accounts.map(acc => acc._id);
                await Account.updateMany(
                    { _id: { $in: accountIds } },
                    {
                        $set: {
                            status: 'processing',
                            lockedBy: instanceId,
                            lockedAt: new Date()
                        },
                        $inc: { processingAttempts: 1 }
                    }
                );

                // به‌روزرسانی وضعیت batch به processing
                const batchIds = [...new Set(accounts.map(acc => acc.batchId))];
                await Batch.updateMany(
                    {
                        batchId: { $in: batchIds },
                        status: 'queued'
                    },
                    {
                        $set: {
                            status: 'processing',
                            startedAt: new Date()
                        }
                    }
                );

                // فرمت کردن برای اسکریپت
                return accounts.map(acc => ({
                    id: acc._id.toString(),
                    email: acc.email,
                    password: acc.password,
                    batchId: acc.batchId,
                    originalIndex: acc.originalIndex,
                    attempts: acc.processingAttempts
                }));
        } catch (error) {
            console.error('خطا در دریافت batch اکانت‌ها:', error);
            throw error;
        }
    }

    /**
     * ثبت نتایج batch اکانت‌ها
     */
    async submitBatchResults(instanceId, results) {
        try {
                for (const result of results) {
                    const account = await Account.findById(result.accountId);
                    if (!account) {
                        console.warn(`Account not found: ${result.accountId}`);
                        continue;
                    }

                    // به‌روزرسانی اکانت
                    await Account.findByIdAndUpdate(
                        result.accountId,
                        {
                            $set: {
                                status: 'completed',
                                checkResult: this.mapStatusToResult(result.status),
                                resultDetails: {
                                    message: result.message || '',
                                    errorCode: result.errorCode || null,
                                    responseTime: result.responseTime || 0,
                                    checkedAt: new Date(),
                                    instanceId: instanceId,
                                    originalStatus: result.status,
                                    screenshotPath: result.screenshotPath || null
                                },
                                lockedBy: null,
                                lockedAt: null,
                                updatedAt: new Date()
                            }
                        }
                    );

                    // به‌روزرسانی آمار batch
                    const batch = await Batch.findOne({ batchId: account.batchId });
                    if (batch) {
                        await batch.incrementResult(this.mapStatusToResult(result.status));
                    }
                }

            console.log(`✅ ${results.length} نتیجه از instance ${instanceId} ثبت شد`);

        } catch (error) {
            console.error('خطا در ثبت نتایج:', error);
            throw error;
        }
    }

    /**
     * آزادسازی اکانت‌های قفل شده توسط instance خاص
     */
    async releaseLockedAccounts(instanceId) {
        try {
            const result = await Account.updateMany(
                {
                    lockedBy: instanceId,
                    status: 'processing'
                },
                {
                    $set: {
                        status: 'pending',
                        lockedBy: null,
                        lockedAt: null
                    }
                }
            );

            console.log(`🔓 ${result.modifiedCount} اکانت از instance ${instanceId} آزاد شد`);
            return result.modifiedCount;

        } catch (error) {
            console.error('خطا در آزادسازی اکانت‌ها:', error);
            throw error;
        }
    }

    /**
     * آزادسازی اکانت‌ها بر اساس ID
     */
    async releaseAccountsByIds(accountIds) {
        try {
            const result = await Account.updateMany(
                {
                    _id: { $in: accountIds },
                    status: 'processing'
                },
                {
                    $set: {
                        status: 'pending',
                        lockedBy: null,
                        lockedAt: null
                    }
                }
            );

            console.log(`🔓 ${result.modifiedCount} اکانت آزاد شد`);
            return result.modifiedCount;

        } catch (error) {
            console.error('خطا در آزادسازی اکانت‌ها:', error);
            throw error;
        }
    }

    /**
     * دریافت آمار کلی
     */
    async getStats() {
        try {
            const [accountStats, batchStats] = await Promise.all([
                Account.aggregate([
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            pending: {
                                $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] }
                            },
                            processing: {
                                $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] }
                            },
                            completed: {
                                $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                            },
                            good: {
                                $sum: { $cond: [{ $eq: ['$checkResult', 'good'] }, 1, 0] }
                            },
                            bad: {
                                $sum: { $cond: [{ $eq: ['$checkResult', 'bad'] }, 1, 0] }
                            },
                            invalid: {
                                $sum: { $cond: [{ $eq: ['$checkResult', 'invalid'] }, 1, 0] }
                            },
                            '2fa': {
                                $sum: { $cond: [{ $eq: ['$checkResult', '2fa'] }, 1, 0] }
                            },
                            passkey: {
                                $sum: { $cond: [{ $eq: ['$checkResult', 'passkey'] }, 1, 0] }
                            }
                        }
                    }
                ]),

                Batch.aggregate([
                    {
                        $group: {
                            _id: null,
                            totalBatches: { $sum: 1 },
                            completedBatches: {
                                $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                            },
                            processingBatches: {
                                $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] }
                            },
                            queuedBatches: {
                                $sum: { $cond: [{ $eq: ['$status', 'queued'] }, 1, 0] }
                            }
                        }
                    }
                ])
            ]);

            return {
                accounts: accountStats[0] || {
                    total: 0, pending: 0, processing: 0, completed: 0,
                    good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0
                },
                batches: batchStats[0] || {
                    totalBatches: 0, completedBatches: 0,
                    processingBatches: 0, queuedBatches: 0
                }
            };

        } catch (error) {
            console.error('خطا در دریافت آمار:', error);
            throw error;
        }
    }

    /**
     * تبدیل status اسکریپت به نتیجه دیتابیس
     */
    mapStatusToResult(scriptStatus) {
        const statusMap = {
            'good': 'good',
            'lock': 'bad',
            'guard': 'bad',
            'change_pass': 'bad',
            '2fa': '2fa',
            'mobile_2step': '2fa',
            'passkey': 'passkey',
            'server_error': 'error',
            'unknown': 'invalid',
            'error': 'error'
        };

        return statusMap[scriptStatus] || 'invalid';
    }

    /**
     * پاک کردن اکانت‌های قدیمی (cleanup)
     */
    async cleanupOldAccounts(daysOld = 30) {
        try {
            const cutoffDate = new Date(Date.now() - (daysOld * 24 * 60 * 60 * 1000));

            const result = await Account.deleteMany({
                createdAt: { $lt: cutoffDate },
                status: 'completed'
            });

            console.log(`🧹 ${result.deletedCount} اکانت قدیمی پاک شد`);
            return result.deletedCount;

        } catch (error) {
            console.error('خطا در پاک‌سازی اکانت‌های قدیمی:', error);
            throw error;
        }
    }
}

module.exports = new AccountService();



