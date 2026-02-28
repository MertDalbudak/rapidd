import nodemailer from 'nodemailer';
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EmailConfig {
    host: string;
    port: number;
    secure?: boolean;
    user: string;
    password: string;
    from?: string;
    name?: string;
}

export interface EmailAttachment {
    filename?: string;
    content?: string | Buffer;
    path?: string;
    href?: string;
    contentType?: string;
    encoding?: string;
    cid?: string;
}

export interface EmailOptions {
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string;
    attachments?: EmailAttachment[];
    headers?: Record<string, string>;
}

export interface EmailResult {
    success: boolean;
    messageId?: string;
    error?: Error;
}

// ── Configuration ────────────────────────────────────────────────────────────

let _config: { emails?: Record<string, EmailConfig> } = { emails: {} };
let _configLoaded = false;

function getConfig(): { emails?: Record<string, EmailConfig> } {
    if (!_configLoaded) {
        try {
            _config = require(path.join(process.cwd(), 'config', 'app.json'));
        } catch {
            _config = { emails: {} };
        }
        _configLoaded = true;
    }
    return _config;
}

function getEmailConfig(configKey: string): EmailConfig {
    const config = getConfig();

    if (!config.emails || typeof config.emails !== 'object') {
        throw new Error('Email configuration not found in config/app.json');
    }

    const emailConfig = config.emails[configKey];
    if (!emailConfig) {
        const available = Object.keys(config.emails).join(', ') || 'none';
        throw new Error(`Email config '${configKey}' not found. Available: ${available}`);
    }

    const required: (keyof EmailConfig)[] = ['host', 'port', 'user', 'password'];
    const missing = required.filter(field => !emailConfig[field]);

    if (missing.length > 0) {
        throw new Error(`Email config '${configKey}' missing required fields: ${missing.join(', ')}`);
    }

    return emailConfig;
}

function createTransporter(config: EmailConfig) {
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure ?? config.port === 465,
        auth: {
            user: config.user,
            pass: config.password
        },
        tls: {
            rejectUnauthorized: process.env.NODE_ENV === 'production'
        },
        pool: true,
        maxConnections: 5,
        maxMessages: 100
    });
}

// ── Template Rendering ──────────────────────────────────────────────────────

const TEMPLATES_PATH = path.join(process.cwd(), 'templates', 'email');
const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
    if (templateCache.has(name)) {
        return templateCache.get(name)!;
    }

    const filePath = path.join(TEMPLATES_PATH, `${name}.ejs`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Email template '${name}' not found at ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    templateCache.set(name, content);
    return content;
}

function renderTemplate(name: string, data: Record<string, unknown> = {}): string {
    const template = loadTemplate(name);
    const body = ejs.render(template, data, { filename: path.join(TEMPLATES_PATH, `${name}.ejs`) });

    // Wrap in layout if it exists
    try {
        const layout = loadTemplate('layout');
        return ejs.render(layout, { ...data, body }, { filename: path.join(TEMPLATES_PATH, 'layout.ejs') });
    } catch {
        return body;
    }
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateOptions(options: EmailOptions): void {
    if (!options.to) {
        throw new Error('Recipient (to) is required');
    }

    if (!options.subject) {
        throw new Error('Subject is required');
    }

    if (!options.html && !options.text) {
        throw new Error('Email body (html or text) is required');
    }

    const recipients = Array.isArray(options.to) ? options.to : [options.to];
    for (const email of recipients) {
        if (!validateEmail(email)) {
            throw new Error(`Invalid email address: ${email}`);
        }
    }
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Config-driven email client with multiple SMTP profiles.
 *
 * @example
 * // Simple email
 * await Mailer.send('default', {
 *     to: 'user@example.com',
 *     subject: 'Hello',
 *     html: '<h1>Welcome!</h1>'
 * });
 *
 * @example
 * // With attachments
 * await Mailer.send('support', {
 *     to: ['user1@example.com', 'user2@example.com'],
 *     subject: 'Invoice',
 *     html: '<p>Please find your invoice attached.</p>',
 *     attachments: [
 *         { filename: 'invoice.pdf', path: './invoice.pdf' }
 *     ]
 * });
 *
 * @example
 * // Render EJS template and send
 * await Mailer.sendTemplate('default', 'confirmation', {
 *     to: 'user@example.com',
 *     subject: 'Confirm your email',
 *     data: { name: 'John', confirmationUrl: 'https://...' }
 * });
 *
 * @example
 * // Render template without sending
 * const html = Mailer.render('resetPassword', { name: 'John', resetUrl: '...' });
 */
export const Mailer = {
    /**
     * Send a single email using a configured SMTP profile
     */
    async send(configKey: string, options: EmailOptions): Promise<EmailResult> {
        try {
            const config = getEmailConfig(configKey);
            validateOptions(options);

            const transporter = createTransporter(config);

            const mailOptions = {
                from: config.from || `"${config.name || 'No Reply'}" <${config.user}>`,
                to: options.to,
                subject: options.subject,
                html: options.html,
                text: options.text,
                cc: options.cc,
                bcc: options.bcc,
                replyTo: options.replyTo,
                attachments: options.attachments,
                headers: options.headers
            };

            const info = await transporter.sendMail(mailOptions);
            transporter.close();

            return {
                success: true,
                messageId: info.messageId
            };
        } catch (error) {
            return {
                success: false,
                error: error as Error
            };
        }
    },

    /**
     * Send multiple emails in parallel
     */
    async sendBatch(
        configKey: string,
        emails: EmailOptions[]
    ): Promise<EmailResult[]> {
        const results = await Promise.allSettled(
            emails.map(options => this.send(configKey, options))
        );

        return results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            }
            return {
                success: false,
                error: result.reason
            };
        });
    },

    /**
     * Verify SMTP connection for a configuration
     */
    async verify(configKey: string): Promise<boolean> {
        try {
            const config = getEmailConfig(configKey);
            const transporter = createTransporter(config);

            await transporter.verify();
            transporter.close();

            return true;
        } catch {
            return false;
        }
    },

    /**
     * Render an EJS email template from templates/email/
     */
    render(template: string, data: Record<string, unknown> = {}): string {
        return renderTemplate(template, data);
    },

    /**
     * Render an EJS template and send it as an email
     */
    async sendTemplate(
        configKey: string,
        template: string,
        options: { to: string | string[]; subject: string; data?: Record<string, unknown> } & Omit<EmailOptions, 'html'>
    ): Promise<EmailResult> {
        const { data = {}, ...emailOptions } = options;
        const html = renderTemplate(template, { ...data, subject: options.subject });
        return this.send(configKey, { ...emailOptions, html });
    },

    /**
     * Clear the template cache (e.g. after editing templates in dev)
     */
    clearTemplateCache(): void {
        templateCache.clear();
    },

    /**
     * List available email configurations
     */
    listConfigs(): string[] {
        const config = getConfig();
        return Object.keys(config.emails || {});
    }
};

export default Mailer;
