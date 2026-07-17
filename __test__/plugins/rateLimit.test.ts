/**
 * Tests for the rate limiter (memory-based, no Redis).
 *
 * Path configs are injected rather than read from config/rate-limit.json, so these
 * tests describe intended behaviour instead of whatever the shipped file happens to
 * contain — the gap that previously let a dead config pass a green suite.
 */
import { RateLimiter } from '../../src/plugins/rateLimit';

describe('RateLimiter (memory-based)', () => {
    let limiter: RateLimiter;

    beforeEach(() => {
        // Ensure no Redis env is set
        delete process.env.REDIS_HOST;
        limiter = new RateLimiter({ rateLimits: {} });
    });

    afterEach(async () => {
        await limiter.close();
    });

    function makeRequest(ip: string = '127.0.0.1', url: string = '/api/test') {
        return { ip, url, headers: {} } as any;
    }

    function makeReply(statusCode: number = 200) {
        const headers: Record<string, any> = {};
        return {
            statusCode,
            header: jest.fn((key: string, value: any) => { headers[key] = value; }),
            _headers: headers,
        } as any;
    }

    it('should allow requests under the limit', async () => {
        const req = makeRequest();
        const reply = makeReply();
        await expect(limiter.checkLimit(req, reply)).resolves.toBeUndefined();
        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
    });

    it('should track request count', async () => {
        const req = makeRequest();
        for (let i = 0; i < 5; i++) {
            await limiter.checkLimit(req, makeReply());
        }
        const reply = makeReply();
        await limiter.checkLimit(req, reply);
        expect(reply._headers['X-RateLimit-Remaining']).toBeLessThan(100);
    });

    it('should throw 429 when limit exceeded', async () => {
        const testLimiter = new RateLimiter({ maxRequests: 3, windowMs: 60000, rateLimits: {} });
        const req = makeRequest('10.0.0.1', '/api/limited');

        for (let i = 0; i < 3; i++) {
            await testLimiter.checkLimit(req, makeReply());
        }
        await expect(testLimiter.checkLimit(req, makeReply())).rejects.toMatchObject({ status_code: 429 });

        await testLimiter.close();
    });

    it('should track different IPs separately', async () => {
        const testLimiter = new RateLimiter({ maxRequests: 2, rateLimits: {} });
        const req1 = makeRequest('1.1.1.1');
        const req2 = makeRequest('2.2.2.2');

        await testLimiter.checkLimit(req1, makeReply());
        await testLimiter.checkLimit(req1, makeReply());
        await expect(testLimiter.checkLimit(req1, makeReply())).rejects.toMatchObject({ status_code: 429 });

        await expect(testLimiter.checkLimit(req2, makeReply())).resolves.toBeUndefined();
        await testLimiter.close();
    });

    it('should track different configured scopes separately', async () => {
        const testLimiter = new RateLimiter({
            maxRequests: 100,
            rateLimits: {
                '/auth': { maxRequests: 2, windowMs: 60000 },
                '/api': { maxRequests: 2, windowMs: 60000 },
            },
        });
        const auth = makeRequest('1.1.1.1', '/auth/login');
        const api = makeRequest('1.1.1.1', '/api/v1/users');

        await testLimiter.checkLimit(auth, makeReply());
        await testLimiter.checkLimit(auth, makeReply());
        await expect(testLimiter.checkLimit(auth, makeReply())).rejects.toMatchObject({ status_code: 429 });

        // A different scope has its own budget.
        await expect(testLimiter.checkLimit(api, makeReply())).resolves.toBeUndefined();
        await testLimiter.close();
    });

    it('should strip query params from path for rate limiting', async () => {
        const testLimiter = new RateLimiter({ maxRequests: 2, rateLimits: {} });
        const req1 = makeRequest('1.1.1.1', '/api/test?foo=bar');
        const req2 = makeRequest('1.1.1.1', '/api/test?baz=qux');

        await testLimiter.checkLimit(req1, makeReply());
        await testLimiter.checkLimit(req2, makeReply());
        await expect(testLimiter.checkLimit(req1, makeReply())).rejects.toMatchObject({ status_code: 429 });

        await testLimiter.close();
    });

    it('should set correct rate limit headers', async () => {
        const testLimiter = new RateLimiter({ maxRequests: 10, rateLimits: {} });
        const reply = makeReply();
        await testLimiter.checkLimit(makeRequest(), reply);

        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', 10);
        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', 9);
        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));

        await testLimiter.close();
    });

    it('should close without error', async () => {
        await expect(limiter.close()).resolves.toBeUndefined();
    });

    // ── Path config matching ─────────────────────────────────
    describe('path config matching', () => {
        it('applies a config entry to paths beneath it (prefix match)', async () => {
            const l = new RateLimiter({
                maxRequests: 100,
                rateLimits: { '/api': { maxRequests: 1000, windowMs: 60000 } },
            });
            const reply = makeReply();
            await l.checkLimit(makeRequest('1.1.1.1', '/api/v1/users'), reply);

            expect(reply._headers['X-RateLimit-Limit']).toBe(1000);
            await l.close();
        });

        it('longest matching prefix wins', async () => {
            const l = new RateLimiter({
                rateLimits: {
                    '/api': { maxRequests: 1000, windowMs: 60000 },
                    '/api/v1/upload': { maxRequests: 5, windowMs: 60000 },
                },
            });

            const upload = makeReply();
            await l.checkLimit(makeRequest('1.1.1.1', '/api/v1/upload/file'), upload);
            expect(upload._headers['X-RateLimit-Limit']).toBe(5);

            const users = makeReply();
            await l.checkLimit(makeRequest('1.1.1.1', '/api/v1/users'), users);
            expect(users._headers['X-RateLimit-Limit']).toBe(1000);

            await l.close();
        });

        it('does not let a config key swallow a sibling path', async () => {
            const l = new RateLimiter({
                maxRequests: 100,
                rateLimits: { '/api': { maxRequests: 1000, windowMs: 60000 } },
            });
            const reply = makeReply();
            await l.checkLimit(makeRequest('1.1.1.1', '/apidocs'), reply);

            // /apidocs is not under /api — it must fall to the default, not inherit 1000.
            expect(reply._headers['X-RateLimit-Limit']).toBe(100);
            await l.close();
        });
    });

    // ── Aggregate bucketing ──────────────────────────────────
    describe('aggregate scope (budget cannot be multiplied across endpoints)', () => {
        it('counts every path under a config entry against one shared budget', async () => {
            const l = new RateLimiter({
                rateLimits: { '/api': { maxRequests: 3, windowMs: 60000 } },
            });
            const ip = '6.6.6.6';

            await l.checkLimit(makeRequest(ip, '/api/v1/a'), makeReply());
            await l.checkLimit(makeRequest(ip, '/api/v1/b'), makeReply());
            await l.checkLimit(makeRequest(ip, '/api/v1/c'), makeReply());

            // A fourth distinct endpoint must not get a fresh budget.
            await expect(
                l.checkLimit(makeRequest(ip, '/api/v1/d'), makeReply())
            ).rejects.toMatchObject({ status_code: 429 });

            await l.close();
        });

        it('counts unconfigured paths against one shared default budget', async () => {
            const l = new RateLimiter({ maxRequests: 2, windowMs: 60000, rateLimits: {} });
            const ip = '3.3.3.3';

            await l.checkLimit(makeRequest(ip, '/foo'), makeReply());
            await l.checkLimit(makeRequest(ip, '/bar'), makeReply());
            await expect(
                l.checkLimit(makeRequest(ip, '/baz'), makeReply())
            ).rejects.toMatchObject({ status_code: 429 });

            await l.close();
        });
    });

    // ── ignoreSuccessfulRequests ─────────────────────────────
    describe('ignoreSuccessfulRequests', () => {
        const loginConfig = {
            '/auth/login': { maxRequests: 3, windowMs: 60000, ignoreSuccessfulRequests: true },
        };

        it('does not charge successful requests', async () => {
            const l = new RateLimiter({ rateLimits: loginConfig });
            const req = makeRequest('4.4.4.4', '/auth/login');

            // Far more successful logins than the limit of 3 — none should be charged.
            for (let i = 0; i < 10; i++) {
                const reply = makeReply(200);
                await expect(l.checkLimit(req, reply)).resolves.toBeUndefined();
                await l.refundIfSuccessful(req, reply);
            }

            const reply = makeReply(200);
            await expect(l.checkLimit(req, reply)).resolves.toBeUndefined();
            expect(reply._headers['X-RateLimit-Remaining']).toBe(2);

            await l.close();
        });

        it('still charges failed requests (brute force is limited)', async () => {
            const l = new RateLimiter({ rateLimits: loginConfig });
            const req = makeRequest('5.4.3.2', '/auth/login');

            for (let i = 0; i < 3; i++) {
                const reply = makeReply(401);
                await l.checkLimit(req, reply);
                await l.refundIfSuccessful(req, reply); // 401 => no refund
            }

            await expect(l.checkLimit(req, makeReply(401))).rejects.toMatchObject({ status_code: 429 });
            await l.close();
        });

        it('mixed traffic: only the failures accumulate', async () => {
            const l = new RateLimiter({ rateLimits: loginConfig });
            const req = makeRequest('6.5.4.3', '/auth/login');

            // 2 failures + many successes: the successes must not push it over.
            for (const status of [401, 200, 200, 200, 401, 200, 200]) {
                const reply = makeReply(status);
                await l.checkLimit(req, reply);
                await l.refundIfSuccessful(req, reply);
            }

            // 2 failures charged, limit 3 => one attempt left.
            const reply = makeReply(401);
            await expect(l.checkLimit(req, reply)).resolves.toBeUndefined();
            await l.refundIfSuccessful(req, reply);

            await expect(l.checkLimit(req, makeReply(401))).rejects.toMatchObject({ status_code: 429 });
            await l.close();
        });

        it('charges successful requests when the flag is off (default)', async () => {
            const l = new RateLimiter({
                rateLimits: { '/api/x': { maxRequests: 2, windowMs: 60000 } },
            });
            const req = makeRequest('7.7.7.7', '/api/x');

            for (let i = 0; i < 2; i++) {
                const reply = makeReply(200);
                await l.checkLimit(req, reply);
                await l.refundIfSuccessful(req, reply); // no flag => no ticket => no refund
            }

            await expect(l.checkLimit(req, makeReply(200))).rejects.toMatchObject({ status_code: 429 });
            await l.close();
        });

        it('refund is a no-op when nothing was charged', async () => {
            const l = new RateLimiter({ rateLimits: {} });
            const req = makeRequest('9.1.1.1', '/foo');
            const reply = makeReply(200);
            // No ticket was issued (flag off) — refunding must not throw or corrupt state.
            await expect(l.refundIfSuccessful(req, reply)).resolves.toBeUndefined();
            await l.close();
        });
    });

    // ── Response headers ─────────────────────────────────────
    describe('response headers', () => {
        it('X-RateLimit-Reset is epoch seconds, not milliseconds', async () => {
            const l = new RateLimiter({ maxRequests: 10, windowMs: 60000, rateLimits: {} });
            const reply = makeReply();
            await l.checkLimit(makeRequest('7.1.1.1', '/x'), reply);

            const reset = reply._headers['X-RateLimit-Reset'];
            const nowSec = Math.floor(Date.now() / 1000);
            // ~60s ahead, in seconds. Emitted in ms this would be ~1.7e12.
            expect(reset).toBeGreaterThanOrEqual(nowSec);
            expect(reset).toBeLessThanOrEqual(nowSec + 61);
            await l.close();
        });

        it('sends Retry-After only when the limit is exceeded', async () => {
            const l = new RateLimiter({ maxRequests: 1, windowMs: 60000, rateLimits: {} });
            const req = makeRequest('7.2.2.2', '/x');

            const ok = makeReply();
            await l.checkLimit(req, ok);
            expect(ok._headers['Retry-After']).toBeUndefined();

            const blocked = makeReply();
            await expect(l.checkLimit(req, blocked)).rejects.toMatchObject({ status_code: 429 });
            expect(blocked._headers['Retry-After']).toBeGreaterThan(0);
            expect(blocked._headers['Retry-After']).toBeLessThanOrEqual(60);
            await l.close();
        });

        it('Retry-After and reset survive onto a real 429 response', async () => {
            // The headers are set on the reply and then checkLimit throws — this proves they
            // actually reach the client rather than being discarded by the error path.
            const Fastify = require('fastify');
            const plugin = require('../../src/plugins/rateLimit').default;
            const prevEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';

            const app = Fastify();
            app.setErrorHandler((err: any, _req: any, reply: any) =>
                reply.code(err.status_code || 500).send({ message: err.message })
            );
            await app.register(plugin, { maxRequests: 1, windowMs: 60000, rateLimits: {} });
            app.get('/h', async () => ({ ok: true }));
            await app.ready();

            await app.inject({ method: 'GET', url: '/h', remoteAddress: '7.3.3.3' });
            const res = await app.inject({ method: 'GET', url: '/h', remoteAddress: '7.3.3.3' });

            expect(res.statusCode).toBe(429);
            expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
            expect(Number(res.headers['x-ratelimit-reset'])).toBeLessThan(1e11); // seconds, not ms
            expect(res.headers['x-ratelimit-remaining']).toBe('0');

            await app.close();
            process.env.NODE_ENV = prevEnv;
        });
    });

    // ── Regressions ──────────────────────────────────────────
    describe('regressions', () => {
        it('serves from memory while Redis is configured but not yet ready', async () => {
            // Redis pointed at an unroutable host: never becomes ready. Requests arriving
            // before the connection resolves must not blow up on a null memory store.
            process.env.REDIS_HOST = '10.255.255.1';
            const l = new RateLimiter({ maxRequests: 2, windowMs: 60000, rateLimits: {} });
            try {
                const req = makeRequest('1.9.9.9', '/x');
                await expect(l.checkLimit(req, makeReply())).resolves.toBeUndefined();
                await l.checkLimit(req, makeReply());
                // and it still enforces
                await expect(l.checkLimit(req, makeReply())).rejects.toMatchObject({ status_code: 429 });
            } finally {
                delete process.env.REDIS_HOST;
                await l.close().catch(() => undefined);
            }
        });

        it('a percent-encoded path cannot escape a strict scope', async () => {
            // Fastify decodes before routing, so /auth/log%69n reaches the /auth/login
            // handler. The limiter must bucket it identically or the login cap is bypassable.
            const l = new RateLimiter({
                maxRequests: 100,
                rateLimits: { '/auth/login': { maxRequests: 10, windowMs: 900000 } },
            });

            const encoded = makeReply();
            await l.checkLimit(makeRequest('2.9.9.9', '/auth/log%69n'), encoded);
            expect(encoded._headers['X-RateLimit-Limit']).toBe(10);

            // ...and it shares the same bucket as the plain path, not a private one.
            const plain = makeReply();
            await l.checkLimit(makeRequest('2.9.9.9', '/auth/login'), plain);
            expect(plain._headers['X-RateLimit-Remaining']).toBe(8);

            await l.close();
        });

        it('a malformed percent-encoding does not throw', async () => {
            const l = new RateLimiter({ rateLimits: {} });
            await expect(
                l.checkLimit(makeRequest('2.9.9.8', '/api/%E0%A4%A'), makeReply())
            ).resolves.toBeUndefined();
            await l.close();
        });

        it('honours options passed to register() instead of dropping them', async () => {
            const Fastify = require('fastify');
            const plugin = require('../../src/plugins/rateLimit').default;
            const prevEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';

            const app = Fastify();
            // Mirrors the framework's global error handler: ErrorResponse carries
            // `status_code`, which Fastify's default handler doesn't know to read.
            app.setErrorHandler((err: any, _req: any, reply: any) =>
                reply.code(err.status_code || 500).send({ message: err.message })
            );
            await app.register(plugin, { maxRequests: 2, windowMs: 60000, rateLimits: {} });
            app.get('/zzz', async () => ({ ok: true }));
            await app.ready();

            const codes: number[] = [];
            for (let i = 0; i < 4; i++) {
                const res = await app.inject({ method: 'GET', url: '/zzz', remoteAddress: '8.8.4.4' });
                codes.push(res.statusCode);
            }
            // maxRequests: 2 must actually apply — previously these were all 200.
            expect(codes).toEqual([200, 200, 429, 429]);

            await app.close();
            process.env.NODE_ENV = prevEnv;
        });

        it('closing one app does not disable another app\'s limiter', async () => {
            const Fastify = require('fastify');
            const plugin = require('../../src/plugins/rateLimit').default;
            const prevEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';

            const handler = (err: any, _req: any, reply: any) =>
                reply.code(err.status_code || 500).send({ message: err.message });

            const appA = Fastify();
            appA.setErrorHandler(handler);
            await appA.register(plugin, { maxRequests: 1, windowMs: 60000, rateLimits: {} });
            appA.get('/a', async () => ({ ok: true }));
            await appA.ready();

            const appB = Fastify();
            appB.setErrorHandler(handler);
            await appB.register(plugin, { maxRequests: 1, windowMs: 60000, rateLimits: {} });
            appB.get('/b', async () => ({ ok: true }));
            await appB.ready();

            await appA.close(); // must not touch appB's limiter

            expect((await appB.inject({ method: 'GET', url: '/b', remoteAddress: '8.8.1.1' })).statusCode).toBe(200);
            expect((await appB.inject({ method: 'GET', url: '/b', remoteAddress: '8.8.1.1' })).statusCode).toBe(429);

            await appB.close();
            process.env.NODE_ENV = prevEnv;
        });

        it('maxRequests: 0 blocks the path instead of falling back to the default', async () => {
            const l = new RateLimiter({
                maxRequests: 100,
                rateLimits: { '/blocked': { maxRequests: 0, windowMs: 60000 } },
            });
            await expect(
                l.checkLimit(makeRequest('3.9.9.9', '/blocked'), makeReply())
            ).rejects.toMatchObject({ status_code: 429 });

            // An unrelated path still uses the default.
            await expect(
                l.checkLimit(makeRequest('3.9.9.9', '/open'), makeReply())
            ).resolves.toBeUndefined();
            await l.close();
        });
    });
});
