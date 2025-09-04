const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true
    },
    password: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed'],
        default: 'pending',
        index: true
    },
    result: {
        type: String,
        enum: [
            'good', 'bad', 'invalid', '2fa', 'passkey', 'error',
            'lock', 'guard', 'change-pass', 'mobile-2step',
            'timeout', 'server-error'
        ],
        default: null,
        index: true
    },
    error: {
        type: String,
        default: null
    },
    source: {
        type: String,
        default: null
    },
    processingStartedAt: {
        type: Date,
        default: null
    },
    processingCompletedAt: {
        type: Date,
        default: null
    },
    uploadedAt: {
        type: Date,
        default: Date.now
    },
    result: {
        type: String,
        enum: [
            'pending', // 👈 اضافه می‌کنیم
            'good', 'bad', 'invalid', '2fa', 'passkey', 'error',
            'lock', 'guard', 'change-pass', 'mobile-2step',
            'timeout', 'server-error'
        ],
        default: 'pending',
        index: true
    }
}, {
    timestamps: true // این خودکار createdAt و updatedAt اضافه می‌کند
});

// Indexes for better performance
accountSchema.index({ status: 1, createdAt: 1 });
accountSchema.index({ email: 1 }, { unique: true });
accountSchema.index({ result: 1 });
accountSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Account', accountSchema);