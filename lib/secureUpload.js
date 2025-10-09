const fileUpload = require('express-fileupload');
const path = require('path');
const { ErrorResponse, getTranslation } = require('../src/Api');

// Allowed file types with their MIME types
const ALLOWED_FILE_TYPES = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/gif': ['.gif'],
    'application/pdf': ['.pdf'],
    'text/plain': ['.txt'],
    'application/msword': ['.doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
};

// Maximum file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Secure file upload middleware - only use in authenticated routes
 * @param {Object} options - Upload configuration options
 * @returns {Function} Express middleware
 */
function createSecureUpload(options = {}) {
    const uploadOptions = {
        useTempFiles: true,
        tempFileDir: process.env.ROOT + "/temp/upload/",
        limits: {
            fileSize: options.maxFileSize || MAX_FILE_SIZE
        },
        preserveExtension: true,
        abortOnLimit: true,
        ...options
    };

    return [
        fileUpload(uploadOptions),
        validateFileUpload
    ];
}

/**
 * Validates uploaded files for security
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function validateFileUpload(req, res, next) {
    if (!req.files) {
        return next();
    }

    // Convert single file to array for consistent processing
    const files = Array.isArray(req.files.file) ? req.files.file : [req.files.file];

    for (const file of files) {
        if (!file) continue;

        // Check file type
        const allowedExtensions = ALLOWED_FILE_TYPES[file.mimetype];
        if (!allowedExtensions) {
            const message = getTranslation("file_type_not_allowed", {mimetype: file.mimetype});
            throw new ErrorResponse(message, 400);
        }

        // Check file extension
        const fileExtension = path.extname(file.name).toLowerCase();
        if (!allowedExtensions.includes(fileExtension)) {
            const message = getTranslation("file_extension_not_allowed", {extension: fileExtension, mimetype: file.mimetype});
            throw new ErrorResponse(message, 400);
        }

        // Check file name for security
        if (file.name.includes('..') || file.name.includes('/') || file.name.includes('\\')) {
            const message = getTranslation("invalid_file_name");
            throw new ErrorResponse(message, 400);
        }

        // Check file size
        if (file.size > MAX_FILE_SIZE) {
            const message = getTranslation("file_size_exceeds_limit", {limit: MAX_FILE_SIZE / (1024 * 1024)});
            throw new ErrorResponse(message, 400);
        }
    }

    next();
}

module.exports = {
    createSecureUpload,
    validateFileUpload,
    ALLOWED_FILE_TYPES,
    MAX_FILE_SIZE
};