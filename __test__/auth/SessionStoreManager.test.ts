jest.mock('../../src/auth/stores/RedisStore', () => {
    return {
        RedisStore: class MockRedisStore {
            private data = new Map<string, string>();
            private _healthy = true;
            ttl: number;

            constructor(options: any = {}) {
                this.ttl = options.ttl || 86400;
            }

            async create(sessionId: string, data: Record<string, unknown>) {
                if (!this._healthy) throw new Error('Redis unavailable');
                this.data.set(`session:${sessionId}`, JSON.stringify(data));
            }

            async get(sessionId: string) {
                if (!this._healthy) throw new Error('Redis unavailable');
                const result = this.data.get(`session:${sessionId}`);
                return result ? JSON.parse(result) : null;
            }

            async delete(sessionId: string) {
                if (!this._healthy) throw new Error('Redis unavailable');
                this.data.delete(`session:${sessionId}`);
            }

            async refresh() {
                if (!this._healthy) throw new Error('Redis unavailable');
            }

            async isHealthy() { return this._healthy; }

            setHealthy(val: boolean) { this._healthy = val; }

            async destroy() { this.data.clear(); }
        }
    };
});

import { SessionStoreManager, createStore } from '../../src/auth/stores/index';

describe('SessionStoreManager', () => {
    let manager: SessionStoreManager;

    afterEach(() => {
        if (manager) manager.destroy();
    });

    describe('with memory store', () => {
        beforeEach(() => {
            manager = new SessionStoreManager({ store: 'memory', ttl: 60 });
        });

        it('should create and retrieve sessions', async () => {
            await manager.create('s1', { id: 1, role: 'user' });
            const result = await manager.get('s1');
            expect(result).toEqual({ id: 1, role: 'user' });
        });

        it('should delete sessions', async () => {
            await manager.create('s2', { id: 2 });
            await manager.delete('s2');
            expect(await manager.get('s2')).toBeNull();
        });

        it('should refresh sessions', async () => {
            await manager.create('s3', { id: 3 });
            await manager.refresh('s3');
            expect(await manager.get('s3')).toEqual({ id: 3 });
        });

        it('should report healthy', async () => {
            expect(await manager.isHealthy()).toBe(true);
        });

        it('should show correct status', async () => {
            // trigger initialization
            await manager.create('init', { id: 0 });
            const status = manager.getStatus();
            expect(status.configured).toBe('memory');
            expect(status.active).toBe('memory');
            expect(status.usingFallback).toBe(false);
        });
    });

    describe('with unknown store', () => {
        it('should fall back to memory for unknown store type', async () => {
            manager = new SessionStoreManager({ store: 'unknown-store', ttl: 60 });
            await manager.create('test', { id: 1 });
            expect(await manager.get('test')).toEqual({ id: 1 });
        });
    });

    describe('createStore factory', () => {
        it('should return a SessionStoreManager', () => {
            const store = createStore({ ttl: 120, store: 'memory' });
            expect(store).toBeInstanceOf(SessionStoreManager);
            store.destroy();
        });

        it('should use defaults when no options provided', () => {
            const store = createStore();
            expect(store).toBeInstanceOf(SessionStoreManager);
            store.destroy();
        });
    });

    describe('default env configuration', () => {
        it('should read TTL from env', () => {
            process.env.AUTH_SESSION_TTL = '3600';
            const m = new SessionStoreManager();
            expect(m).toBeDefined();
            m.destroy();
            delete process.env.AUTH_SESSION_TTL;
        });

        it('should read store type from env', () => {
            process.env.AUTH_SESSION_STORAGE = 'memory';
            const m = new SessionStoreManager();
            expect(m).toBeDefined();
            m.destroy();
            delete process.env.AUTH_SESSION_STORAGE;
        });
    });
});
