const nodemailer = require('nodemailer');
const { emails } = require('../config/app.json');

/**
 * @typedef {Object} EmailConfig
 * @property {string} host - SMTP server hostname
 * @property {number} port - SMTP server port
 * @property {boolean} secure - Use TLS (true for 465, false for other ports)
 * @property {string} user - SMTP authentication username
 * @property {string} password - SMTP authentication password
 * @property {string} [from] - Default sender email address
 * @property {string} [name] - Default sender name
 */

/**
 * @typedef {Object} EmailAttachment
 * @property {string} [filename] - Name of attached file
 * @property {string|Buffer|Stream} [content] - File content
 * @property {string} [path] - Path to file
 * @property {string} [href] - URL to file
 * @property {string} [contentType] - MIME type
 * @property {string} [encoding] - Content encoding (e.g., 'base64')
 */

/**
 * @typedef {Object} EmailOptions
 * @property {string|string[]} to - Recipient email address(es)
 * @property {string} subject - Email subject line
 * @property {string} [html] - HTML email body
 * @property {string} [text] - Plain text email body
 * @property {string|string[]} [cc] - CC recipient(s)
 * @property {string|string[]} [bcc] - BCC recipient(s)
 * @property {string} [replyTo] - Reply-to address
 * @property {EmailAttachment[]} [attachments] - File attachments
 * @property {Object.<string, string>} [headers] - Custom email headers
 */

/**
 * @typedef {Object} EmailResult
 * @property {boolean} success - Whether email was sent successfully
 * @property {string} [messageId] - Message ID from mail server
 * @property {Object} [info] - Additional info from transport
 * @property {Error} [error] - Error object if sending failed
 */

/**
 * Email sender class with support for multiple SMTP configurations
 * Provides a clean, promise-based API for sending emails with attachments
 * 
 * @class SendMail
 * @example
 * // Send a simple email
 * const result = await SendMail.send('primary', {
 *     to: 'user@example.com',
 *     subject: 'Welcome!',
 *     html: '<h1>Hello World</h1>'
 * });
 * 
 * @example
 * // Send with attachments
 * const result = await SendMail.send('support', {
 *     to: ['user1@example.com', 'user2@example.com'],
 *     subject: 'Invoice',
 *     html: '<p>Please find your invoice attached.</p>',
 *     attachments: [
 *         { filename: 'invoice.pdf', path: './invoice.pdf' }
 *     ]
 * });
 */
class SendMail {
    /**
     * Creates a new SendMail instance (legacy callback-based constructor)
     * 
     * @deprecated Use SendMail.send() static method instead for better error handling
     * @param {string} from - Email configuration key from app.json
     * @param {string|string[]} recipient - Recipient email address(es)
     * @param {string} subject - Email subject
     * @param {string} message - HTML email body
     * @param {EmailAttachment[]} [attachments=[]] - Email attachments
     * @param {Function} [callback] - Callback function(success: boolean)
     */
    constructor(from, recipient, subject, message, attachments = [], callback = null) {
        // Validate and get email config
        this.from = this._validateEmailConfig(from);
        
        // Send email using legacy callback pattern
        this._sendLegacy(recipient, subject, message, attachments, callback);
    }
    
    /**
     * Validates email configuration key and returns config
     * 
     * @param {string} configKey - Email configuration key
     * @returns {EmailConfig} Email configuration object
     * @throws {Error} If config key is invalid or not found
     * @private
     */
    _validateEmailConfig(configKey) {
        if (typeof configKey !== 'string') {
            throw new TypeError(`Email config key must be a string, received ${typeof configKey}`);
        }
        
        if (!emails || typeof emails !== 'object') {
            throw new Error('Email configuration not found in app.json');
        }
        
        if (!emails.hasOwnProperty(configKey)) {
            const available = Object.keys(emails).join(', ');
            throw new Error(
                `Email config '${configKey}' not found. Available configs: ${available || 'none'}`
            );
        }
        
        const config = emails[configKey];
        
        // Validate required fields
        const required = ['host', 'port', 'user', 'password'];
        const missing = required.filter(field => !config[field]);
        
        if (missing.length > 0) {
            throw new Error(
                `Email config '${configKey}' is missing required fields: ${missing.join(', ')}`
            );
        }
        
        return config;
    }
    
    /**
     * Creates a nodemailer transporter from email config
     * 
     * @param {EmailConfig} config - Email configuration
     * @returns {nodemailer.Transporter} Configured transporter
     * @private
     */
    _createTransporter(config) {
        return nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure !== false, // Default to true for port 465
            auth: {
                user: config.user,
                pass: config.password
            },
            tls: {
                // Allow self-signed certificates in development only
                rejectUnauthorized: process.env.NODE_ENV === 'production'
            },
            pool: true, // Use pooled connections
            maxConnections: 5,
            maxMessages: 100
        });
    }
    
    /**
     * Validates and normalizes email options
     * 
     * @param {EmailOptions} options - Email options to validate
     * @returns {EmailOptions} Normalized email options
     * @throws {Error} If required fields are missing or invalid
     * @private
     */
    _validateEmailOptions(options) {
        if (!options || typeof options !== 'object') {
            throw new TypeError('Email options must be an object');
        }
        
        if (!options.to) {
            throw new Error('Recipient email address (to) is required');
        }
        
        if (!options.subject) {
            throw new Error('Email subject is required');
        }
        
        if (!options.html && !options.text) {
            throw new Error('Email body (html or text) is required');
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const validateEmail = (email) => {
            if (!emailRegex.test(email)) {
                throw new Error(`Invalid email address: ${email}`);
            }
        };
        
        // Validate recipient emails
        const recipients = Array.isArray(options.to) ? options.to : [options.to];
        recipients.forEach(validateEmail);
        
        return options;
    }
    
    /**
     * Sends email using legacy callback pattern (used by constructor)
     * 
     * @param {string|string[]} recipient - Recipient email address(es)
     * @param {string} subject - Email subject
     * @param {string} message - HTML email body
     * @param {EmailAttachment[]} attachments - Email attachments
     * @param {Function} callback - Callback function
     * @private
     */
    _sendLegacy(recipient, subject, message, attachments, callback) {
        const transporter = this._createTransporter(this.from);
        
        const mailOptions = {
            from: this.from.from || `"${this.from.name || 'No Reply'}" <${this.from.user}>`,
            to: recipient,
            subject: subject,
            html: message,
            attachments: attachments || []
        };
        
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('[SendMail Error]', error.message);
                if (callback) callback(false);
            } else {
                console.log('[SendMail Success]', `Message sent: ${info.messageId}`);
                if (callback) callback(true);
            }
            
            // Close transporter
            transporter.close();
        });
    }
    
    /**
     * Sends an email using promise-based API (recommended)
     * 
     * @param {string} configKey - Email configuration key from app.json
     * @param {EmailOptions} options - Email options
     * @returns {Promise<EmailResult>} Email sending result
     * @throws {Error} If validation fails or sending fails
     * 
     * @example
     * // Simple email
     * const result = await SendMail.send('primary', {
     *     to: 'user@example.com',
     *     subject: 'Test Email',
     *     html: '<p>Hello!</p>'
     * });
     * 
     * @example
     * // With all options
     * const result = await SendMail.send('support', {
     *     to: ['user1@example.com', 'user2@example.com'],
     *     cc: 'manager@example.com',
     *     bcc: 'archive@example.com',
     *     subject: 'Monthly Report',
     *     html: '<h1>Report</h1>',
     *     text: 'Report (plain text)',
     *     replyTo: 'noreply@example.com',
     *     attachments: [
     *         { filename: 'report.pdf', path: './report.pdf' },
     *         { filename: 'data.csv', content: 'name,value\nJohn,100' }
     *     ],
     *     headers: { 'X-Priority': '1' }
     * });
     */
    static async send(configKey, options) {
        const instance = new SendMail.__Internal();
        
        try {
            // Validate config and options
            const config = instance._validateEmailConfig(configKey);
            const validatedOptions = instance._validateEmailOptions(options);
            
            // Create transporter
            const transporter = instance._createTransporter(config);
            
            // Prepare mail options
            const mailOptions = {
                from: config.from || `"${config.name || 'No Reply'}" <${config.user}>`,
                ...validatedOptions
            };
            
            // Send email
            const info = await transporter.sendMail(mailOptions);
            
            // Close transporter
            transporter.close();
            
            console.log('[SendMail Success]', `Message sent: ${info.messageId}`);
            
            return {
                success: true,
                messageId: info.messageId,
                info: info
            };
            
        } catch (error) {
            console.error('[SendMail Error]', error.message);
            
            return {
                success: false,
                error: error
            };
        }
    }
    
    /**
     * Sends multiple emails in parallel
     * 
     * @param {string} configKey - Email configuration key
     * @param {EmailOptions[]} emailList - Array of email options
     * @returns {Promise<EmailResult[]>} Array of results for each email
     * 
     * @example
     * const results = await SendMail.sendBatch('primary', [
     *     { to: 'user1@example.com', subject: 'Hi', html: '<p>Hello User 1</p>' },
     *     { to: 'user2@example.com', subject: 'Hi', html: '<p>Hello User 2</p>' }
     * ]);
     */
    static async sendBatch(configKey, emailList) {
        if (!Array.isArray(emailList)) {
            throw new TypeError('Email list must be an array');
        }
        
        const promises = emailList.map(options => 
            SendMail.send(configKey, options)
        );
        
        return Promise.allSettled(promises).then(results => 
            results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        success: false,
                        error: result.reason,
                        index: index
                    };
                }
            })
        );
    }
    
    /**
     * Verifies SMTP connection for a configuration
     * 
     * @param {string} configKey - Email configuration key
     * @returns {Promise<boolean>} True if connection is valid
     * 
     * @example
     * const isValid = await SendMail.verify('primary');
     * if (!isValid) {
     *     console.error('Email configuration is invalid');
     * }
     */
    static async verify(configKey) {
        const instance = new SendMail.__Internal();
        
        try {
            const config = instance._validateEmailConfig(configKey);
            const transporter = instance._createTransporter(config);
            
            await transporter.verify();
            transporter.close();
            
            console.log('[SendMail Verify]', `Config '${configKey}' is valid`);
            return true;
            
        } catch (error) {
            console.error('[SendMail Verify]', `Config '${configKey}' failed:`, error.message);
            return false;
        }
    }
    
    /**
     * Lists all available email configurations
     * 
     * @returns {string[]} Array of configuration keys
     * 
     * @example
     * const configs = SendMail.listConfigs();
     * console.log('Available email configs:', configs);
     */
    static listConfigs() {
        if (!emails || typeof emails !== 'object') {
            return [];
        }
        return Object.keys(emails);
    }
}

/**
 * Internal class to prevent direct instantiation
 * @private
 */
SendMail.__Internal = class {
    _validateEmailConfig(configKey) {
        return SendMail.prototype._validateEmailConfig.call(this, configKey);
    }
    
    _validateEmailOptions(options) {
        return SendMail.prototype._validateEmailOptions.call(this, options);
    }
    
    _createTransporter(config) {
        return SendMail.prototype._createTransporter.call(this, config);
    }
};

module.exports = SendMail;