/**
 * Tests for the security headers plugin.
 */
import Fastify from 'fastify';
import securityPlugin from '../../src/plugins/security';

describe('Security Plugin', () => {
    it('should set X-Content-Type-Options header', async () => {
        const app = Fastify();
        await app.register(securityPlugin);
        app.get('/test', async () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/test' });
        expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('should set Referrer-Policy header', async () => {
        const app = Fastify();
        await app.register(securityPlugin);
        app.get('/test', async () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/test' });
        expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    it('should set Content-Security-Policy header', async () => {
        const app = Fastify();
        await app.register(securityPlugin);
        app.get('/test', async () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/test' });
        expect(response.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    });

    it('should set Permissions-Policy header', async () => {
        const app = Fastify();
        await app.register(securityPlugin);
        app.get('/test', async () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/test' });
        expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    });

    it('should NOT set HSTS in non-production', async () => {
        const app = Fastify();
        await app.register(securityPlugin);
        app.get('/test', async () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/test' });
        expect(response.headers['strict-transport-security']).toBeUndefined();
    });

    it('should set all headers on every response', async () => {
        const app = Fastify();
        await app.register(securityPlugin);
        app.get('/a', async () => 'a');
        app.post('/b', async () => 'b');

        const res1 = await app.inject({ method: 'GET', url: '/a' });
        const res2 = await app.inject({ method: 'POST', url: '/b' });

        for (const res of [res1, res2]) {
            expect(res.headers['x-content-type-options']).toBe('nosniff');
            expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        }
    });
});
