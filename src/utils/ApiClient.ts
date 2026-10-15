import { getAppConfig } from '../core/config';
import { Logger } from './Logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ServiceConfig {
    hostname: string;
    path?: string;
    port?: number;
    secure?: boolean;
    headers?: Record<string, string>;
    queries?: Record<string, string>;
    authorization?: AuthConfig;
    endpoints?: Record<string, EndpointConfig>;
    /** Retry failed requests (API_MAX_RETRIES times). Default true — false turns it off */
    retry?: boolean;
}

export interface EndpointConfig {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    queries?: Record<string, string>;
    /** Overrides the service's `retry` for this endpoint */
    retry?: boolean;
}

export interface AuthConfig {
    type: 'basic' | 'bearer' | 'api-key' | 'oauth2';
    'auth-header'?: string;
    // Basic
    username?: string;
    password?: string;
    // Bearer / X-Auth
    token?: string;
    // API Key
    key?: string;
    'key-header'?: string;
    // OAuth2
    hostname?: string;
    token_path?: string;
    client_id?: string;
    client_secret?: string;
    grant_type?: string;
    scope?: string;
    secure?: boolean;
    params?: Record<string, string>;
}

export interface RequestOptions {
    params?: Record<string, string>;
    queries?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    signal?: AbortSignal;
    /** Retry attempts. Default: API_MAX_RETRIES — 0 with `retry: false` on the service or endpoint */
    retries?: number;
}

export interface ApiResponse<T = unknown> {
    ok: boolean;
    status: number;
    data: T;
    headers: Headers;
}

export class ApiClientError extends Error {
    status: number;
    response: unknown;
    url: string;
    /** Server-requested delay before retrying (Retry-After), in ms */
    retryAfterMs?: number;

    constructor(message: string, status: number, response: unknown, url: string, retryAfterMs?: number) {
        super(message);
        this.name = 'ApiClientError';
        this.status = status;
        this.response = response;
        this.url = url;
        this.retryAfterMs = retryAfterMs;
    }
}

// ── Configuration ────────────────────────────────────────────────────────────

/** A whole number from the environment — the default when unset or not one (with a warning) */
function envCount(name: string, fallback: number, min: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min) return value;
    Logger.warn(`ApiClient: ${name}=${raw} is not a whole number ≥ ${min} — using ${fallback}`);
    return fallback;
}

const REQUEST_TIMEOUT = envCount('REQUEST_TIMEOUT', 10000, 1);
const MAX_RETRIES = envCount('API_MAX_RETRIES', 2, 0);
const MAX_BACKOFF_MS = 5000;

const _tokenCache = new Map<string, { access_token: string; token_type: string; expires: number }>();
const _tokenRequests = new Map<string, Promise<{ access_token: string; token_type: string; expires: number }>>();

/** Services from config/app.json — `${ENV_VAR}` references are resolved from the environment */
function getConfig(): { services?: Record<string, ServiceConfig> } {
    return getAppConfig();
}

/** Retry-After (delta seconds or HTTP date) → ms, capped */
function retryAfterMs(response: Response): number | undefined {
    const value = response.headers.get('retry-after');
    if (!value) return undefined;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_BACKOFF_MS) : undefined;
}

function getService(name: string): ServiceConfig {
    const config = getConfig();
    const service = config.services?.[name];
    if (!service) {
        const available = Object.keys(config.services || {}).join(', ') || 'none';
        throw new Error(`Service '${name}' not found. Available: ${available}`);
    }
    return service;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePath(template: string, params: Record<string, string> = {}): string {
    return template.replace(/\{\{(.+?)\}\}/g, (_, key) => {
        const trimmed = key.trim();
        if (!(trimmed in params)) {
            throw new Error(`Missing path parameter: ${trimmed}`);
        }
        return encodeURIComponent(params[trimmed]);
    });
}

function buildUrl(
    service: ServiceConfig,
    endpointPath: string,
    queries: Record<string, unknown> = {}
): string {
    const protocol = service.secure !== false ? 'https' : 'http';
    const port = service.port ? `:${service.port}` : '';
    const basePath = service.path || '';

    const url = new URL(`${protocol}://${service.hostname}${port}${basePath}${endpointPath}`);

    const allQueries = { ...(service.queries || {}), ...queries };
    for (const [key, value] of Object.entries(allQueries)) {
        if (value !== undefined && value !== null) {
            if (Array.isArray(value)) {
                value.forEach((v, i) => url.searchParams.append(`${key}[${i}]`, String(v)));
            } else if (typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    url.searchParams.append(`${key}[${k}]`, String(v));
                }
            } else {
                url.searchParams.append(key, String(value));
            }
        }
    }

    return url.toString();
}

async function getOAuthToken(serviceName: string, auth: AuthConfig): Promise<{ access_token: string; token_type: string }> {
    const cached = _tokenCache.get(serviceName);
    if (cached && cached.expires > Date.now() + 60000) {
        return cached;
    }
    // Single-flight: concurrent calls share one token request
    const pending = _tokenRequests.get(serviceName);
    if (pending) return pending;
    const request = requestOAuthToken(serviceName, auth).finally(() => _tokenRequests.delete(serviceName));
    _tokenRequests.set(serviceName, request);
    return request;
}

async function requestOAuthToken(serviceName: string, auth: AuthConfig): Promise<{ access_token: string; token_type: string; expires: number }> {

    const tokenUrl = `${auth.secure !== false ? 'https' : 'http'}://${auth.hostname}${auth.token_path}`;

    const body = new URLSearchParams({
        grant_type: auth.grant_type || 'client_credentials',
        client_id: auth.client_id!,
        client_secret: auth.client_secret!,
        ...(auth.scope && { scope: auth.scope }),
        ...(auth.params || {})
    });

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OAuth2 token request failed (${response.status}): ${text}`);
    }

    const tokenData = await response.json() as { access_token: string; token_type?: string; expires_in?: number };

    if (!tokenData.access_token) {
        throw new Error('Invalid OAuth2 response: missing access_token');
    }

    const expiresIn = tokenData.expires_in || 3600;
    const token = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type || 'Bearer',
        expires: Date.now() + (expiresIn * 900) // 90% of actual expiry
    };

    _tokenCache.set(serviceName, token);
    return token;
}

async function applyAuth(
    headers: Record<string, string>,
    serviceName: string,
    auth: AuthConfig
): Promise<void> {
    const authHeader = auth['auth-header'] || 'Authorization';

    switch (auth.type) {
        case 'basic': {
            if (!auth.username || !auth.password) {
                throw new Error('Basic auth requires username and password');
            }
            const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
            headers[authHeader] = `Basic ${credentials}`;
            break;
        }
        case 'bearer': {
            if (!auth.token) throw new Error('Bearer auth requires token');
            headers[authHeader] = `Bearer ${auth.token}`;
            break;
        }
        case 'api-key': {
            if (!auth.key) throw new Error('API key auth requires key');
            headers[auth['key-header'] || 'X-API-Key'] = auth.key;
            break;
        }
        case 'oauth2': {
            const token = await getOAuthToken(serviceName, auth);
            headers[authHeader] = `${token.token_type} ${token.access_token}`;
            break;
        }
    }
}

async function parseResponse(response: Response): Promise<unknown> {
    if (response.status === 204 || response.status === 205 || response.status === 304) return null;
    const contentType = response.headers.get('content-type') || '';

    // application/json, application/problem+json, application/vnd.api+json, ...
    if (contentType.includes('json')) {
        // Empty or malformed bodies must not turn an HTTP error into a SyntaxError
        const text = await response.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    if (contentType.includes('text/') || contentType.includes('xml')) {
        return response.text();
    }
    return response.arrayBuffer();
}

/** A service endpoint call, ready to send: URL, method and headers (authorization applied) */
export interface PreparedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** 0 when config/app.json turns retries off for the endpoint or its service */
    retries?: number;
}

/**
 * Build the request for an endpoint of a service — the configuration is passed in, so a
 * service that is not (yet) in config/app.json can be called too (the setup wizard tests
 * services before they are saved). `tokenCacheKey` keys the OAuth2 token cache (the service's
 * name unless given).
 */
export async function prepareServiceRequest(
    serviceName: string,
    service: ServiceConfig,
    endpointName: string,
    options: RequestOptions = {},
    tokenCacheKey: string = serviceName
): Promise<PreparedRequest> {
    const endpoint = service.endpoints?.[endpointName];
    if (!endpoint) {
        const available = Object.keys(service.endpoints || {}).join(', ') || 'none';
        throw new Error(`Endpoint '${endpointName}' not found in '${serviceName}'. Available: ${available}`);
    }

    const resolvedPath = resolvePath(endpoint.path, options.params);
    const url = buildUrl(service, resolvedPath, {
        ...(endpoint.queries || {}),
        ...(options.queries || {})
    });

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(service.headers || {}),
        ...(endpoint.headers || {}),
        ...(options.headers || {})
    };

    if (service.authorization) {
        await applyAuth(headers, tokenCacheKey, service.authorization);
    }
    // config/app.json decides whether failed calls are retried: the endpoint, else its service
    const retry = endpoint.retry ?? service.retry ?? true;
    return { url, method: (endpoint.method || 'GET').toUpperCase(), headers, retries: retry ? undefined : 0 };
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Lightweight, config-driven API client.
 *
 * @example
 * // Using predefined service/endpoint from config/app.json
 * const user = await ApiClient.call('GoogleAPI', 'getUserInfo', {
 *     headers: { Authorization: `Bearer ${token}` }
 * });
 *
 * @example
 * // Ad-hoc request
 * const data = await ApiClient.fetch('https://api.example.com/users', {
 *     method: 'POST',
 *     body: { name: 'John' }
 * });
 *
 * @example
 * // Fluent builder
 * const response = await ApiClient.to('https://api.example.com')
 *     .bearer(token)
 *     .post('/users', { name: 'John' });
 */
export const ApiClient = {
    /**
     * Call a predefined service endpoint from config/app.json
     */
    async call<T = unknown>(
        serviceName: string,
        endpointName: string,
        options: RequestOptions = {}
    ): Promise<T> {
        const { url, method, headers, retries } = await prepareServiceRequest(serviceName, getService(serviceName), endpointName, options);
        return this.fetch<T>(url, {
            method,
            headers,
            body: options.body,
            timeout: options.timeout,
            signal: options.signal,
            retries: options.retries ?? retries
        });
    },

    /**
     * Make an ad-hoc fetch request with retries and error handling
     */
    async fetch<T = unknown>(
        url: string,
        options: {
            method?: string;
            headers?: Record<string, string>;
            body?: unknown;
            timeout?: number;
            signal?: AbortSignal;
            retries?: number;
        } = {}
    ): Promise<T> {
        const { method = 'GET', headers = {}, body, timeout = REQUEST_TIMEOUT } = options;
        const upperMethod = method.toUpperCase();
        // A count from code: whole and not negative (none — not one request less)
        const retries = Number.isFinite(options.retries) ? Math.max(0, Math.floor(options.retries!)) : MAX_RETRIES;

        const fetchOptions: RequestInit = {
            method: upperMethod,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...headers
            }
        };

        if (body !== undefined && !['GET', 'HEAD'].includes(upperMethod)) {
            fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            // The per-attempt timeout applies even when the caller passes its own signal
            const timeoutSignal = AbortSignal.timeout(timeout);
            fetchOptions.signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

            try {
                const response = await fetch(url, fetchOptions);
                const data = await parseResponse(response);

                if (!response.ok) {
                    throw new ApiClientError(
                        `HTTP ${response.status}`,
                        response.status,
                        data,
                        url,
                        retryAfterMs(response)
                    );
                }

                return data as T;
            } catch (error) {
                lastError = error as Error;

                // Cancelled by the caller: stop immediately
                if (options.signal?.aborted) throw error;

                // Client errors are final — except 429, which asks us to come back later
                if (error instanceof ApiClientError && error.status >= 400 && error.status < 500 && error.status !== 429) {
                    throw error;
                }

                // Retry with exponential backoff + jitter (or the server's Retry-After)
                if (attempt < retries) {
                    const backoff = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS) * (0.5 + Math.random() / 2);
                    const delay = error instanceof ApiClientError && error.retryAfterMs !== undefined ? error.retryAfterMs : backoff;
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        throw lastError;
    },

    /**
     * Create a fluent request builder for ad-hoc requests
     */
    to(baseUrl: string) {
        return new RequestBuilder(baseUrl);
    },

    /**
     * Clear OAuth token cache (useful for testing or token revocation)
     */
    clearTokenCache(serviceName?: string): void {
        if (serviceName) {
            _tokenCache.delete(serviceName);
        } else {
            _tokenCache.clear();
        }
    },

    /**
     * List available services from config
     */
    listServices(): string[] {
        return Object.keys(getConfig().services || {});
    },

    /**
     * List endpoints for a service
     */
    listEndpoints(serviceName: string): string[] {
        const service = getService(serviceName);
        return Object.keys(service.endpoints || {});
    }
};

// ── Fluent Builder ───────────────────────────────────────────────────────────

class RequestBuilder {
    private _baseUrl: string;
    private _headers: Record<string, string> = {};
    private _timeout: number = REQUEST_TIMEOUT;
    /** Unset: API_MAX_RETRIES */
    private _retries: number | undefined;

    constructor(baseUrl: string) {
        this._baseUrl = baseUrl.replace(/\/$/, '');
    }

    header(key: string, value: string): this {
        this._headers[key] = value;
        return this;
    }

    headers(headers: Record<string, string>): this {
        Object.assign(this._headers, headers);
        return this;
    }

    bearer(token: string): this {
        this._headers['Authorization'] = `Bearer ${token}`;
        return this;
    }

    basic(username: string, password: string): this {
        const credentials = Buffer.from(`${username}:${password}`).toString('base64');
        this._headers['Authorization'] = `Basic ${credentials}`;
        return this;
    }

    apiKey(key: string, header = 'X-API-Key'): this {
        this._headers[header] = key;
        return this;
    }

    timeout(ms: number): this {
        this._timeout = ms;
        return this;
    }

    retries(count: number): this {
        this._retries = count;
        return this;
    }

    private _url(path: string, queries?: Record<string, unknown>): string {
        const url = new URL(path.startsWith('/') ? `${this._baseUrl}${path}` : path);
        if (queries) {
            for (const [key, value] of Object.entries(queries)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.append(key, String(value));
                }
            }
        }
        return url.toString();
    }

    async get<T = unknown>(path: string, queries?: Record<string, unknown>): Promise<T> {
        return ApiClient.fetch<T>(this._url(path, queries), {
            method: 'GET',
            headers: this._headers,
            timeout: this._timeout,
            retries: this._retries
        });
    }

    async post<T = unknown>(path: string, body?: unknown): Promise<T> {
        return ApiClient.fetch<T>(this._url(path), {
            method: 'POST',
            headers: this._headers,
            body,
            timeout: this._timeout,
            retries: this._retries
        });
    }

    async put<T = unknown>(path: string, body?: unknown): Promise<T> {
        return ApiClient.fetch<T>(this._url(path), {
            method: 'PUT',
            headers: this._headers,
            body,
            timeout: this._timeout,
            retries: this._retries
        });
    }

    async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
        return ApiClient.fetch<T>(this._url(path), {
            method: 'PATCH',
            headers: this._headers,
            body,
            timeout: this._timeout,
            retries: this._retries
        });
    }

    async delete<T = unknown>(path: string): Promise<T> {
        return ApiClient.fetch<T>(this._url(path), {
            method: 'DELETE',
            headers: this._headers,
            timeout: this._timeout,
            retries: this._retries
        });
    }
}

export default ApiClient;
