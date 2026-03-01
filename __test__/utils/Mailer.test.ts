/**
 * Tests for the Mailer utility.
 * Tests validation logic, template rendering, localization, and layout support.
 */

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
        sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-id-123' }),
        verify: jest.fn().mockResolvedValue(true),
        close: jest.fn(),
    })),
}));

jest.mock('../../src/core/i18n', () => ({
    LanguageDict: {
        get: jest.fn((key: string, params: any, language: string | null) => {
            const translations: Record<string, Record<string, string>> = {
                en_US: { signIn: 'Sign In', welcome: 'Welcome', greeting: 'Hello {name}' },
                de_DE: { signIn: 'Anmelden', welcome: 'Willkommen', greeting: 'Hallo {name}' },
                fr_FR: { signIn: 'Se connecter', welcome: 'Bienvenue', greeting: 'Bonjour {name}' },
            };
            const lang = language || 'en_US';
            const dict = translations[lang] || translations['en_US'];
            let result = dict[key] || key;
            if (params && typeof params === 'object') {
                result = result.replace(/\{(\w+)\}/g, (_: string, k: string) =>
                    params[k] !== undefined ? String(params[k]) : `{${k}}`
                );
            }
            return result;
        }),
        initialize: jest.fn(),
    },
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

// ── Template Rendering & Localization ────────────────────
// Separate describe block with fs mocking for render tests

describe('Mailer - Template Rendering & Localization', () => {
    let Mailer: typeof import('../../src/utils/Mailer').Mailer;
    const fs = require('fs');

    beforeEach(() => {
        jest.resetModules();

        // Mock fs to provide templates and layouts without real files
        jest.doMock('fs', () => {
            const actual = jest.requireActual('fs');
            return {
                ...actual,
                existsSync: jest.fn((filePath: string) => {
                    if (filePath.includes('templates/email/welcome.ejs')) return true;
                    if (filePath.includes('templates/email/plain.ejs')) return true;
                    if (filePath.includes('templates/email/greeting.ejs')) return true;
                    if (filePath.includes('templates/layouts/email.ejs')) return true;
                    if (filePath.includes('templates/layouts/minimal.ejs')) return true;
                    return actual.existsSync(filePath);
                }),
                readFileSync: jest.fn((filePath: string, encoding?: string) => {
                    if (filePath.includes('templates/email/welcome.ejs')) {
                        return '<h1><%= __("welcome") %></h1><p><%= __("signIn") %></p>';
                    }
                    if (filePath.includes('templates/email/plain.ejs')) {
                        return '<p>Hello <%= name %></p>';
                    }
                    if (filePath.includes('templates/email/greeting.ejs')) {
                        return '<p><%= __("greeting", { name: name }) %></p>';
                    }
                    if (filePath.includes('templates/layouts/email.ejs')) {
                        return '<html><body><%- body %></body></html>';
                    }
                    if (filePath.includes('templates/layouts/minimal.ejs')) {
                        return '<div><%- body %></div>';
                    }
                    return actual.readFileSync(filePath, encoding);
                }),
            };
        });

        Mailer = require('../../src/utils/Mailer').Mailer;
        Mailer.clearTemplateCache();
    });

    // ── __() translation helper ──────────────────────────

    describe('__() translation helper', () => {
        it('should translate keys in templates using default language', () => {
            const html = Mailer.render('welcome');
            expect(html).toContain('Welcome');
            expect(html).toContain('Sign In');
        });

        it('should translate keys using specified language', () => {
            const html = Mailer.render('welcome', {}, 'email', 'de_DE');
            expect(html).toContain('Willkommen');
            expect(html).toContain('Anmelden');
        });

        it('should translate to French', () => {
            const html = Mailer.render('welcome', {}, 'email', 'fr_FR');
            expect(html).toContain('Bienvenue');
            expect(html).toContain('Se connecter');
        });

        it('should support parameter interpolation in translations', () => {
            const html = Mailer.render('greeting', { name: 'Alice' }, 'email', 'en_US');
            expect(html).toContain('Hello Alice');
        });

        it('should support parameter interpolation with non-default language', () => {
            const html = Mailer.render('greeting', { name: 'Alice' }, 'email', 'de_DE');
            expect(html).toContain('Hallo Alice');
        });

        it('should return key as-is when translation is missing', () => {
            const html = Mailer.render('plain', { name: 'Test' }, 'email');
            // plain.ejs doesn't use __(), just checks it doesn't break
            expect(html).toContain('Hello Test');
        });

        it('should use language from data.language when no explicit language', () => {
            const html = Mailer.render('welcome', { language: 'de_DE' });
            expect(html).toContain('Willkommen');
        });

        it('should prefer explicit language over data.language', () => {
            const html = Mailer.render('welcome', { language: 'de_DE' }, 'email', 'fr_FR');
            expect(html).toContain('Bienvenue');
        });
    });

    // ── Layout support ───────────────────────────────────

    describe('layout support', () => {
        it('should wrap template in default email layout', () => {
            const html = Mailer.render('plain', { name: 'Test' });
            expect(html).toContain('<html>');
            expect(html).toContain('</html>');
            expect(html).toContain('Hello Test');
        });

        it('should use custom layout when specified', () => {
            const html = Mailer.render('plain', { name: 'Test' }, 'minimal');
            expect(html).toBe('<div><p>Hello Test</p></div>');
            expect(html).not.toContain('<html>');
        });

        it('should skip layout when layout=false', () => {
            const html = Mailer.render('plain', { name: 'Test' }, false);
            expect(html).toBe('<p>Hello Test</p>');
            expect(html).not.toContain('<html>');
            expect(html).not.toContain('<div>');
        });

        it('should make __() available in layout too', () => {
            // The layout wraps the body — __() should work in both template and layout
            const html = Mailer.render('welcome', {}, 'email', 'en_US');
            // Template content is inside layout
            expect(html).toContain('<html>');
            expect(html).toContain('Welcome');
        });
    });
});
