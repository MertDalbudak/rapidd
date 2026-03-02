/**
 * Tests for the Logger utility.
 * Uses jest.isolateModules to re-import Logger with different env vars per test.
 */
import fs from 'fs';
import path from 'path';

// Helper to load Logger with specific env vars
function loadLogger(env: Record<string, string> = {}): typeof import('../../src/utils/Logger') {
    let mod: typeof import('../../src/utils/Logger');
    const original = { ...process.env };

    // Override env
    process.env.NODE_ENV = env.NODE_ENV ?? 'development';
    process.env.LOG_LEVEL = env.LOG_LEVEL ?? 'essential';
    process.env.LOG_DIR = env.LOG_DIR ?? '';

    jest.isolateModules(() => {
        mod = require('../../src/utils/Logger');
    });

    // Restore env
    process.env = original;

    return mod!;
}

describe('Logger', () => {
    let consoleSpy: { log: jest.SpyInstance; warn: jest.SpyInstance; error: jest.SpyInstance };

    beforeEach(() => {
        consoleSpy = {
            log: jest.spyOn(console, 'log').mockImplementation(),
            warn: jest.spyOn(console, 'warn').mockImplementation(),
            error: jest.spyOn(console, 'error').mockImplementation(),
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── Silent in test mode ──────────────────────────────────

    describe('silent in test mode', () => {
        it('should not write to console when NODE_ENV=test', () => {
            const { Logger } = loadLogger({ NODE_ENV: 'test' });

            Logger.log('test message');
            Logger.warn('test warning');
            Logger.error('test error');

            expect(consoleSpy.log).not.toHaveBeenCalled();
            expect(consoleSpy.warn).not.toHaveBeenCalled();
            expect(consoleSpy.error).not.toHaveBeenCalled();
        });
    });

    // ── log() verbosity ──────────────────────────────────────

    describe('log()', () => {
        it('at essential — outputs message only, no data', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });

            Logger.log('Server running', { host: '0.0.0.0', port: 3000 });

            expect(consoleSpy.log).toHaveBeenCalledTimes(1);
            const output = consoleSpy.log.mock.calls[0][0] as string;
            expect(output).toMatch(/\[LOG\] Server running$/);
            expect(output).not.toContain('0.0.0.0');
        });

        it('at fine — outputs message + compact JSON data', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'fine' });

            Logger.log('Server running', { host: '0.0.0.0', port: 3000 });

            const output = consoleSpy.log.mock.calls[0][0] as string;
            expect(output).toContain('[LOG] Server running');
            expect(output).toContain('"host":"0.0.0.0"');
            expect(output).toContain('"port":3000');
            // Compact — no newlines in the data
            const afterMessage = output.split('[LOG] Server running')[1];
            expect(afterMessage).not.toContain('\n');
        });

        it('at finest — outputs message + pretty JSON data', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'finest' });

            Logger.log('Server running', { host: '0.0.0.0', port: 3000 });

            const output = consoleSpy.log.mock.calls[0][0] as string;
            expect(output).toContain('[LOG] Server running');
            expect(output).toContain('"host": "0.0.0.0"');
            // Pretty — contains newlines
            const afterMessage = output.split('[LOG] Server running')[1];
            expect(afterMessage).toContain('\n');
        });

        it('writes to console.log', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });

            Logger.log('test');

            expect(consoleSpy.log).toHaveBeenCalledTimes(1);
            expect(consoleSpy.warn).not.toHaveBeenCalled();
            expect(consoleSpy.error).not.toHaveBeenCalled();
        });
    });

    // ── warn() verbosity ─────────────────────────────────────

    describe('warn()', () => {
        it('at essential — outputs message only', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });

            Logger.warn('Deprecation notice', { feature: 'oldApi' });

            const output = consoleSpy.warn.mock.calls[0][0] as string;
            expect(output).toMatch(/\[WARN\] Deprecation notice$/);
            expect(output).not.toContain('oldApi');
        });

        it('at fine — outputs message + compact data', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'fine' });

            Logger.warn('Deprecation notice', { feature: 'oldApi' });

            const output = consoleSpy.warn.mock.calls[0][0] as string;
            expect(output).toContain('[WARN] Deprecation notice');
            expect(output).toContain('"feature":"oldApi"');
        });

        it('writes to console.warn', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });

            Logger.warn('test');

            expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
            expect(consoleSpy.log).not.toHaveBeenCalled();
            expect(consoleSpy.error).not.toHaveBeenCalled();
        });
    });

    // ── error() verbosity ────────────────────────────────────

    describe('error()', () => {
        it('at essential — outputs err.message only', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });
            const err = new Error('Connection refused');

            Logger.error(err, { host: 'redis:6379' });

            const output = consoleSpy.error.mock.calls[0][0] as string;
            expect(output).toContain('[ERROR] Connection refused');
            expect(output).not.toContain('redis:6379');
            expect(output).not.toContain('Error:');
        });

        it('at fine — outputs err.toString() + compact data', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'fine' });
            const err = new Error('Connection refused');

            Logger.error(err, { host: 'redis:6379' });

            const output = consoleSpy.error.mock.calls[0][0] as string;
            expect(output).toContain('[ERROR] Error: Connection refused');
            expect(output).toContain('"host":"redis:6379"');
        });

        it('at finest — outputs full stack + pretty data', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'finest' });
            const err = new Error('Connection refused');

            Logger.error(err, { host: 'redis:6379', retries: 3 });

            const output = consoleSpy.error.mock.calls[0][0] as string;
            expect(output).toContain('[ERROR]');
            expect(output).toContain('at '); // Stack trace
            expect(output).toContain('"host": "redis:6379"'); // Pretty JSON
        });

        it('handles string errors', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });

            Logger.error('Something went wrong');

            const output = consoleSpy.error.mock.calls[0][0] as string;
            expect(output).toContain('[ERROR] Something went wrong');
        });

        it('writes to console.error', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });

            Logger.error('test');

            expect(consoleSpy.error).toHaveBeenCalledTimes(1);
            expect(consoleSpy.log).not.toHaveBeenCalled();
            expect(consoleSpy.warn).not.toHaveBeenCalled();
        });
    });

    // ── Timestamp format ─────────────────────────────────────

    describe('timestamp', () => {
        it('includes ISO timestamp in output', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential' });

            Logger.log('test');

            const output = consoleSpy.log.mock.calls[0][0] as string;
            expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
        });
    });

    // ── Invalid LOG_LEVEL ────────────────────────────────────

    describe('invalid LOG_LEVEL', () => {
        it('defaults to essential for unknown values', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'debug' });

            Logger.log('test message', { data: true });

            const output = consoleSpy.log.mock.calls[0][0] as string;
            // Essential = no data
            expect(output).toMatch(/\[LOG\] test message$/);
        });
    });

    // ── File writing ─────────────────────────────────────────

    describe('file output', () => {
        const tmpDir = path.join(__dirname, '../../.tmp-logger-test');

        afterEach(() => {
            if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true });
            }
        });

        it('log/warn append to app.log', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential', LOG_DIR: tmpDir });

            Logger.log('info message');
            Logger.warn('warn message');

            const appLog = fs.readFileSync(path.join(tmpDir, 'app.log'), 'utf-8');
            expect(appLog).toContain('[LOG] info message');
            expect(appLog).toContain('[WARN] warn message');
        });

        it('error appends to error.log', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential', LOG_DIR: tmpDir });

            Logger.error('critical failure');

            const errorLog = fs.readFileSync(path.join(tmpDir, 'error.log'), 'utf-8');
            expect(errorLog).toContain('[ERROR] critical failure');
        });

        it('LOG_DIR="" disables file logging', () => {
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential', LOG_DIR: '' });

            Logger.log('should not write');
            Logger.error('should not write');

            // No files created (tmpDir should not exist since LOG_DIR is empty)
            expect(fs.existsSync(tmpDir)).toBe(false);
        });

        it('creates log directory if it does not exist', () => {
            const nestedDir = path.join(tmpDir, 'nested', 'logs');
            const { Logger } = loadLogger({ LOG_LEVEL: 'essential', LOG_DIR: nestedDir });

            Logger.log('test');

            expect(fs.existsSync(nestedDir)).toBe(true);
            expect(fs.existsSync(path.join(nestedDir, 'app.log'))).toBe(true);
        });
    });
});
