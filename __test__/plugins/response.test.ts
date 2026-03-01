/**
 * Tests for the response plugin (sendList, sendError, sendResponse, error handler).
 */

// Mock i18n
jest.mock('../../src/core/i18n', () => ({
    LanguageDict: {
        get: jest.fn((key: string, _data?: any, _lang?: string) => key),
        initialize: jest.fn(),
    },
}));

import Fastify from 'fastify';
import responsePlugin from '../../src/plugins/response';
import { ErrorResponse, ErrorBasicResponse } from '../../src/core/errors';

describe('Response Plugin', () => {
    async function buildApp() {
        const app = Fastify();
        await app.register(responsePlugin);
        return app;
    }

    // ── sendList ─────────────────────────────────────────────

    describe('sendList()', () => {
        it('should send data with meta', async () => {
            const app = await buildApp();
            app.get('/items', async (_req, reply) => {
                return reply.sendList(
                    [{ id: 1 }, { id: 2 }],
                    { take: 10, skip: 0, total: 50 }
                );
            });

            const res = await app.inject({ method: 'GET', url: '/items' });
            const body = JSON.parse(res.payload);
            expect(body.data).toHaveLength(2);
            expect(body.meta.total).toBe(50);
            expect(body.meta.count).toBe(2);
            expect(body.meta.limit).toBe(10);
            expect(body.meta.offset).toBe(0);
            expect(body.meta.hasMore).toBe(true);
        });

        it('should calculate hasMore=false when at end', async () => {
            const app = await buildApp();
            app.get('/items', async (_req, reply) => {
                return reply.sendList(
                    [{ id: 1 }],
                    { take: 10, skip: 40, total: 41 }
                );
            });

            const res = await app.inject({ method: 'GET', url: '/items' });
            const body = JSON.parse(res.payload);
            expect(body.meta.hasMore).toBe(false);
        });

        it('should omit total and hasMore when total is undefined', async () => {
            const app = await buildApp();
            app.get('/items', async (_req, reply) => {
                return reply.sendList(
                    [{ id: 1 }],
                    { take: 10, skip: 0 }
                );
            });

            const res = await app.inject({ method: 'GET', url: '/items' });
            const body = JSON.parse(res.payload);
            expect(body.meta.total).toBeUndefined();
            expect(body.meta.hasMore).toBeUndefined();
            expect(body.meta.count).toBe(1);
        });
    });

    // ── sendError ────────────────────────────────────────────

    describe('sendError()', () => {
        it('should send error with status code', async () => {
            const app = await buildApp();
            app.get('/err', async (_req, reply) => {
                return reply.sendError(400, 'bad_input');
            });

            const res = await app.inject({ method: 'GET', url: '/err' });
            expect(res.statusCode).toBe(400);
            const body = JSON.parse(res.payload);
            expect(body.status_code).toBe(400);
            expect(body.message).toBe('bad_input');
        });

        it('should send 500 error', async () => {
            const app = await buildApp();
            app.get('/err', async (_req, reply) => {
                return reply.sendError(500, 'internal_error');
            });

            const res = await app.inject({ method: 'GET', url: '/err' });
            expect(res.statusCode).toBe(500);
        });
    });

    // ── sendResponse ─────────────────────────────────────────

    describe('sendResponse()', () => {
        it('should send success response', async () => {
            const app = await buildApp();
            app.get('/ok', async (_req, reply) => {
                return reply.sendResponse(200, 'operation_successful');
            });

            const res = await app.inject({ method: 'GET', url: '/ok' });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.status_code).toBe(200);
            expect(body.message).toBe('operation_successful');
        });
    });

    // ── Error Handler ────────────────────────────────────────

    describe('error handler', () => {
        it('should handle ErrorResponse', async () => {
            const app = await buildApp();
            app.get('/err', async () => {
                throw new ErrorResponse(404, 'not_found');
            });

            const res = await app.inject({ method: 'GET', url: '/err' });
            expect(res.statusCode).toBe(404);
            const body = JSON.parse(res.payload);
            expect(body.message).toBe('not_found');
        });

        it('should handle ErrorBasicResponse', async () => {
            const app = await buildApp();
            app.get('/err', async () => {
                throw new ErrorBasicResponse('Something bad', 502);
            });

            const res = await app.inject({ method: 'GET', url: '/err' });
            expect(res.statusCode).toBe(502);
            const body = JSON.parse(res.payload);
            expect(body.message).toBe('Something bad');
        });

        it('should handle generic Error', async () => {
            const app = await buildApp();
            app.get('/err', async () => {
                throw new Error('generic error');
            });

            const res = await app.inject({ method: 'GET', url: '/err' });
            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.payload);
            expect(body.message).toBe('generic error');
        });

        it('should handle error with statusCode property', async () => {
            const app = await buildApp();
            app.get('/err', async () => {
                const err = new Error('custom') as any;
                err.statusCode = 422;
                throw err;
            });

            const res = await app.inject({ method: 'GET', url: '/err' });
            expect(res.statusCode).toBe(422);
        });
    });

    // ── Request decorators ───────────────────────────────────

    describe('request decorators', () => {
        it('should set remoteAddress from request.ip', async () => {
            const app = await buildApp();
            app.get('/ip', async (req) => {
                return { ip: req.remoteAddress };
            });

            const res = await app.inject({ method: 'GET', url: '/ip' });
            const body = JSON.parse(res.payload);
            expect(body.ip).toBeDefined();
        });

        it('should decorate request with null user', async () => {
            const app = await buildApp();
            app.get('/user', async (req) => {
                return { user: req.user };
            });

            const res = await app.inject({ method: 'GET', url: '/user' });
            const body = JSON.parse(res.payload);
            expect(body.user).toBeNull();
        });
    });
});
