/**
 * Tests for the request plugin (parseListQuery).
 */
import Fastify from 'fastify';
import requestPlugin from '../../src/plugins/request';

describe('Request Plugin', () => {
    async function buildApp() {
        const app = Fastify();
        await app.register(requestPlugin);
        return app;
    }

    describe('parseListQuery()', () => {
        it('should return defaults when no query params', async () => {
            const app = await buildApp();
            app.get('/items', async (req) => {
                return req.parseListQuery();
            });

            const res = await app.inject({ method: 'GET', url: '/items' });
            const body = JSON.parse(res.payload);
            expect(body.include).toBe('');
            expect(body.sortBy).toBe('id');
            expect(body.sortOrder).toBe('asc');
            expect(body.fields).toBeNull();
            expect(body.limit).toBe(25);
            expect(body.offset).toBe(0);
            expect(body.totalResults).toBe(false);
        });

        it('should parse provided query params', async () => {
            const app = await buildApp();
            app.get('/items', async (req) => {
                return req.parseListQuery();
            });

            const res = await app.inject({
                method: 'GET',
                url: '/items?include=tags&sortBy=name&sortOrder=desc&limit=10&offset=20&totalResults=true',
            });
            const body = JSON.parse(res.payload);
            expect(body.include).toBe('tags');
            expect(body.sortBy).toBe('name');
            expect(body.sortOrder).toBe('desc');
            expect(body.limit).toBe(10);
            expect(body.offset).toBe(20);
            expect(body.totalResults).toBe(true);
        });

        it('should include pagination when PAGINATION_MODE=page', async () => {
            const original = process.env.PAGINATION_MODE;
            process.env.PAGINATION_MODE = 'page';

            const app = await buildApp();
            app.get('/items', async (req) => {
                return req.parseListQuery();
            });

            const res = await app.inject({
                method: 'GET',
                url: '/items?page=3&pageSize=50',
            });
            const body = JSON.parse(res.payload);
            expect(body.pagination).toEqual({ page: 3, pageSize: 50 });

            process.env.PAGINATION_MODE = original;
        });

        it('should not include pagination by default', async () => {
            const original = process.env.PAGINATION_MODE;
            delete process.env.PAGINATION_MODE;

            const app = await buildApp();
            app.get('/items', async (req) => {
                return req.parseListQuery();
            });

            const res = await app.inject({ method: 'GET', url: '/items' });
            const body = JSON.parse(res.payload);
            expect(body.pagination).toBeUndefined();

            if (original) process.env.PAGINATION_MODE = original;
        });

        it('should default page=1 and pageSize=25 when PAGINATION_MODE=page', async () => {
            const original = process.env.PAGINATION_MODE;
            process.env.PAGINATION_MODE = 'page';

            const app = await buildApp();
            app.get('/items', async (req) => {
                return req.parseListQuery();
            });

            const res = await app.inject({ method: 'GET', url: '/items' });
            const body = JSON.parse(res.payload);
            expect(body.pagination).toEqual({ page: 1, pageSize: 25 });

            process.env.PAGINATION_MODE = original;
        });
    });
});
