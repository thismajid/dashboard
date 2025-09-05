const { db } = require('../config/database');
const AccountModel = require('../models/knex/Account');
const BatchModel = require('../models/knex/Batch');
const { v4: uuidv4 } = require('uuid');

class AccountService {
    /**
    * دریافت آمار کلی
    */
    async getStats() {
        try {
            const [accountStats, batchStats] = await Promise.all([
                AccountModel.getAccountStats(),
                BatchModel.getBatchStats()
            ]);

            return {
                accounts: accountStats,
                batches: batchStats
            };
        } catch (error) {
            console.error('❌ خطا در دریافت آمار اکانت:', error);
            return {
                accounts: {
                    total: 0, pending: 0, processing: 0, completed: 0,
                    good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0, error: 0
                },
                batches: {
                    totalBatches: 0, completedBatches: 0,
                    processingBatches: 0, queuedBatches: 0
                }
            };
        }
    }

    /**
    * ذخیره batch جدید اکانت‌ها با تراکنش
    */
    async saveBatch(accounts, batchInfo) {
        const trx = await db().transaction();

        try {
            const batchModel = BatchModel.withTransaction(trx);
            const accountModel = AccountModel.withTransaction(trx);

            // ایجاد رکورد batch
            await batchModel.create({
                batchId: batchInfo.batchId,
                fileName: batchInfo.fileName,
                fileSize: batchInfo.fileSize,
                fileType: batchInfo.fileType,
                filePath: batchInfo.filePath,
                totalAccounts: accounts.length,
                status: 'queued',
                uploadedBy: JSON.stringify(batchInfo.uploadedBy || {}),
                createdAt: new Date(),
                updatedAt: new Date()
            });

            // آماده‌سازی اکانت‌ها
            const accountRows = accounts.map((account, index) => ({
                username: account.username || account.data || `account_${index}`,
                password: account.password || '',
                email: account.email || null,
                batchId: batchInfo.batchId,
                originalIndex: index,
                status: 'pending',
                processingAttempts: 0,
                metadata: JSON.stringify({
                    originalData: account,
                    lineNumber: account.lineNumber || index + 1
                }),
                createdAt: new Date(),
                updatedAt: new Date()
            }));

            // Bulk insert اکانت‌ها
            if (accountRows.length > 0) {
                await accountModel.insertMany(accountRows);
            }

            await trx.commit();
            console.log(`✅ ${accounts.length} اکانت در batch ${batchInfo.batchId} ذخیره شد`);
            return batchInfo.batchId;

        } catch (error) {
            await trx.rollback();
            console.error('❌ خطا در ذخیره batch:', error);
            throw error;
        }
    }

    /**
    * دریافت batch اکانت‌ها برای instance خاص با تراکنش
    */
    async getAccountBatch(instanceId, batchSize = 2) {
        const trx = await db().transaction();

        try {
            const accountModel = AccountModel.withTransaction(trx);
            const batchModel = BatchModel.withTransaction(trx);

            // پیدا کردن اکانت‌های آماده پردازش
            const timeoutDate = new Date(Date.now() - 10 * 60 * 1000); // 10 دقیقه timeout

            const accounts = await accountModel.query()
                .where('status', 'pending')
                .orderBy('createdAt', 'asc')
                .limit(batchSize);

            if (accounts.length === 0) {
                await trx.commit();
                return [];
            }

            // قفل کردن اکانت‌ها
            const accountIds = accounts.map(acc => acc.id);
            await accountModel.query()
                .whereIn('id', accountIds)
                .update({
                    status: 'processing',
                    lockedBy: instanceId,
                    lockedAt: new Date(),
                    processingAttempts: db().raw('processing_attempts + 1'),
                    updatedAt: new Date()
                });

            // به‌روزرسانی وضعیت batch به processing
            const batchIds = [...new Set(accounts.map(acc => acc.batchId))];
            await batchModel.query()
                .whereIn('batchId', batchIds)
                .where('status', 'queued')
                .update({
                    status: 'processing',
                    startedAt: new Date(),
                    updatedAt: new Date()
                });

            await trx.commit();

            // فرمت کردن برای اسکریپت
            return accounts.map(acc => ({
                id: acc.id.toString(),
                email: acc.email,
                password: acc.password,
                batchId: acc.batchId,
                originalIndex: acc.originalIndex,
                attempts: acc.processingAttempts + 1
            }));

        } catch (error) {
            await trx.rollback();
            console.error('❌ خطا در دریافت batch اکانت‌ها:', error);
            throw error;
        }
    }

    /**
    * ثبت نتایج batch اکانت‌ها با تراکنش
    */
    async submitBatchResults(instanceId, results) {
        const trx = await db().transaction();

        try {
            const accountModel = AccountModel.withTransaction(trx);
            const batchModel = BatchModel.withTransaction(trx);

            for (const result of results) {
                console.log('submitBatchResults =====> ', result);

                let account = null;

                // جستجو بر اساس ID یا email
                if (result?.id) {
                    account = await accountModel.findById(result.id);
                } else if (result?.email) {
                    account = await accountModel.findOne({ email: result.email });
                }

                if (!account) {
                    console.warn("Account not found");
                    continue;
                }

                // به‌روزرسانی اکانت
                await accountModel.findByIdAndUpdate(account.id, {
                    status: 'completed',
                    result: result.status,
                    lockedBy: null,
                    lockedAt: null,
                    updatedAt: new Date()
                });

                // به‌روزرسانی آمار batch
                const mappedResult = this.mapStatusToResult(result.status);
                await batchModel.incrementResult(account.batchId, mappedResult);
            }

            await trx.commit();
            console.log(`✅ ${results.length} نتیجه از instance ${instanceId} ثبت شد`);

        } catch (error) {
            await trx.rollback();
            console.error('❌ خطا در ثبت نتایج:', error);
            throw error;
        }
    }

    /**
    * آزادسازی اکانت‌های قفل شده توسط instance خاص
    */
    async releaseLockedAccounts(instanceId) {
        try {
            const result = await AccountModel.updateMany(
                {
                    lockedBy: instanceId,
                    status: 'processing'
                },
                {
                    status: 'pending',
                    lockedBy: null,
                    lockedAt: null,
                    updatedAt: new Date()
                }
            );

            console.log(`🔓 ${result.length} اکانت از instance ${instanceId} آزاد شد`);
            return result.length;

        } catch (error) {
            console.error('❌ خطا در آزادسازی اکانت‌ها:', error);
            throw error;
        }
    }

    /**
    * آزادسازی اکانت‌ها بر اساس ID
    */
    async releaseAccountsByIds(accountIds) {
        try {
            const result = await AccountModel.updateMany(
                {
                    id: accountIds,
                    status: 'processing'
                },
                {
                    status: 'pending',
                    lockedBy: null,
                    lockedAt: null,
                    updatedAt: new Date()
                }
            );

            console.log(`🔓 ${result.length} اکانت آزاد شد`);
            return result.length;

        } catch (error) {
            console.error('❌ خطا در آزادسازی اکانت‌ها:', error);
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
    * پاک کردن اکانت‌های قدیمی
    */
    async cleanupOldAccounts(daysOld = 30) {
        try {
            const cutoffDate = new Date(Date.now() - (daysOld * 24 * 60 * 60 * 1000));

            const result = await AccountModel.deleteMany({
                createdAt: { '<': cutoffDate },
                status: 'completed'
            });

            console.log(`🧹 ${result} اکانت قدیمی پاک شد`);
            return result;

        } catch (error) {
            console.error('❌ خطا در پاک‌سازی اکانت‌های قدیمی:', error);
            throw error;
        }
    }
}

module.exports = new AccountService();