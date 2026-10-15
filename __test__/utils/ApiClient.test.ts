/**
 * Tests for the ApiClient utility.
 * Mocks global fetch to test request building, retries, auth, and error handling.
 */
import { ApiClient, ApiClientError } from '../../src/utils/ApiClient';

// Mock global fetch. Tests describe responses with json(); a real Response always has
// text() too (ApiClient reads text so empty/malformed bodies can't break error handling).
const mockFetch = jest.fn();
global.fetch = (async (...args: unknown[]) => {
    const response = await mockFetch(...args);
    if (response && typeof response.text !== 'function' && typeof response.json === 'function') {
        response.text = async () => JSON.stringify(await response.json());
    }
    return response;
}) as typeof fetch;

describe('ApiClient', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        ApiClient.clearTokenCache();
    });

    // ── fetch() ──────────────────────────────────────────────

    describe('fetch()', () => {
        it('should make a GET request and return JSON', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({ id: 1, name: 'Test' }),
            });

            const data = await ApiClient.fetch('https://api.example.com/users/1');
            expect(data).toEqual({ id: 1, name: 'Test' });
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should make a POST request with body', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 201,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({ id: 2 }),
            });

            const data = await ApiClient.fetch('https://api.example.com/users', {
                method: 'POST',
                body: { name: 'New User' },
            });
            expect(data).toEqual({ id: 2 });

            const fetchCall = mockFetch.mock.calls[0];
            expect(fetchCall[1].method).toBe('POST');
            expect(JSON.parse(fetchCall[1].body)).toEqual({ name: 'New User' });
        });

        it('should not include body for GET requests', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.fetch('https://api.example.com/test', {
                method: 'GET',
                body: { ignored: true },
            });

            expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
        });

        it('should pass string body as-is', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.fetch('https://api.example.com/test', {
                method: 'POST',
                body: 'raw string',
            });

            expect(mockFetch.mock.calls[0][1].body).toBe('raw string');
        });

        it('should handle text response', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/plain' }),
                text: () => Promise.resolve('hello'),
            });

            const data = await ApiClient.fetch('https://api.example.com/text');
            expect(data).toBe('hello');
        });

        it('should handle binary response', async () => {
            const buffer = new ArrayBuffer(8);
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/octet-stream' }),
                arrayBuffer: () => Promise.resolve(buffer),
            });

            const data = await ApiClient.fetch('https://api.example.com/binary');
            expect(data).toBe(buffer);
        });

        it('should throw ApiClientError for non-ok response', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 404,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({ error: 'not found' }),
            });

            await expect(ApiClient.fetch('https://api.example.com/missing'))
                .rejects.toThrow(ApiClientError);

            try {
                await ApiClient.fetch('https://api.example.com/missing');
            } catch (err) {
                expect((err as ApiClientError).status).toBe(404);
                expect((err as ApiClientError).url).toBe('https://api.example.com/missing');
            }
        });

        it('should not retry on 4xx errors', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 400,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({ error: 'bad request' }),
            });

            await expect(ApiClient.fetch('https://api.example.com/bad'))
                .rejects.toThrow(ApiClientError);
            expect(mockFetch).toHaveBeenCalledTimes(1); // no retries
        });

        it('should retry on server errors', async () => {
            let attempts = 0;
            mockFetch.mockImplementation(async () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error('network error');
                }
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: () => Promise.resolve({ recovered: true }),
                };
            });

            const data = await ApiClient.fetch('https://api.example.com/flaky', { retries: 3 });
            expect(data).toEqual({ recovered: true });
            expect(attempts).toBe(3);
        }, 30000);

        it('should throw after max retries', async () => {
            mockFetch.mockRejectedValue(new Error('persistent failure'));

            await expect(
                ApiClient.fetch('https://api.example.com/down', { retries: 1 })
            ).rejects.toThrow('persistent failure');
            expect(mockFetch).toHaveBeenCalledTimes(2); // initial + 1 retry
        }, 30000);

        it('should set Content-Type and Accept headers', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.fetch('https://api.example.com/test');
            const headers = mockFetch.mock.calls[0][1].headers;
            expect(headers['Content-Type']).toBe('application/json');
            expect(headers['Accept']).toBe('application/json');
        });

        it('should allow custom headers', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.fetch('https://api.example.com/test', {
                headers: { 'X-Custom': 'value' },
            });
            const headers = mockFetch.mock.calls[0][1].headers;
            expect(headers['X-Custom']).toBe('value');
        });
    });

    // ── Fluent Builder ───────────────────────────────────────

    describe('to() - fluent builder', () => {
        it('should create a request builder', () => {
            const builder = ApiClient.to('https://api.example.com');
            expect(builder).toBeDefined();
            expect(typeof builder.get).toBe('function');
            expect(typeof builder.post).toBe('function');
            expect(typeof builder.put).toBe('function');
            expect(typeof builder.patch).toBe('function');
            expect(typeof builder.delete).toBe('function');
        });

        it('should make GET request', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve([{ id: 1 }]),
            });

            const data = await ApiClient.to('https://api.example.com').get('/users');
            expect(data).toEqual([{ id: 1 }]);
            expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/users');
        });

        it('should make POST request with body', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 201,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({ id: 1 }),
            });

            await ApiClient.to('https://api.example.com').post('/users', { name: 'Test' });
            expect(mockFetch.mock.calls[0][1].method).toBe('POST');
        });

        it('should set bearer auth header', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com')
                .bearer('my-token')
                .get('/protected');

            const headers = mockFetch.mock.calls[0][1].headers;
            expect(headers['Authorization']).toBe('Bearer my-token');
        });

        it('should set basic auth header', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com')
                .basic('user', 'pass')
                .get('/protected');

            const headers = mockFetch.mock.calls[0][1].headers;
            const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
            expect(headers['Authorization']).toBe(expected);
        });

        it('should set API key header', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com')
                .apiKey('my-key')
                .get('/data');

            const headers = mockFetch.mock.calls[0][1].headers;
            expect(headers['X-API-Key']).toBe('my-key');
        });

        it('should set custom API key header name', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com')
                .apiKey('my-key', 'X-Custom-Key')
                .get('/data');

            const headers = mockFetch.mock.calls[0][1].headers;
            expect(headers['X-Custom-Key']).toBe('my-key');
        });

        it('should append query parameters', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com')
                .get('/search', { q: 'test', limit: 10 });

            const url = mockFetch.mock.calls[0][0];
            expect(url).toContain('q=test');
            expect(url).toContain('limit=10');
        });

        it('should chain multiple headers', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com')
                .header('X-One', '1')
                .header('X-Two', '2')
                .get('/multi');

            const headers = mockFetch.mock.calls[0][1].headers;
            expect(headers['X-One']).toBe('1');
            expect(headers['X-Two']).toBe('2');
        });

        it('should support PUT method', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com').put('/users/1', { name: 'Updated' });
            expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
        });

        it('should support PATCH method', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com').patch('/users/1', { name: 'Patched' });
            expect(mockFetch.mock.calls[0][1].method).toBe('PATCH');
        });

        it('should support DELETE method', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com').delete('/users/1');
            expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
        });

        it('should strip trailing slash from base URL', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () => Promise.resolve({}),
            });

            await ApiClient.to('https://api.example.com/').get('/users');
            expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/users');
        });
    });

    // ── Token Cache ──────────────────────────────────────────

    describe('clearTokenCache()', () => {
        it('should clear all cached tokens', () => {
            ApiClient.clearTokenCache();
            // No error
        });

        it('should clear specific service token', () => {
            ApiClient.clearTokenCache('testService');
            // No error
        });
    });

    // ── ApiClientError ───────────────────────────────────────

    describe('ApiClientError', () => {
        it('should be an Error', () => {
            const err = new ApiClientError('test', 500, null, 'https://example.com');
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe('ApiClientError');
        });

        it('should include status, response, and url', () => {
            const err = new ApiClientError('HTTP 404', 404, { error: 'not found' }, 'https://api.com/resource');
            expect(err.status).toBe(404);
            expect(err.response).toEqual({ error: 'not found' });
            expect(err.url).toBe('https://api.com/resource');
            expect(err.message).toBe('HTTP 404');
        });
    });

    // ── Robustness ───────────────────────────────────────────

    describe('robustness', () => {
        const respond = (status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => ({
            ok: status < 400, status, headers: new Headers(headers), text: () => Promise.resolve(body),
        });

        it('retries every method by default — POST and PATCH too; code can ask for another count', async () => {
            mockFetch.mockRejectedValue(new Error('network down'));
            await expect(ApiClient.fetch('https://api.example.com/invoices', { method: 'POST', body: {} })).rejects.toThrow('network down');
            expect(mockFetch).toHaveBeenCalledTimes(3); // API_MAX_RETRIES (2) + the first try

            mockFetch.mockClear();
            await expect(ApiClient.to('https://api.example.com').retries(1).patch('/invoices/1', {})).rejects.toThrow('network down');
            expect(mockFetch).toHaveBeenCalledTimes(2);
        }, 30000);

        it('config/app.json turns retries off for a service; an endpoint can decide for itself', async () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const config = jest.spyOn(require('../../src/core/config'), 'getAppConfig').mockReturnValue({ services: {
                Billing: { hostname: 'billing.example.com', retry: false, endpoints: {
                    create: { path: '/invoices', method: 'POST' },
                    status: { path: '/status', retry: true },
                } },
            } } as any);
            try {
                mockFetch.mockRejectedValue(new Error('network down'));
                await expect(ApiClient.call('Billing', 'create', { body: {} })).rejects.toThrow('network down');
                expect(mockFetch).toHaveBeenCalledTimes(1);

                mockFetch.mockClear();
                await expect(ApiClient.call('Billing', 'create', { body: {}, retries: 1 })).rejects.toThrow('network down');
                expect(mockFetch).toHaveBeenCalledTimes(2); // code wins over the config

                mockFetch.mockClear();
                await expect(ApiClient.call('Billing', 'status')).rejects.toThrow('network down');
                expect(mockFetch).toHaveBeenCalledTimes(3);
            } finally {
                config.mockRestore();
            }
        }, 30000);

        it('returns null for 204 and empty JSON bodies', async () => {
            mockFetch.mockResolvedValueOnce(respond(204, ''));
            expect(await ApiClient.fetch('https://api.example.com/x', { method: 'DELETE' })).toBeNull();
            mockFetch.mockResolvedValueOnce(respond(200, ''));
            expect(await ApiClient.fetch('https://api.example.com/x')).toBeNull();
        });

        it('keeps a 4xx with an empty or malformed body an ApiClientError, without retrying', async () => {
            mockFetch.mockResolvedValue(respond(422, '{not json'));
            const err = await ApiClient.fetch('https://api.example.com/x').catch((e: ApiClientError) => e) as ApiClientError;
            expect(err).toBeInstanceOf(ApiClientError);
            expect(err.status).toBe(422);
            expect(err.response).toBe('{not json');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('retries 429 after Retry-After', async () => {
            mockFetch
                .mockResolvedValueOnce(respond(429, '', { 'content-type': 'application/json', 'retry-after': '0' }))
                .mockResolvedValueOnce(respond(200, '{"ok":true}'));
            expect(await ApiClient.fetch('https://api.example.com/x', { retries: 1 })).toEqual({ ok: true });
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('stops immediately when the caller aborts', async () => {
            const controller = new AbortController();
            mockFetch.mockImplementation(async () => {
                controller.abort();
                throw new DOMException('aborted', 'AbortError');
            });
            await expect(ApiClient.fetch('https://api.example.com/x', { signal: controller.signal, retries: 3 })).rejects.toThrow();
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('applies its timeout even with a caller-provided signal', async () => {
            mockFetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
                init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
            }));
            const controller = new AbortController();
            await expect(ApiClient.fetch('https://api.example.com/slow', { signal: controller.signal, timeout: 50, retries: 0 }))
                .rejects.toBeDefined();
        });
    });
});
