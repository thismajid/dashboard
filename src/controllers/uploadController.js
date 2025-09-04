const path = require('path');
const Account = require('../models/Account');

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

            // Save accounts to database
            let savedCount = 0;
            let duplicateCount = 0;
            let errorCount = 0;

            for (const accountData of accounts) {
                try {
                    // Check if account already exists
                    const existingAccount = await Account.findOne({ email: accountData.email });

                    console.log('existingAccount ===> ', existingAccount);
                    

                    if (existingAccount) {
                        duplicateCount++;
                        console.log(`⚠️ Account already exists: ${accountData.email}`);
                        continue;
                    }

                    // Create new account
                    const account = new Account({
                        email: accountData.email,
                        password: accountData.password,
                        status: 'pending',
                        result: 'pending', // 👈 اضافه شد تا مقدار null نرود
                        source: accountData.source,
                        uploadedAt: new Date(),
                        createdAt: new Date()
                    });

                    await account.save();
                    savedCount++;

                    if (savedCount % 100 === 0) {
                        console.log(`📊 Progress: ${savedCount}/${accounts.length} accounts saved`);
                    }

                } catch (error) {
                    errorCount++;
                    console.error(`❌ Error saving account ${accountData.email}:`, error.message);
                }
            }

            console.log(`✅ Upload processing complete: ${savedCount} saved, ${duplicateCount} duplicates, ${errorCount} errors`);

            let message = `${savedCount} اکانت جدید با موفقیت اضافه شد`;
            if (duplicateCount > 0) {
                message += ` (${duplicateCount} اکانت تکراری نادیده گرفته شد)`;
            }
            if (errorCount > 0) {
                message += ` (${errorCount} اکانت با خطا مواجه شد)`;
            }

            console.log('savedCount ====> ', savedCount)

            res.json({
                success: true,
                message: message,
                count: savedCount,
                total: accounts.length,
                duplicates: duplicateCount,
                errors: errorCount,
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
                        if (item.email && item.password && item.email.includes('@')) {
                            accounts.push({
                                email: item.email.trim().toLowerCase(),
                                password: item.password.trim(),
                                source: filename
                            });
                        }
                    }
                } else if (jsonData.email && jsonData.password) {
                    if (jsonData.email.includes('@')) {
                        accounts.push({
                            email: jsonData.email.trim().toLowerCase(),
                            password: jsonData.password.trim(),
                            source: filename
                        });
                    }
                }

            } else if (extension === '.csv') {
                // Parse CSV file
                const lines = content.split('\n').filter(line => line.trim());

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    // Skip header row
                    if (i === 0 && (line.toLowerCase().includes('email') || line.toLowerCase().includes('password'))) {
                        console.log('📋 Skipping CSV header row');
                        continue;
                    }

                    // Parse CSV line
                    const parts = line.split(',').map(part => part.trim().replace(/^["']|["']$/g, ''));

                    if (parts.length >= 2) {
                        const email = parts[0];
                        const password = parts[1];

                        if (email && password && email.includes('@')) {
                            accounts.push({
                                email: email.toLowerCase(),
                                password: password,
                                source: filename
                            });
                        }
                    }
                }

            } else {
                // Parse TXT file (multiple formats supported)
                const lines = content.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;

                    let email, password;

                    // Try different separators
                    if (trimmedLine.includes(':')) {
                        [email, password] = trimmedLine.split(':');
                    } else if (trimmedLine.includes('\t')) {
                        [email, password] = trimmedLine.split('\t');
                    } else if (trimmedLine.includes('|')) {
                        [email, password] = trimmedLine.split('|');
                    } else if (trimmedLine.includes(';')) {
                        [email, password] = trimmedLine.split(';');
                    } else if (trimmedLine.includes(' ')) {
                        const parts = trimmedLine.split(' ').filter(part => part.trim());
                        if (parts.length >= 2) {
                            email = parts[0];
                            password = parts[1];
                        }
                    }

                    if (email && password) {
                        email = email.trim();
                        password = password.trim();

                        if (email.includes('@') && password.length > 0) {
                            accounts.push({
                                email: email.toLowerCase(),
                                password: password,
                                source: filename
                            });
                        }
                    }
                }
            }

            console.log(`📊 Successfully parsed ${accounts.length} valid accounts from ${filename}`);
            return accounts;

        } catch (error) {
            console.error('❌ Error parsing file:', error);
            throw new Error(`خطا در پارس فایل ${filename}: ${error.message}`);
        }
    }

    // Get batches method (if needed)
    async getBatches(req, res) {
        try {
            // Implementation for getting batches
            res.json({
                success: true,
                data: [],
                message: 'Batches endpoint - to be implemented'
            });
        } catch (error) {
            console.error('❌ Error getting batches:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در دریافت batch ها'
            });
        }
    }

    // Get batch details method (if needed)
    async getBatchDetails(req, res) {
        try {
            const { batchId } = req.params;

            res.json({
                success: true,
                data: { batchId },
                message: 'Batch details endpoint - to be implemented'
            });
        } catch (error) {
            console.error('❌ Error getting batch details:', error);
            res.status(500).json({
                success: false,
                message: 'خطا در دریافت جزئیات batch'
            });
        }
    }
}

module.exports = new UploadController();