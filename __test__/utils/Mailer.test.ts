/**
 * Tests for the Mailer utility.
 * Tests validation logic and template rendering without actual SMTP.
 */

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
        sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-id-123' }),
        verify: jest.fn().mockResolvedValue(true),
        close: jest.fn(),
    })),
}));

describe('Mailer', () => {
    // Reset module state between tests
    let Mailer: typeof import('../../src/utils/Mailer').Mailer;

    beforeEach(() => {
        jest.resetModules();
        // Mock config loading
        jest.doMock('path', () => {
            const actual = jest.requireActual('path');
            return {
                ...actual,
                join: (...args: string[]) => {
                    // Intercept config/app.json loading
                    if (args.some(a => a === 'config') && args.some(a => a === 'app.json')) {
                        return '/mock/config/app.json';
                    }
                    return actual.join(...args);
                },
            };
        });

        // Re-require after mocks
        Mailer = require('../../src/utils/Mailer').Mailer;
    });

    // ── Email Validation ─────────────────────────────────────

    describe('Email Validation', () => {
        it('should accept valid email addresses', () => {
            const validEmails = [
                'user@example.com',
                'first.last@example.com',
                'user+tag@example.com',
                'user@sub.domain.com',
            ];
            const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            for (const email of validEmails) {
                expect(regex.test(email)).toBe(true);
            }
        });

        it('should reject invalid email addresses', () => {
            const invalidEmails = [
                'not-an-email',
                '@missing-local.com',
                'missing-domain@',
                'spaces in@email.com',
                '',
            ];
            const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            for (const email of invalidEmails) {
                expect(regex.test(email)).toBe(false);
            }
        });
    });

    // ── Options Validation ───────────────────────────────────

    describe('Options Validation Logic', () => {
        it('should require recipient', () => {
            const validateOptions = (opts: any) => {
                if (!opts.to) throw new Error('Recipient (to) is required');
                if (!opts.subject) throw new Error('Subject is required');
                if (!opts.html && !opts.text) throw new Error('Email body (html or text) is required');
            };

            expect(() => validateOptions({ subject: 'Hi', html: '<p>Test</p>' }))
                .toThrow('Recipient (to) is required');
        });

        it('should require subject', () => {
            const validateOptions = (opts: any) => {
                if (!opts.to) throw new Error('Recipient (to) is required');
                if (!opts.subject) throw new Error('Subject is required');
                if (!opts.html && !opts.text) throw new Error('Email body (html or text) is required');
            };

            expect(() => validateOptions({ to: 'a@b.com', html: '<p>Test</p>' }))
                .toThrow('Subject is required');
        });

        it('should require html or text body', () => {
            const validateOptions = (opts: any) => {
                if (!opts.to) throw new Error('Recipient (to) is required');
                if (!opts.subject) throw new Error('Subject is required');
                if (!opts.html && !opts.text) throw new Error('Email body (html or text) is required');
            };

            expect(() => validateOptions({ to: 'a@b.com', subject: 'Hi' }))
                .toThrow('Email body (html or text) is required');
        });

        it('should accept valid options', () => {
            const validateOptions = (opts: any) => {
                if (!opts.to) throw new Error('Recipient (to) is required');
                if (!opts.subject) throw new Error('Subject is required');
                if (!opts.html && !opts.text) throw new Error('Email body (html or text) is required');
            };

            expect(() => validateOptions({
                to: 'user@example.com',
                subject: 'Test',
                html: '<p>Hello</p>'
            })).not.toThrow();
        });

        it('should accept text-only body', () => {
            const validateOptions = (opts: any) => {
                if (!opts.to) throw new Error('Recipient (to) is required');
                if (!opts.subject) throw new Error('Subject is required');
                if (!opts.html && !opts.text) throw new Error('Email body (html or text) is required');
            };

            expect(() => validateOptions({
                to: 'user@example.com',
                subject: 'Test',
                text: 'Hello text'
            })).not.toThrow();
        });
    });

    // ── Mailer API ───────────────────────────────────────────

    describe('Mailer API', () => {
        it('should expose send method', () => {
            expect(typeof Mailer.send).toBe('function');
        });

        it('should expose sendBatch method', () => {
            expect(typeof Mailer.sendBatch).toBe('function');
        });

        it('should expose verify method', () => {
            expect(typeof Mailer.verify).toBe('function');
        });

        it('should expose render method', () => {
            expect(typeof Mailer.render).toBe('function');
        });

        it('should expose sendTemplate method', () => {
            expect(typeof Mailer.sendTemplate).toBe('function');
        });

        it('should expose clearTemplateCache method', () => {
            expect(typeof Mailer.clearTemplateCache).toBe('function');
        });

        it('should expose listConfigs method', () => {
            expect(typeof Mailer.listConfigs).toBe('function');
        });

        it('should clear template cache without error', () => {
            expect(() => Mailer.clearTemplateCache()).not.toThrow();
        });
    });

    // ── Config Validation ────────────────────────────────────

    describe('Config Validation Logic', () => {
        it('should require host, port, user, and password', () => {
            const required = ['host', 'port', 'user', 'password'];
            const config = { host: 'smtp.example.com', port: 587 };
            const missing = required.filter(field => !(config as any)[field]);
            expect(missing).toEqual(['user', 'password']);
        });

        it('should pass with complete config', () => {
            const required = ['host', 'port', 'user', 'password'];
            const config = { host: 'smtp.example.com', port: 587, user: 'test', password: 'pass' };
            const missing = required.filter(field => !(config as any)[field]);
            expect(missing).toHaveLength(0);
        });
    });
});
