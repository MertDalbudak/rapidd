import { validateEnv, getEnv, getAllEnv, isProduction, isDevelopment, isTest } from '../../src/core/env';

describe('Environment Utilities', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    // ── validateEnv ────────────────────────────────────────

    describe('validateEnv()', () => {
        it('should pass when DATABASE_URL is set', () => {
            process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
            expect(() => validateEnv()).not.toThrow();
        });

        it('should throw when DATABASE_URL is missing', () => {
            delete process.env.DATABASE_URL;
            expect(() => validateEnv()).toThrow('Missing required environment variables');
            expect(() => validateEnv()).toThrow('DATABASE_URL');
        });

        it('should throw for invalid DATABASE_URL format', () => {
            process.env.DATABASE_URL = 'sqlite://local.db';
            expect(() => validateEnv()).toThrow('Invalid DATABASE_URL format');
        });

        it('should accept postgresql:// prefix', () => {
            process.env.DATABASE_URL = 'postgresql://user:pass@localhost/db';
            expect(() => validateEnv()).not.toThrow();
        });

        it('should accept postgres:// prefix', () => {
            process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';
            expect(() => validateEnv()).not.toThrow();
        });

        it('should accept mysql:// prefix', () => {
            process.env.DATABASE_URL = 'mysql://user:pass@localhost/db';
            expect(() => validateEnv()).not.toThrow();
        });

        it('should accept mariadb:// prefix', () => {
            process.env.DATABASE_URL = 'mariadb://user:pass@localhost/db';
            expect(() => validateEnv()).not.toThrow();
        });
    });

    // ── getEnv ─────────────────────────────────────────────

    describe('getEnv()', () => {
        it('should return env var value', () => {
            process.env.NODE_ENV = 'production';
            expect(getEnv('NODE_ENV')).toBe('production');
        });

        it('should return default for missing var', () => {
            delete process.env.PORT;
            expect(getEnv('PORT')).toBe(3000);
        });

        it('should coerce number defaults', () => {
            process.env.PORT = '8080';
            expect(getEnv('PORT')).toBe(8080);
        });

        it('should coerce boolean defaults', () => {
            process.env.RATE_LIMIT_ENABLED = 'false';
            expect(getEnv('RATE_LIMIT_ENABLED')).toBe(false);
        });

        it('should coerce boolean true', () => {
            process.env.RATE_LIMIT_ENABLED = 'true';
            expect(getEnv('RATE_LIMIT_ENABLED')).toBe(true);
        });

        it('should return default for empty string', () => {
            process.env.HOST = '';
            expect(getEnv('HOST')).toBe('0.0.0.0');
        });

        it('should return string value', () => {
            process.env.HOST = '127.0.0.1';
            expect(getEnv('HOST')).toBe('127.0.0.1');
        });

        it('should return undefined for optional vars without defaults', () => {
            delete process.env.JWT_SECRET;
            expect(getEnv('JWT_SECRET')).toBeUndefined();
        });
    });

    // ── getAllEnv ───────────────────────────────────────────

    describe('getAllEnv()', () => {
        it('should return all config with defaults', () => {
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            const config = getAllEnv();
            expect(config.DATABASE_URL).toBe('postgresql://localhost/db');
            expect(config.PORT).toBeDefined();
            expect(config.HOST).toBeDefined();
        });

        it('should include required vars', () => {
            process.env.DATABASE_URL = 'postgresql://localhost/test';
            const config = getAllEnv();
            expect(config.DATABASE_URL).toBe('postgresql://localhost/test');
        });
    });

    // ── Environment helpers ────────────────────────────────

    describe('isProduction()', () => {
        it('should return true in production', () => {
            process.env.NODE_ENV = 'production';
            expect(isProduction()).toBe(true);
        });

        it('should return false in development', () => {
            process.env.NODE_ENV = 'development';
            expect(isProduction()).toBe(false);
        });
    });

    describe('isDevelopment()', () => {
        it('should return true in development', () => {
            process.env.NODE_ENV = 'development';
            expect(isDevelopment()).toBe(true);
        });

        it('should return false in production', () => {
            process.env.NODE_ENV = 'production';
            expect(isDevelopment()).toBe(false);
        });
    });

    describe('isTest()', () => {
        it('should return true in test', () => {
            process.env.NODE_ENV = 'test';
            expect(isTest()).toBe(true);
        });

        it('should return false in production', () => {
            process.env.NODE_ENV = 'production';
            expect(isTest()).toBe(false);
        });
    });
});
