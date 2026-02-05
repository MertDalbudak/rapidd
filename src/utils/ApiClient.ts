import path from 'path';

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
}

export interface EndpointConfig {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    queries?: Record<string, string>;
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

    constructor(message: string, status: number, response: unknown, url: string) {
        super(message);
        this.name = 'ApiClientError';
        this.status = status;
        this.response = response;
        this.url = url;
    }
}

// ── Configuration ────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '10000', 10);
const MAX_RETRIES = parseInt(process.env.API_MAX_RETRIES || '2', 10);

let _config: { services?: Record<string, ServiceConfig> } = { services: {} };
let _configLoaded = false;
const _tokenCache = new Map<string, { access_token: string; token_type: string; expires: number }>();

function getConfig(): { services?: Record<string, ServiceConfig> } {
    if (!_configLoaded) {
        try {
            _config = require(path.join(process.cwd(), 'config', 'app.json'));
        } catch {
            _config = { services: {} };
        }
        _configLoaded = true;
    }
    return _config;
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
        body
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
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
        return response.json();
    }
    if (contentType.includes('text/')) {
        return response.text();
    }
    return response.arrayBuffer();
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
        const service = getService(serviceName);
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
            await applyAuth(headers, serviceName, service.authorization);
        }

        return this.fetch<T>(url, {
            method: endpoint.method || 'GET',
            headers,
            body: options.body,
            timeout: options.timeout,
            signal: options.signal
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
        const { method = 'GET', headers = {}, body, timeout = REQUEST_TIMEOUT, retries = MAX_RETRIES } = options;

        const fetchOptions: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...headers
            },
            signal: options.signal
        };

        if (body !== undefined && !['GET', 'HEAD'].includes(method)) {
            fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            if (!options.signal) {
                fetchOptions.signal = controller.signal;
            }

            try {
                const response = await fetch(url, fetchOptions);
                clearTimeout(timeoutId);

                const data = await parseResponse(response);

                if (!response.ok) {
                    throw new ApiClientError(
                        `HTTP ${response.status}`,
                        response.status,
                        data,
                        url
                    );
                }

                return data as T;
            } catch (error) {
                clearTimeout(timeoutId);
                lastError = error as Error;

                // Don't retry client errors (4xx)
                if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
                    throw error;
                }

                // Retry with exponential backoff
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 5000)));
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
    private _retries: number = MAX_RETRIES;

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
