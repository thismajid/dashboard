// src/middleware/validation.js
const { body, validationResult } = require('express-validator');

const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'داده‌های ورودی نامعتبر',
            errors: errors.array()
        });
    }
    next();
};

module.exports = {
    handleValidationErrors
};