const express = require('express');
const multer = require('multer');
const path = require('path');
const { StatsController } = require('../controllers/statsController');
const { ProxyService } = require('../services/proxyService');
const Account = require('../models/Account');

const router = express.Router();

// Initialize services
const statsController = new StatsController();
const proxyService = new ProxyService();

// ساده‌ترین تنظیم Multer
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    }
    // حذف fileFilter برای رفع مشکل
});

// Upload endpoint
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        console.log('📤 Upload request received');
        console.log('📁 Request file:', req.file ? 'EXISTS' : 'NOT EXISTS');

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'هیچ فایلی آپلود نشده است'
            });
        }

        console.log('📁 File details:', {
            fieldname: req.file.fieldname,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        });

        // بررسی پسوند فایل در اینجا
        const allowedExtensions = ['.txt', '.csv', '.json'];
        const fileExtension = path.extname(req.file.originalname).toLowerCase();

        if (!allowedExtensions.includes(fileExtension)) {
            return res.status(400).json({
                success: false,
                message: `فرمت فایل پشتیبانی نمی‌شود. فرمت‌های مجاز: ${allowedExtensions.join(', ')}`
            });
        }

        // Parse file content
        const fileContent = req.file.buffer.toString('utf-8');
        console.log('📄 File content length:', fileContent.length);

        const accounts = await parseAccountFile(fileContent, req.file.originalname);

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

                if (existingAccount) {
                    duplicateCount++;
                    continue;
                }

                // Create new account
                const account = new Account({
                    email: accountData.email,
                    password: accountData.password,
                    status: 'pending',
                    source: accountData.source,
                    uploadedAt: new Date()
                });

                await account.save();
                savedCount++;

            } catch (error) {
                errorCount++;
                console.error(`❌ Error saving account ${accountData.email}:`, error.message);
            }
        }

        console.log(`✅ Processing complete: ${savedCount} saved, ${duplicateCount} duplicates, ${errorCount} errors`);

        let message = `${savedCount} اکانت جدید با موفقیت اضافه شد`;
        if (duplicateCount > 0) {
            message += ` (${duplicateCount} اکانت تکراری)`;
        }
        if (errorCount > 0) {
            message += ` (${errorCount} خطا)`;
        }

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
        console.error('❌ Upload error:', error);

        let errorMessage = 'خطا در پردازش فایل';

        if (error instanceof multer.MulterError) {
            switch (error.code) {
                case 'LIMIT_FILE_SIZE':
                    errorMessage = 'حجم فایل بیش از حد مجاز است (حداکثر 50MB)';
                    break;
                case 'LIMIT_UNEXPECTED_FILE':
                    errorMessage = 'خطا در آپلود فایل. لطفاً مجدداً تلاش کنید';
                    break;
                default:
                    errorMessage = `خطای آپلود: ${error.message}`;
            }
        } else if (error.message) {
            errorMessage = error.message;
        }

        res.status(500).json({
            success: false,
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Parse account file function
async function parseAccountFile(content, filename) {
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

        console.log(`📊 Successfully parsed ${accounts.length} valid accounts`);
        return accounts;

    } catch (error) {
        console.error('❌ Error parsing file:', error);
        throw new Error(`خطا در پارس فایل: ${error.message}`);
    }
}

// Get stats endpoint
router.get('/stats', async (req, res) => {
    try {
        const stats = await statsController.getSystemStats();
        res.json({
            success: true,
            data: stats,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        res.status(500).json({
            success: false,
            message: 'خطا در دریافت آمار'
        });
    }
});

// Get accounts endpoint
router.get('/accounts', async (req, res) => {
    try {
        const { status, limit = 100, skip = 0 } = req.query;

        const query = {};
        if (status) {
            query.status = status;
        }

        const accounts = await Account.find(query)
            .limit(parseInt(limit))
            .skip(parseInt(skip))
            .sort({ createdAt: -1 });

        const total = await Account.countDocuments(query);

        res.json({
            success: true,
            data: accounts,
            total: total,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('❌ Error getting accounts:', error);
        res.status(500).json({
            success: false,
            message: 'خطا در دریافت اکانت‌ها'
        });
    }
});

// Get next account for processing
router.get('/next-account', async (req, res) => {
    try {
        const account = await Account.findOneAndUpdate(
            { status: 'pending' },
            {
                status: 'processing',
                processingStartedAt: new Date()
            },
            {
                new: true,
                sort: { createdAt: 1 }
            }
        );

        if (!account) {
            return res.json({
                success: true,
                data: null,
                message: 'هیچ اکانت در انتظاری یافت نشد'
            });
        }

        res.json({
            success: true,
            data: {
                id: account._id,
                email: account.email,
                password: account.password
            }
        });
    } catch (error) {
        console.error('❌ Error getting next account:', error);
        res.status(500).json({
            success: false,
            message: 'خطا در دریافت اکانت بعدی'
        });
    }
});

// Update account result
router.patch('/accounts/:id', async (req, res) => {
    try {
        const { status, result, error } = req.body;

        const updateData = { updatedAt: new Date() };
        if (status) updateData.status = status;
        if (result) updateData.result = result;
        if (error) updateData.error = error;

        if (status === 'completed' || status === 'failed') {
            updateData.processingCompletedAt = new Date();
        }

        const account = await Account.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true }
        );

        if (!account) {
            return res.status(404).json({
                success: false,
                message: 'اکانت یافت نشد'
            });
        }

        res.json({
            success: true,
            data: account
        });
    } catch (error) {
        console.error('❌ Error updating account:', error);
        res.status(500).json({
            success: false,
            message: 'خطا در به‌روزرسانی اکانت'
        });
    }
});

// Health check
router.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime()
    });
});

// Error handling middleware
router.use((error, req, res, next) => {
    console.error('❌ API Error:', error);

    res.status(500).json({
        success: false,
        message: 'خطای سرور',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

module.exports = router;