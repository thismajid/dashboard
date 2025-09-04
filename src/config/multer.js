const multer = require('multer');
const path = require('path');

// Multer configuration
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
        files: 1
    },
    fileFilter: (req, file, cb) => {
        console.log('📁 Multer fileFilter:', {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype
        });

        // قبول فیلد file به جای accountFile
        if (file.fieldname !== 'file') {
            console.error('❌ Invalid field name:', file.fieldname, 'Expected: file');
            return cb(new Error(`فیلد نامعتبر: ${file.fieldname}. باید 'file' باشد`));
        }

        // بررسی پسوند فایل
        const allowedExtensions = ['.txt', '.csv', '.json'];
        const fileExtension = path.extname(file.originalname).toLowerCase();

        if (!allowedExtensions.includes(fileExtension)) {
            console.error('❌ Invalid file extension:', fileExtension);
            return cb(new Error(`فرمت فایل پشتیبانی نمی‌شود. فرمت‌های مجاز: ${allowedExtensions.join(', ')}`));
        }

        console.log('✅ File accepted by multer');
        cb(null, true);
    }
});

module.exports = upload;