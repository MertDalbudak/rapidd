import { appendFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = 'essential' | 'fine' | 'finest';

// ── Level Config ─────────────────────────────────────────────────────────────

const LEVELS: LogLevel[] = ['essential', 'fine', 'finest'];

function parseLevel(value: string | undefined): LogLevel {
    if (value && LEVELS.includes(value as LogLevel)) {
        return value as LogLevel;
    }
    return 'essential';
}

// ── State ────────────────────────────────────────────────────────────────────

const _level: LogLevel = parseLevel(process.env.LOG_LEVEL);
const _silent: boolean = process.env.NODE_ENV === 'test';
const _logDir: string = process.env.LOG_DIR ?? 'logs';

// ── File Writing ─────────────────────────────────────────────────────────────

let _dirChecked = false;

function ensureLogDir(): void {
    if (_dirChecked || !_logDir) return;
    const dir = path.isAbsolute(_logDir) ? _logDir : path.join(process.cwd(), _logDir);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    _dirChecked = true;
}

function writeToFile(filename: string, line: string): void {
    if (!_logDir) return;
    try {
        ensureLogDir();
        const dir = path.isAbsolute(_logDir) ? _logDir : path.join(process.cwd(), _logDir);
        appendFileSync(path.join(dir, filename), line + '\n');
    } catch {
        // Silently ignore file write failures — don't crash the app for logging
    }
}

// ── Formatting ───────────────────────────────────────────────────────────────

function timestamp(): string {
    return new Date().toISOString();
}

function formatData(data: unknown[]): string {
    if (data.length === 0) return '';
    const parts = data.map(d => {
        if (d === null || d === undefined) return String(d);
        if (typeof d === 'object') {
            try { return JSON.stringify(d); } catch { return String(d); }
        }
        return String(d);
    });
    return ' ' + parts.join(' ');
}

function formatDataPretty(data: unknown[]): string {
    if (data.length === 0) return '';
    const parts = data.map(d => {
        if (d === null || d === undefined) return String(d);
        if (typeof d === 'object') {
            try { return JSON.stringify(d, null, 2); } catch { return String(d); }
        }
        return String(d);
    });
    return '\n' + parts.join('\n');
}

function formatError(error: Error | string | unknown): { message: string; toString: string; stack: string } {
    if (error instanceof Error) {
        return {
            message: error.message,
            toString: error.toString(),
            stack: error.stack || error.toString(),
        };
    }
    const str = String(error);
    return { message: str, toString: str, stack: str };
}

// ── Logger ───────────────────────────────────────────────────────────────────

export const Logger = {
    log(message: string, ...data: unknown[]): void {
        if (_silent) return;

        let output: string;
        switch (_level) {
            case 'essential':
                output = `[${timestamp()}] [LOG] ${message}`;
                break;
            case 'fine':
                output = `[${timestamp()}] [LOG] ${message}${formatData(data)}`;
                break;
            case 'finest':
                output = `[${timestamp()}] [LOG] ${message}${formatDataPretty(data)}`;
                break;
        }

        console.log(output);
        writeToFile('app.log', output);
    },

    warn(message: string, ...data: unknown[]): void {
        if (_silent) return;

        let output: string;
        switch (_level) {
            case 'essential':
                output = `[${timestamp()}] [WARN] ${message}`;
                break;
            case 'fine':
                output = `[${timestamp()}] [WARN] ${message}${formatData(data)}`;
                break;
            case 'finest':
                output = `[${timestamp()}] [WARN] ${message}${formatDataPretty(data)}`;
                break;
        }

        console.warn(output);
        writeToFile('app.log', output);
    },

    error(error: Error | string | unknown, ...data: unknown[]): void {
        if (_silent) return;

        const err = formatError(error);
        let output: string;

        switch (_level) {
            case 'essential':
                output = `[${timestamp()}] [ERROR] ${err.message}`;
                break;
            case 'fine':
                output = `[${timestamp()}] [ERROR] ${err.toString}${formatData(data)}`;
                break;
            case 'finest':
                output = `[${timestamp()}] [ERROR] ${err.stack}${formatDataPretty(data)}`;
                break;
        }

        console.error(output);
        writeToFile('error.log', output);
    },
};

export default Logger;
