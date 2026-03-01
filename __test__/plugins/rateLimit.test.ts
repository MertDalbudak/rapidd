/**
 * Tests for the rate limiter (memory-based, no Redis).
 */
import { RateLimiter } from '../../src/plugins/rateLimit';

describe('RateLimiter (memory-based)', () => {
    let limiter: RateLimiter;

    beforeEach(() => {
        // Ensure no Redis env is set
        delete process.env.REDIS_HOST;
        limiter = new RateLimiter();
    });

    afterEach(async () => {
        await limiter.close();
    });

    function makeRequest(ip: string = '127.0.0.1', url: string = '/api/test') {
        return {
            ip,
            url,
            headers: {},
        } as any;
    }

    function makeReply() {
        const headers: Record<string, any> = {};
        return {
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
            const reply = makeReply();
            await limiter.checkLimit(req, reply);
        }
        // After 5 requests, remaining should be reduced
        const reply = makeReply();
        await limiter.checkLimit(req, reply);
        const remainingCall = reply.header.mock.calls.find(
            (c: any) => c[0] === 'X-RateLimit-Remaining'
        );
        expect(remainingCall[1]).toBeLessThan(100);
    });

    it('should throw 429 when limit exceeded', async () => {
        // Create limiter with low default for testing
        process.env.RATE_LIMIT_MAX_REQUESTS = '3';
        process.env.RATE_LIMIT_WINDOW_MS = '60000';
        const testLimiter = new RateLimiter();

        const req = makeRequest('10.0.0.1', '/api/limited');
        for (let i = 0; i < 3; i++) {
            await testLimiter.checkLimit(req, makeReply());
        }

        const reply = makeReply();
        await expect(testLimiter.checkLimit(req, reply)).rejects.toMatchObject({ status_code: 429 });

        await testLimiter.close();
        delete process.env.RATE_LIMIT_MAX_REQUESTS;
        delete process.env.RATE_LIMIT_WINDOW_MS;
    });

    it('should track different IPs separately', async () => {
        process.env.RATE_LIMIT_MAX_REQUESTS = '2';
        const testLimiter = new RateLimiter();

        const req1 = makeRequest('1.1.1.1');
        const req2 = makeRequest('2.2.2.2');

        await testLimiter.checkLimit(req1, makeReply());
        await testLimiter.checkLimit(req1, makeReply());
        await expect(testLimiter.checkLimit(req1, makeReply())).rejects.toMatchObject({ status_code: 429 });

        // Different IP should still be allowed
        await expect(testLimiter.checkLimit(req2, makeReply())).resolves.toBeUndefined();

        await testLimiter.close();
        delete process.env.RATE_LIMIT_MAX_REQUESTS;
    });

    it('should track different paths separately', async () => {
        process.env.RATE_LIMIT_MAX_REQUESTS = '2';
        const testLimiter = new RateLimiter();

        const req1 = makeRequest('1.1.1.1', '/api/a');
        const req2 = makeRequest('1.1.1.1', '/api/b');

        await testLimiter.checkLimit(req1, makeReply());
        await testLimiter.checkLimit(req1, makeReply());
        await expect(testLimiter.checkLimit(req1, makeReply())).rejects.toMatchObject({ status_code: 429 });

        // Different path should still be allowed
        await expect(testLimiter.checkLimit(req2, makeReply())).resolves.toBeUndefined();

        await testLimiter.close();
        delete process.env.RATE_LIMIT_MAX_REQUESTS;
    });

    it('should strip query params from path for rate limiting', async () => {
        process.env.RATE_LIMIT_MAX_REQUESTS = '2';
        const testLimiter = new RateLimiter();

        const req1 = makeRequest('1.1.1.1', '/api/test?foo=bar');
        const req2 = makeRequest('1.1.1.1', '/api/test?baz=qux');

        await testLimiter.checkLimit(req1, makeReply());
        await testLimiter.checkLimit(req2, makeReply());
        // Both share same path /api/test
        await expect(testLimiter.checkLimit(req1, makeReply())).rejects.toMatchObject({ status_code: 429 });

        await testLimiter.close();
        delete process.env.RATE_LIMIT_MAX_REQUESTS;
    });

    it('should set correct rate limit headers', async () => {
        process.env.RATE_LIMIT_MAX_REQUESTS = '10';
        const testLimiter = new RateLimiter();

        const req = makeRequest();
        const reply = makeReply();
        await testLimiter.checkLimit(req, reply);

        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', 10);
        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', 9);
        expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));

        await testLimiter.close();
        delete process.env.RATE_LIMIT_MAX_REQUESTS;
    });

    it('should close without error', async () => {
        await expect(limiter.close()).resolves.toBeUndefined();
    });
});
