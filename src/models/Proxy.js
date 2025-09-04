const mongoose = require('mongoose');

const proxySchema = new mongoose.Schema({
    host: {
        type: String,
        required: true
    },
    port: {
        type: Number,
        required: true
    },
    username: {
        type: String,
        default: null
    },
    password: {
        type: String,
        default: null
    },
    protocol: {
        type: String,
        enum: ['http', 'https', 'socks4', 'socks5'],
        default: 'http'
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'testing', 'failed'],
        default: 'inactive',
        index: true
    },
    responseTime: {
        type: Number,
        default: null
    },
    lastTestAt: {
        type: Date,
        default: null,
        index: true
    },
    usageCount: {
        type: Number,
        default: 0,
        index: true
    },
    successCount: {
        type: Number,
        default: 0
    },
    failureCount: {
        type: Number,
        default: 0
    },
    lastUsedAt: {
        type: Date,
        default: null
    },
    source: {
        type: String,
        default: 'api'
    }
}, {
    timestamps: true
});

// Indexes
proxySchema.index({ status: 1, responseTime: 1 });
proxySchema.index({ host: 1, port: 1 }, { unique: true });
proxySchema.index({ lastTestAt: -1 });
proxySchema.index({ usageCount: 1 });

// Virtual for proxy URL
proxySchema.virtual('url').get(function () {
    const auth = this.username && this.password ? `${this.username}:${this.password}@` : '';
    return `${this.protocol}://${auth}${this.host}:${this.port}`;
});

module.exports = mongoose.model('Proxy', proxySchema);