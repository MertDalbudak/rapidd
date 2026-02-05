import { modelMiddleware } from '../../src/core/middleware';

describe('modelMiddleware', () => {
    afterEach(() => {
        modelMiddleware.clear();
    });

    describe('use()', () => {
        it('should register a middleware function', () => {
            const fn = jest.fn();
            modelMiddleware.use('before', 'create', fn);

            const middlewares = modelMiddleware.getMiddleware('before', 'create', 'testModel');
            expect(middlewares).toContain(fn);
        });

        it('should register model-specific middleware', () => {
            const globalFn = jest.fn();
            const modelFn = jest.fn();

            modelMiddleware.use('before', 'create', globalFn);
            modelMiddleware.use('before', 'create', modelFn, 'users');

            const usersMiddleware = modelMiddleware.getMiddleware('before', 'create', 'users');
            expect(usersMiddleware).toContain(globalFn);
            expect(usersMiddleware).toContain(modelFn);

            const postsMiddleware = modelMiddleware.getMiddleware('before', 'create', 'posts');
            expect(postsMiddleware).toContain(globalFn);
            expect(postsMiddleware).not.toContain(modelFn);
        });

        it('should throw on invalid hook', () => {
            expect(() => {
                modelMiddleware.use('invalid' as any, 'create', jest.fn());
            }).toThrow("Invalid hook 'invalid'");
        });

        it('should throw on invalid operation', () => {
            expect(() => {
                modelMiddleware.use('before', 'invalid' as any, jest.fn());
            }).toThrow("Invalid operation 'invalid'");
        });

        it('should throw on non-function middleware', () => {
            expect(() => {
                modelMiddleware.use('before', 'create', 'not a function' as any);
            }).toThrow('Middleware must be a function');
        });
    });

    describe('remove()', () => {
        it('should remove a specific middleware', () => {
            const fn = jest.fn();
            modelMiddleware.use('before', 'create', fn);
            expect(modelMiddleware.remove('before', 'create', fn)).toBe(true);

            const middlewares = modelMiddleware.getMiddleware('before', 'create', 'test');
            expect(middlewares).not.toContain(fn);
        });

        it('should return false when middleware not found', () => {
            expect(modelMiddleware.remove('before', 'create', jest.fn())).toBe(false);
        });
    });

    describe('clear()', () => {
        it('should clear all middleware', () => {
            modelMiddleware.use('before', 'create', jest.fn());
            modelMiddleware.use('after', 'update', jest.fn());
            modelMiddleware.clear();

            expect(modelMiddleware.getMiddleware('before', 'create', 'test')).toHaveLength(0);
            expect(modelMiddleware.getMiddleware('after', 'update', 'test')).toHaveLength(0);
        });
    });

    describe('execute()', () => {
        it('should execute middleware chain in order', async () => {
            const order: number[] = [];

            modelMiddleware.use('before', 'create', async (ctx) => {
                order.push(1);
                return ctx;
            });

            modelMiddleware.use('before', 'create', async (ctx) => {
                order.push(2);
                return ctx;
            });

            const context = modelMiddleware.createContext(
                { name: 'users' },
                'create',
                { data: { name: 'test' } },
                null
            );

            await modelMiddleware.execute('before', 'create', context);
            expect(order).toEqual([1, 2]);
        });

        it('should stop on abort', async () => {
            const fn2 = jest.fn();

            modelMiddleware.use('before', 'create', async (ctx) => {
                ctx.abort = true;
                return ctx;
            });

            modelMiddleware.use('before', 'create', fn2);

            const context = modelMiddleware.createContext(
                { name: 'users' },
                'create',
                { data: {} },
                null
            );

            const result = await modelMiddleware.execute('before', 'create', context);
            expect(result.abort).toBe(true);
            expect(fn2).not.toHaveBeenCalled();
        });

        it('should pass modified context between middleware', async () => {
            modelMiddleware.use('before', 'create', async (ctx) => {
                (ctx as any).data = { ...(ctx as any).data, createdAt: '2024-01-01' };
                return ctx;
            });

            modelMiddleware.use('before', 'create', async (ctx) => {
                (ctx as any).data = { ...(ctx as any).data, updatedAt: '2024-01-01' };
                return ctx;
            });

            const context = modelMiddleware.createContext(
                { name: 'users' },
                'create',
                { data: { name: 'test' } },
                null
            );

            const result = await modelMiddleware.execute('before', 'create', context);
            expect((result as any).data).toEqual({
                name: 'test',
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
            });
        });
    });

    describe('createContext()', () => {
        it('should create a valid context object', () => {
            const context = modelMiddleware.createContext(
                { name: 'users' },
                'create',
                { data: { name: 'test' } },
                { id: '1', role: 'admin' }
            );

            expect(context.model).toEqual({ name: 'users' });
            expect(context.operation).toBe('create');
            expect(context.user).toEqual({ id: '1', role: 'admin' });
            expect(context.abort).toBe(false);
            expect(context.skip).toBe(false);
            expect(context.softDelete).toBe(false);
            expect(context.timestamp).toBeInstanceOf(Date);
        });
    });
});
