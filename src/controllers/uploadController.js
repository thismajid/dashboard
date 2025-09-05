const path = require('path');
const AccountModel = require('../models/knex/Account'); // استفاده از AccountModel ریفکتور شده
const { db } = require('../config/database');

class UploadController {
    constructor() {
        console.log('📤 UploadController initialized');
    }

    async uploadFile(req, res) {
        try {
            console.log('📤 Upload request received in controller');
            console.log('📁 File info:', req.file ? {
                fieldname: req.file.fieldname,
                originalname: req.file.originalname,
                size: req.file.size,
                mimetype: req.file.mimetype
            } : 'No file received');

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'هیچ فایلی آپلود نشده است'
                });
            }

            // Parse file content
            const fileContent = req.file.buffer.toString('utf-8');
            console.log('📄 File content length:', fileContent.length);

            const accounts = await this.parseAccountFile(fileContent, req.file.originalname);

            if (accounts.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'فایل خالی است یا فرمت آن صحیح نمی‌باشد'
                });
            }

            console.log(`📊 Parsed ${accounts.length} accounts from file`);

            // Save accounts to database with transaction
            const result = await this.saveAccountsBatch(accounts, req.file.originalname);

            console.log(`✅ Upload processing complete: ${result.savedCount} saved, ${result.duplicateCount} duplicates, ${result.errorCount} errors`);

            let message = `${result.savedCount} اکانت جدید با موفقیت اضافه شد`;
            if (result.duplicateCount > 0) {
                message += ` (${result.duplicateCount} اکانت تکراری نادیده گرفته شد)`;
            }
            if (result.errorCount > 0) {
                message += ` (${result.errorCount} اکانت با خطا مواجه شد)`;
            }

            res.json({
                success: true,
                message: message,
                count: result.savedCount,
                total: accounts.length,
                duplicates: result.duplicateCount,
                errors: result.errorCount,
                batchId: result.batchId,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('❌ Upload controller error:', error);

            let errorMessage = 'خطا در پردازش فایل';

            if (error.message) {
                errorMessage = error.message;
            }

            res.status(500).json({
                success: false,
                message: errorMessage,
                error: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    }

    /**
    * ذخیره اکانت‌ها با تراکنش
    */
    async saveAccountsBatch(accounts, filename) {
        const trx = await db().transaction();

        try {
            let savedCount = 0;
            let duplicateCount = 0;
            let errorCount = 0;
            const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            console.log(`💾 Starting batch save with transaction for ${accounts.length} accounts`);

            // بررسی اکانت‌های تکراری در یک کوئری
            const existingEmails = await trx('Accounts')
                .whereIn('email', accounts.map(acc => acc.email))
                .select('email');

            const existingEmailSet = new Set(existingEmails.map(row => row.email));

            // آماده‌سازی داده‌های جدید
            const newAccounts = [];
            const duplicates = [];

            for (const accountData of accounts) {
                if (existingEmailSet.has(accountData.email)) {
                    duplicates.push(accountData.email);
                    duplicateCount++;
                } else {
                    newAccounts.push({
                        email: accountData.email,
                        password: accountData.password,
                        accountLine: `${accountData.email}:${accountData.password}`,
                        status: 'pending',
                        result: 'pending',
                        source: filename,
                        batchId: batchId,
                        uploadedAt: new Date(),
                    });
                }
            }

            console.log(`📊 Filtered accounts: ${newAccounts.length} new, ${duplicateCount} duplicates`);

            if (duplicates.length > 0) {
                console.log(`⚠️ Duplicate emails found: ${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ` and ${duplicates.length - 5} more...` : ''}`);
            }

            // درج اکانت‌های جدید در batch
            if (newAccounts.length > 0) {
                // تقسیم به chunk های کوچکتر برای جلوگیری از timeout
                const chunkSize = 500;

                for (let i = 0; i < newAccounts.length; i += chunkSize) {
                    const chunk = newAccounts.slice(i, i + chunkSize);

                    try {
                        await trx('Accounts').insert(chunk);
                        savedCount += chunk.length;

                        console.log(`📊 Progress: ${Math.min(i + chunkSize, newAccounts.length)}/${newAccounts.length} accounts saved`);
                    } catch (chunkError) {
                        console.error(`❌ Error saving chunk ${i}-${i + chunkSize}:`, chunkError.message);
                        errorCount += chunk.length;
                    }
                }
            }

            await trx.commit();
            console.log(`✅ Transaction committed successfully: ${savedCount} accounts saved`);

            return {
                savedCount,
                duplicateCount,
                errorCount,
                batchId
            };

        } catch (error) {
            await trx.rollback();
            console.error('❌ Transaction rolled back due to error:', error);
            throw error;
        }
    }

    async parseAccountFile(content, filename) {
        const accounts = [];
        const extension = path.extname(filename).toLowerCase();

        try {
            console.log(`📄 Parsing ${extension} file: ${filename}`);

            if (extension === '.json') {
                // Parse JSON file
                const jsonData = JSON.parse(content);

                if (Array.isArray(jsonData)) {
                    for (const item of jsonData) {
                        if (this.isValidAccountData(item)) {
                            accounts.push({
                                email: item.email.trim().toLowerCase(),
                                password: item.password.trim(),
                                source: filename
                            });
                        }
                    }
                } else if (this.isValidAccountData(jsonData)) {
                    accounts.push({
                        email: jsonData.email.trim().toLowerCase(),
                        password: jsonData.password.trim(),
                        source: filename
                    });
                }

            } else if (extension === '.csv') {
                // Parse CSV file
                const lines = content.split('\n').filter(line => line.trim());

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    // Skip header row
                    if (i === 0 && this.isHeaderRow(line)) {
                        console.log('📋 Skipping CSV header row');
                        continue;
                    }

                    // Parse CSV line
                    const accountData = this.parseCsvLine(line, filename);
                    if (accountData) {
                        accounts.push(accountData);
                    }
                }

            } else {
                // Parse TXT file (multiple formats supported)
                const lines = content.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    const accountData = this.parseTxtLine(line.trim(), filename);
                    if (accountData) {
                        accounts.push(accountData);
                    }
                }
            }

            // Remove duplicates within the file
            const uniqueAccounts = this.removeDuplicatesFromArray(accounts);
            const removedDuplicates = accounts.length - uniqueAccounts.length;

            if (removedDuplicates > 0) {
                console.log(`🔄 Removed ${removedDuplicates} duplicate accounts from file`);
            }

            console.log(`📊 Successfully parsed ${uniqueAccounts.length} valid unique accounts from ${filename}`);
            return uniqueAccounts;

        } catch (error) {
            console.error('❌ Error parsing file:', error);
            throw new Error(`خطا در پارس فایل ${filename}: ${error.message}`);
        }
    }

    /**
    * بررسی معتبر بودن داده‌های اکانت
    */
    isValidAccountData(data) {
        return data &&
            data.email &&
            data.password &&
            typeof data.email === 'string' &&
            typeof data.password === 'string' &&
            data.email.includes('@') &&
            data.email.length > 5 &&
            data.password.length > 0;
    }

    /**
    * بررسی اینکه خط اول CSV هدر است یا نه
    */
    isHeaderRow(line) {
        const lowerLine = line.toLowerCase();
        return lowerLine.includes('email') ||
            lowerLine.includes('password') ||
            lowerLine.includes('username');
    }

    /**
    * پارس خط CSV
    */
    parseCsvLine(line, filename) {
        try {
            // Handle different CSV formats
            const parts = line.split(',').map(part => part.trim().replace(/^["']|["']$/g, ''));

            if (parts.length >= 2) {
                const email = parts[0];
                const password = parts[1];

                if (email && password && email.includes('@')) {
                    return {
                        email: email.toLowerCase(),
                        password: password,
                        source: filename
                    };
                }
            }
        } catch (error) {
            console.warn(`⚠️ Error parsing CSV line: ${line}`);
        }
        return null;
    }

    /**
    * پارس خط TXT
    */
    parseTxtLine(line, filename) {
        if (!line) return null;

        try {
            let email, password;

            // Try different separators
            const separators = [':', '\t', '|', ';', ' '];

            for (const separator of separators) {
                if (line.includes(separator)) {
                    const parts = line.split(separator).map(part => part.trim());

                    if (parts.length >= 2) {
                        email = parts[0];
                        password = parts[1];
                        break;
                    }
                }
            }

            if (email && password && email.includes('@') && password.length > 0) {
                return {
                    email: email.toLowerCase(),
                    password: password,
                    source: filename
                };
            }
        } catch (error) {
            console.warn(`⚠️ Error parsing TXT line: ${line}`);
        }

        return null;
    }

    /**
    * حذف تکراری‌ها از آرایه
    */
    removeDuplicatesFromArray(accounts) {
        const seen = new Set();
        return accounts.filter(account => {
            const key = account.email.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    /**
    * دریافت batch ها
    */
    async getBatches(req, res) {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;

            // دریافت batch های منحصر به فرد
            const batches = await AccountModel.query()
                .select('batchId', 'source', 'uploadedAt')
                .select(AccountModel.db().raw('COUNT(*) as totalAccounts'))
                .select(AccountModel.db().raw('SUM(CASE WHEN status = \'good\' THEN 1 ELSE 0 END) as goodAccounts'))
                .select(AccountModel.db().raw('SUM(CASE WHEN status = \'bad\' THEN 1 ELSE 0 END) as badAccounts'))
                .select(AccountModel.db().raw('SUM(CASE WHEN status = \'pending\' THEN 1 ELSE 0 END) as pendingAccounts'))
                .whereNotNull('batchId')
                .groupBy('batchId', 'source', 'uploadedAt')
                .orderBy('uploadedAt', 'desc')
                .limit(limit)
                .offset(offset);

            // شمارش کل batch ها
            const totalBatchesResult = await AccountModel.query()
                .countDistinct('batchId as count')
                .whereNotNull('batchId')
                .first();

            const totalBatches = parseInt(totalBatchesResult?.count) || 0;
            const totalPages = Math.ceil(totalBatches / limit);

            res.json({
                success: true,
                data: batches.map(batch => ({
                    batchId: batch.batchId,
                    source: batch.source,
                    uploadedAt: batch.uploadedAt,
                    totalAccounts: parseInt(batch.totalAccounts),
                    goodAccounts: parseInt(batch.goodAccounts),
                    badAccounts: parseInt(batch.badAccounts),
                    pendingAccounts: parseInt(batch.pendingAccounts),
                    successRate: batch.totalAccounts > 0 ?
                        Math.round((batch.goodAccounts / batch.totalAccounts) * 100) : 0
                })),
                pagination: {
                    currentPage: page,
                    totalPages: totalPages,
                    totalBatches: totalBatches,
                    hasNext: page < totalPages,
                    hasPrev: page > 1
                }
            });

        } catch (error) {
            console.error('❌ Error getting batches:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در دریافت batch ها',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }

    /**
    * دریافت جزئیات batch
    */
    async getBatchDetails(req, res) {
        try {
            const { batchId } = req.params;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const offset = (page - 1) * limit;

            if (!batchId) {
                return res.status(400).json({
                    success: false,
                    message: 'شناسه batch الزامی است'
                });
            }

            // دریافت اطلاعات کلی batch
            const batchInfo = await AccountModel.query()
                .select('batchId', 'source', 'uploadedAt')
                .select(AccountModel.db().raw('COUNT(*) as totalAccounts'))
                .select(AccountModel.db().raw('SUM(CASE WHEN status = \'good\' THEN 1 ELSE 0 END) as goodAccounts'))
                .select(AccountModel.db().raw('SUM(CASE WHEN status = \'bad\' THEN 1 ELSE 0 END) as badAccounts'))
                .select(AccountModel.db().raw('SUM(CASE WHEN status = \'pending\' THEN 1 ELSE 0 END) as pendingAccounts'))
                .where('batchId', batchId)
                .groupBy('batchId', 'source', 'uploadedAt')
                .first();

            if (!batchInfo) {
                return res.status(404).json({
                    success: false,
                    message: 'batch یافت نشد'
                });
            }

            // دریافت اکانت‌های batch
            const accounts = await AccountModel.query()
                .where('batchId', batchId)
                .select('id', 'email', 'status', 'result', 'created_at', 'updated_at', 'checkedAt')
                .orderBy('created_at', 'desc')
                .limit(limit)
                .offset(offset);

            const totalAccounts = parseInt(batchInfo.totalAccounts);
            const totalPages = Math.ceil(totalAccounts / limit);

            res.json({
                success: true,
                data: {
                    batchInfo: {
                        batchId: batchInfo.batchId,
                        source: batchInfo.source,
                        uploadedAt: batchInfo.uploadedAt,
                        totalAccounts: totalAccounts,
                        goodAccounts: parseInt(batchInfo.goodAccounts),
                        badAccounts: parseInt(batchInfo.badAccounts),
                        pendingAccounts: parseInt(batchInfo.pendingAccounts),
                        successRate: totalAccounts > 0 ?
                            Math.round((batchInfo.goodAccounts / totalAccounts) * 100) : 0
                    },
                    accounts: accounts,
                    pagination: {
                        currentPage: page,
                        totalPages: totalPages,
                        totalAccounts: totalAccounts,
                        hasNext: page < totalPages,
                        hasPrev: page > 1
                    }
                }
            });

        } catch (error) {
            console.error('❌ Error getting batch details:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در دریافت جزئیات batch',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }

    /**
    * حذف batch
    */
    async deleteBatch(req, res) {
        try {
            const { batchId } = req.params;

            if (!batchId) {
                return res.status(400).json({
                    success: false,
                    message: 'شناسه batch الزامی است'
                });
            }

            const deletedCount = await AccountModel.deleteMany({ batchId });

            if (deletedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'batch یافت نشد'
                });
            }

            console.log(`🗑️ Deleted batch ${batchId}: ${deletedCount} accounts`);

            res.json({
                success: true,
                message: `batch با موفقیت حذف شد (${deletedCount} اکانت)`,
                deletedCount: deletedCount
            });

        } catch (error) {
            console.error('❌ Error deleting batch:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در حذف batch',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
}

module.exports = new UploadController();