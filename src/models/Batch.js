const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema({
    fileName: {
        type: String,
        required: [true, 'نام فایل الزامی است'],
        trim: true
    },
    fileSize: {
        type: Number,
        required: [true, 'حجم فایل الزامی است'],
        min: [1, 'حجم فایل باید بیشتر از صفر باشد']
    },
    accountCount: {
        type: Number,
        required: [true, 'تعداد اکانت‌ها الزامی است'],
        min: [0, 'تعداد اکانت‌ها نمی‌تواند منفی باشد'],
        default: 0
    },
    status: {
        type: String,
        enum: {
            values: ['processing', 'completed', 'failed'],
            message: 'وضعیت batch نامعتبر است'
        },
        default: 'processing'
    },
    uploadedAt: {
        type: Date,
        default: Date.now
    },
    processedAt: {
        type: Date,
        default: null
    },
    metadata: {
        originalName: { type: String },
        mimeType: { type: String },
        uploadIP: { type: String },
        duplicateEmails: [{ type: String }],
        errorDetails: [{
            email: String,
            error: String
        }]
    },
    stats: {
        saved: { type: Number, default: 0, min: 0 },
        duplicates: { type: Number, default: 0, min: 0 },
        errors: { type: Number, default: 0, min: 0 }
    }
}, {
    timestamps: true,
    versionKey: false
});

// Index های بهینه شده
batchSchema.index({ status: 1 }, {
    background: true,
    name: 'batch_status_idx'
});

batchSchema.index({ createdAt: -1 }, {
    background: true,
    name: 'batch_created_desc_idx'
});

batchSchema.index({ fileName: 1, uploadedAt: -1 }, {
    background: true,
    name: 'filename_uploaded_idx'
});

module.exports = mongoose.model('Batch', batchSchema);