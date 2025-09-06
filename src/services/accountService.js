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

            // ایجاد رکورد batch با ستون‌های واقعی
            await batchModel.create({
                batchId: batchInfo.batchId,
                fileName: batchInfo.fileName,
                fileSize: batchInfo.fileSize,
                accountCount: accounts.length, // استفاده از accountCount به جای totalAccounts
                status: 'processing', // از enum های تعریف شده استفاده کن
                originalName: batchInfo.originalName || batchInfo.fileName,
                mimeType: batchInfo.fileType || batchInfo.mimeType,
                uploadIp: batchInfo.uploadIp || null,
                statsPending: accounts.length, // همه اکانت‌ها در ابتدا pending هستند
                created_at: new Date(),
                updated_at: new Date()
            });

            // آماده‌سازی اکانت‌ها
            const accountRows = accounts.map((account, index) => ({
                username: account.username || account.data || `account_${index}`,
                password: account.password || '',
                email: account.email || null,
                batchId: batchInfo.batchId,
                originalIndex: index,
                status: 'pending',
                metadata: JSON.stringify({
                    originalData: account,
                    lineNumber: account.lineNumber || index + 1
                }),
                created_at: new Date(),
                updated_at: new Date()
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
            const accounts = await accountModel.query()
                .where('status', 'pending')
                .orderBy('created_at', 'asc')
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
                    updated_at: new Date()
                });

            // به‌روزرسانی آمار batch
            const batchUpdates = {};
            accounts.forEach(acc => {
                if (!batchUpdates[acc.batchId]) {
                    batchUpdates[acc.batchId] = 0;
                }
                batchUpdates[acc.batchId]++;
            });

            // کاهش statsPending و افزایش آمار پردازش
            for (const [batchId, count] of Object.entries(batchUpdates)) {
                await batchModel.query()
                    .where('batchId', batchId)
                    .decrement('statsPending', count)
                    .update({ updated_at: new Date() });
            }

            await trx.commit();

            // فرمت کردن برای اسکریپت
            return accounts.map(acc => ({
                id: acc.id,
                email: acc.email,
                password: acc.password,
                batchId: acc.batchId,
                originalIndex: acc.originalIndex,
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

            console.log(`📊 Processing ${results.length} results from instance ${instanceId}`);

            // گروه‌بندی نتایج بر اساس batchId
            const batchUpdates = {};

            for (const result of results) {
                console.log('submitBatchResults =====> ', result);

                let account = null;

                // جستجو بر اساس ID یا email
                if (result?.id) {
                    account = await accountModel.findById(+result.id);
                } else if (result?.email) {
                    account = await accountModel.findOne({ email: result.email });
                }

                if (!account) {
                    console.warn(`⚠️ Account not found for:`, result);
                    continue;
                }

                // نرمال‌سازی نتیجه
                const normalizedResult = this.normalizeResult(result.status);

                if (['server-error', 'unknown'].includes(normalizedResult)) {
                    await accountModel.findByIdAndUpdate(+account.id, {
                        status: 'pending',
                        result: 'pending',
                        updated_at: new Date()
                    });
                } else {
                    // به‌روزرسانی اکانت
                    await accountModel.findByIdAndUpdate(+account.id, {
                        status: 'completed',
                        result: normalizedResult,
                        updated_at: new Date()
                    });
                }

                // آماده‌سازی آپدیت batch
                if (account.batchId) {
                    if (!batchUpdates[account.batchId]) {
                        batchUpdates[account.batchId] = {
                            statsGood: 0,
                            statsBad: 0,
                            statsErrors: 0,
                            statsSaved: 0
                        };
                    }

                    // افزایش آمار مربوطه
                    switch (normalizedResult) {
                        case 'good':
                            batchUpdates[account.batchId].statsGood++;
                            break;
                        case 'bad':
                        case 'invalid':
                        case 'lock':
                        case 'guard':
                        case 'change-pass':
                            batchUpdates[account.batchId].statsBad++;
                            break;
                        case '2fa':
                        case 'passkey':
                        case 'error':
                        case 'timeout':
                        case 'server-error':
                        default:
                            batchUpdates[account.batchId].statsErrors++;
                            break;
                    }

                    batchUpdates[account.batchId].statsSaved++;
                }
            }

            // اعمال آپدیت‌های batch
            for (const [batchId, updates] of Object.entries(batchUpdates)) {
                await batchModel.query()
                    .where('batchId', batchId)
                    .increment('statsGood', updates.statsGood)
                    .increment('statsBad', updates.statsBad)
                    .increment('statsErrors', updates.statsErrors)
                    .increment('statsSaved', updates.statsSaved)
                    .update({ updated_at: new Date() });

                // بررسی اتمام batch
                await this.checkBatchCompletion(batchId, batchModel);
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
    * بررسی اتمام batch
    */
    async checkBatchCompletion(batchId, batchModel = null) {
        try {
            const model = batchModel || BatchModel;
            const batch = await model.findOne({ batchId });

            if (!batch) {
                console.warn(`⚠️ Batch ${batchId} not found`);
                return;
            }

            // اگر تعداد ذخیره شده برابر تعداد کل باشد
            if (batch.statsSaved >= batch.accountCount) {
                await model.findOneAndUpdate(
                    { batchId },
                    {
                        status: 'completed',
                        processedAt: new Date(),
                        updated_at: new Date()
                    }
                );

                console.log(`🎉 Batch ${batchId} completed! (${batch.statsSaved}/${batch.accountCount})`);
            }

        } catch (error) {
            console.error(`❌ خطا در بررسی اتمام batch ${batchId}:`, error);
        }
    }

    /**
    * نرمال‌سازی نتایج
    */
    normalizeResult(status) {
        if (!status) return 'error';

        const statusLower = status.toString().toLowerCase();

        // نقشه‌برداری نتایج مختلف
        const resultMap = {
            'good': 'good',
            'lock': 'lock',
            'guard': 'guard',
            '2fa': '2fa',
            'passkey': 'passkey',
            'change-pass': 'change-pass',
            'mobile-2step': 'mobile-2step',
            'unknown': 'unknown',
            'server-error': 'server-error',
        };

        return resultMap[statusLower] || 'unknown';
    }

    /**
    * آزادسازی اکانت‌های قفل شده توسط instance خاص
    */
    async releaseLockedAccounts(instanceId) {
        try {
            const result = await AccountModel.updateMany(
                { status: 'processing' },
                {
                    status: 'pending',
                    updated_at: new Date()
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
                    updated_at: new Date()
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
    * پاک کردن اکانت‌های قدیمی
    */
    async cleanupOldAccounts(daysOld = 30) {
        try {
            const cutoffDate = new Date(Date.now() - (daysOld * 24 * 60 * 60 * 1000));

            const result = await AccountModel.deleteMany({
                created_at: { '<': cutoffDate },
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
