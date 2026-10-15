import { AsyncLocalStorage } from 'async_hooks';
import { mkdirSync, existsSync, createWriteStream, WriteStream } from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = 'essential' | 'fine' | 'finest';
export type LogFormat = 'text' | 'json';

/** Correlation data attached to every log line written while handling a request */
export interface LogContext {
    requestId?: string;
    [key: string]: unknown;
}

// ── Level Config ─────────────────────────────────────────────────────────────

const LEVELS: LogLevel[] = ['essential', 'fine', 'finest'];

function parseLevel(value: string | undefined): LogLevel {
    if (value && LEVELS.includes(value as LogLevel)) {
        return value as LogLevel;
    }
    return 'essential';
}

// ── State ────────────────────────────────────────────────────────────────────

// Read from the environment at load and again by Logger.configure() — e.g. after the setup
// wizard has written the configuration
let _level: LogLevel = parseLevel(process.env.LOG_LEVEL);
let _format: LogFormat = process.env.LOG_FORMAT === 'json' ? 'json' : 'text';
let _silent: boolean = process.env.NODE_ENV === 'test';
let _logDir: string = process.env.LOG_DIR ?? 'logs';
const _context = new AsyncLocalStorage<LogContext>();

// ── Redaction ────────────────────────────────────────────────────────────────

// Bodies and headers are only logged at `finest` — and must never leak credentials there
const sensitiveHeaders = () => new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization',
    (process.env.AUTH_CUSTOM_HEADER || 'x-auth-token').toLowerCase()]);
let SENSITIVE_HEADERS = sensitiveHeaders();
const SENSITIVE_KEY = /pass(word|wd)?$|secret|token|ticket|authorization|api[-_]?key|private[-_]?key|^saml(request|response)$|^relaystate$/i;
const REDACTED = '[REDACTED]';

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        out[key] = SENSITIVE_HEADERS.has(lower) && value !== undefined ? REDACTED
            : lower === 'location' && typeof value === 'string' ? redactUrl(value)
                : value;
    }
    return out;
}

// Credentials that travel in URLs: login tickets, tokens, SAML messages (also on the way to the
// identity provider) — and, on /auth/ routes, OAuth codes and the key to a parked SAML answer
const SENSITIVE_PARAM = /^(auth_ticket|ticket|token|access_token|id_token|refresh_token|password|client_secret|api_key|apikey|SAMLRequest|SAMLResponse|RelayState)$/i;
const SENSITIVE_AUTH_PARAM = /^(code|state|session_state|response)$/i;

/** Replace the values of credential-carrying query parameters */
function redactUrl(url: string): string {
    const q = url.indexOf('?');
    if (q === -1) return url;
    const hash = url.indexOf('#', q);
    const path = url.slice(0, q);
    const query = url.slice(q + 1, hash === -1 ? undefined : hash);
    const authRoute = path.includes('/auth/');
    const redacted = query.split('&').map((pair) => {
        const name = pair.split('=')[0];
        let decoded = name;
        try { decoded = decodeURIComponent(name); } catch { /* keep raw */ }
        return SENSITIVE_PARAM.test(decoded) || (authRoute && SENSITIVE_AUTH_PARAM.test(decoded))
            ? `${name}=${REDACTED}` : pair;
    }).join('&');
    return `${path}?${redacted}${hash === -1 ? '' : url.slice(hash)}`;
}

function redactBody(body: unknown, depth = 0): unknown {
    if (typeof body === 'string') {
        try {
            return redactBody(JSON.parse(body), depth);
        } catch {
            return body;
        }
    }
    if (body === null || typeof body !== 'object' || depth > 8) return body;
    if (Array.isArray(body)) return body.map((item) => redactBody(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactBody(value, depth + 1);
    }
    return out;
}

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

// Lazily-created append streams — writes are buffered and flushed off the event
// loop instead of blocking every request with a synchronous open+write+close.
// fs.WriteStream does not keep the process alive between writes.
const _streams = new Map<string, WriteStream>();

function writeToFile(filename: string, line: string): void {
    if (!_logDir) return;
    try {
        ensureLogDir();
        let stream = _streams.get(filename);
        if (!stream || stream.destroyed) {
            const dir = path.isAbsolute(_logDir) ? _logDir : path.join(process.cwd(), _logDir);
            stream = createWriteStream(path.join(dir, filename), { flags: 'a' });
            stream.on('error', () => {
                // Silently ignore file write failures — don't crash the app for logging
                _streams.delete(filename);
            });
            _streams.set(filename, stream);
        }
        stream.write(line + '\n');
    } catch {
        // Silently ignore file write failures — don't crash the app for logging
    }
}

// ── Formatting ───────────────────────────────────────────────────────────────

function timestamp(): string {
    return new Date().toISOString();
}

function safeStringify(value: unknown, indent?: number): string {
    try {
        return JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, indent);
    } catch {
        return String(value);
    }
}

function formatData(data: unknown[]): string {
    if (data.length === 0) return '';
    const parts = data.map(d => {
        if (d === null || d === undefined) return String(d);
        if (typeof d === 'object') return safeStringify(d);
        return String(d);
    });
    return ' ' + parts.join(' ');
}

function formatDataPretty(data: unknown[]): string {
    if (data.length === 0) return '';
    const parts = data.map(d => {
        if (d === null || d === undefined) return String(d);
        if (typeof d === 'object') return safeStringify(d, 2);
        return String(d);
    });
    return '\n' + parts.join('\n');
}

function formatHeaders(headers: Record<string, unknown>): string {
    return Object.entries(headers)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n');
}

function formatBody(body: unknown): string {
    if (body === null || body === undefined) return '  (empty)';
    if (typeof body === 'object') return '  ' + safeStringify(body, 2).replace(/\n/g, '\n  ');
    return '  ' + String(body);
}

function formatError(error: Error | string | unknown): { message: string; toString: string; stack: string; name?: string } {
    if (error instanceof Error) {
        return {
            message: error.message,
            toString: error.toString(),
            stack: error.stack || error.toString(),
            name: error.name,
        };
    }
    const str = String(error);
    return { message: str, toString: str, stack: str };
}

/** ` [req:<id>]` for text lines written inside a request */
function contextSuffix(): string {
    const requestId = _context.getStore()?.requestId;
    return requestId ? ` [req:${requestId}]` : '';
}

/** JSON line: plain-object data args are merged into the record, anything else lands in `args` */
function jsonLine(level: string, msg: string, data: unknown[], extra: Record<string, unknown> = {}): string {
    const record: Record<string, unknown> = { time: timestamp(), level, msg, ...(_context.getStore() || {}), ...extra };
    const args: unknown[] = [];
    if (_level !== 'essential') {
        for (const d of data) {
            if (d && typeof d === 'object' && !Array.isArray(d) && !(d instanceof Error)) {
                for (const [k, v] of Object.entries(d)) {
                    if (!(k in record)) record[k] = v;
                }
            } else if (d !== undefined) {
                args.push(d instanceof Error ? formatError(d).message : d);
            }
        }
    }
    if (args.length) record.args = args;
    return safeStringify(record);
}

function textLine(tag: string, message: string, data: unknown[]): string {
    switch (_level) {
        case 'essential':
            return `[${timestamp()}] [${tag}]${contextSuffix()} ${message}`;
        case 'fine':
            return `[${timestamp()}] [${tag}]${contextSuffix()} ${message}${formatData(data)}`;
        case 'finest':
            return `[${timestamp()}] [${tag}]${contextSuffix()} ${message}${formatDataPretty(data)}`;
    }
}

// ── Logger ───────────────────────────────────────────────────────────────────

export const Logger = {
    /**
     * Re-read LOG_LEVEL, LOG_FORMAT, LOG_DIR and AUTH_CUSTOM_HEADER from the environment.
     * Open log files are closed first, so a new LOG_DIR takes effect.
     */
    configure(): void {
        for (const stream of _streams.values()) stream.end();
        _streams.clear();
        _level = parseLevel(process.env.LOG_LEVEL);
        _format = process.env.LOG_FORMAT === 'json' ? 'json' : 'text';
        _silent = process.env.NODE_ENV === 'test';
        _logDir = process.env.LOG_DIR ?? 'logs';
        _dirChecked = false;
        SENSITIVE_HEADERS = sensitiveHeaders();
    },

    /** Active log level (from LOG_LEVEL env) — lets callers skip expensive capture work */
    get level(): LogLevel {
        return _level;
    },

    /** Output format (LOG_FORMAT env): 'text' (default) or 'json' (one object per line) */
    get format(): LogFormat {
        return _format;
    },

    /**
     * Run `fn` with a log context: every line logged inside it (across awaits) carries the
     * context — the framework uses it to stamp each request's lines with its request id.
     */
    withContext<T>(context: LogContext, fn: () => T): T {
        return _context.run({ ...(_context.getStore() || {}), ...context }, fn);
    },

    /** The current log context (e.g. `{ requestId }` inside a request), if any */
    context(): LogContext | undefined {
        return _context.getStore();
    },

    /**
     * Flush all buffered log writes to disk. Writes are buffered through append
     * streams for performance — call this on graceful shutdown (buildApp wires it
     * into the Fastify onClose hook) or in tests before reading log files.
     */
    async flush(): Promise<void> {
        const streams = [..._streams.values()];
        _streams.clear();
        await Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
            stream.end(() => resolve());
        })));
    },

    log(message: string, ...data: unknown[]): void {
        if (_silent) return;
        const output = _format === 'json' ? jsonLine('info', message, data) : textLine('LOG', message, data);
        console.log(output);
        writeToFile('app.log', output);
    },

    warn(message: string, ...data: unknown[]): void {
        if (_silent) return;
        const output = _format === 'json' ? jsonLine('warn', message, data) : textLine('WARN', message, data);
        console.warn(output);
        writeToFile('app.log', output);
    },

    error(error: Error | string | unknown, ...data: unknown[]): void {
        if (_silent) return;

        const err = formatError(error);
        let output: string;

        if (_format === 'json') {
            output = jsonLine('error', err.message, data, error instanceof Error
                ? { err: { type: err.name, message: err.message, ...(_level !== 'essential' ? { stack: err.stack } : {}) } }
                : {});
        } else {
            switch (_level) {
                case 'essential':
                    output = `[${timestamp()}] [ERROR]${contextSuffix()} ${err.message}`;
                    break;
                case 'fine':
                    output = `[${timestamp()}] [ERROR]${contextSuffix()} ${err.toString}${formatData(data)}`;
                    break;
                case 'finest':
                    output = `[${timestamp()}] [ERROR]${contextSuffix()} ${err.stack}${formatDataPretty(data)}`;
                    break;
            }
        }

        console.error(output);
        writeToFile('error.log', output);
    },

    request(info: {
        method: string;
        url: string;
        status: number;
        time: number;
        ip?: string;
        contentLength?: string;
        userId?: string | number | null;
        userAgent?: string;
        requestId?: string;
        requestHeaders?: Record<string, unknown>;
        requestBody?: unknown;
        responseHeaders?: Record<string, unknown>;
        responseBody?: unknown;
    }): void {
        if (_silent) return;

        const { method, status, time } = info;
        const url = redactUrl(info.url);
        const requestId = info.requestId ?? _context.getStore()?.requestId;
        let output: string;

        if (_format === 'json') {
            const record: Record<string, unknown> = {
                time: timestamp(), level: 'info', msg: 'request', requestId,
                method, url, status, durationMs: Math.round(time),
            };
            if (_level !== 'essential') {
                Object.assign(record, { ip: info.ip, userId: info.userId ?? undefined, userAgent: info.userAgent });
            }
            if (_level === 'finest') {
                Object.assign(record, {
                    requestHeaders: info.requestHeaders && redactHeaders(info.requestHeaders),
                    requestBody: redactBody(info.requestBody),
                    responseHeaders: info.responseHeaders && redactHeaders(info.responseHeaders),
                    responseBody: redactBody(info.responseBody),
                });
            }
            output = safeStringify(record);
        } else {
            const timeStr = `${time.toFixed(0)}ms`;
            const id = requestId ? ` [req:${requestId}]` : '';
            switch (_level) {
                case 'essential':
                    output = `[${timestamp()}] ${method} ${url} ${status} ${timeStr}${id}`;
                    break;
                case 'fine':
                    output = `[${timestamp()}] ${method} ${url} ${status} ${timeStr} | ${info.ip || '-'}${info.userId ? ` | user:${info.userId}` : ''}${id}`;
                    break;
                case 'finest': {
                    const lines = [`[${timestamp()}] ${method} ${url} ${status} ${timeStr} | ${info.ip || '-'}${info.userId ? ` | user:${info.userId}` : ''}${id}`];
                    if (info.requestHeaders) {
                        lines.push('  ── Request Headers');
                        lines.push(formatHeaders(redactHeaders(info.requestHeaders)));
                    }
                    if (info.requestBody !== undefined && info.requestBody !== null) {
                        lines.push('  ── Request Body');
                        lines.push(formatBody(redactBody(info.requestBody)));
                    }
                    if (info.responseHeaders) {
                        lines.push('  ── Response Headers');
                        lines.push(formatHeaders(redactHeaders(info.responseHeaders)));
                    }
                    if (info.responseBody !== undefined && info.responseBody !== null) {
                        lines.push('  ── Response Body');
                        lines.push(formatBody(redactBody(info.responseBody)));
                    }
                    output = lines.join('\n');
                    break;
                }
            }
        }

        console.log(output);
        writeToFile('access.log', output);
    },
};

export default Logger;
