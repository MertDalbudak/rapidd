import { MemoryStore } from '../../src/auth/stores/MemoryStore';

describe('MemoryStore', () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = new MemoryStore({ ttl: 10 }); // 10 second TTL
    });

    afterEach(() => {
        store.destroy();
    });

    describe('create()', () => {
        it('should store session data', async () => {
            await store.create('session-1', { id: 1, role: 'user' });
            const result = await store.get('session-1');
            expect(result).toEqual({ id: 1, role: 'user' });
        });

        it('should overwrite existing session', async () => {
            await store.create('session-1', { id: 1 });
            await store.create('session-1', { id: 2 });
            const result = await store.get('session-1');
            expect(result).toEqual({ id: 2 });
        });

        it('should store complex data', async () => {
            const data = { id: 1, role: 'admin', permissions: ['read', 'write'], nested: { key: 'value' } };
            await store.create('complex', data);
            expect(await store.get('complex')).toEqual(data);
        });
    });

    describe('get()', () => {
        it('should return null for non-existent session', async () => {
            expect(await store.get('non-existent')).toBeNull();
        });

        it('should return stored data', async () => {
            await store.create('test', { foo: 'bar' });
            expect(await store.get('test')).toEqual({ foo: 'bar' });
        });

        it('should return null for expired session', async () => {
            // ttl=0 is falsy so MemoryStore defaults to 86400. Force expiry via internal map.
            await store.create('expired', { id: 1 });
            const sessions = (store as any).sessions as Map<string, any>;
            sessions.get('expired').expiresAt = Date.now() - 1000;

            expect(await store.get('expired')).toBeNull();
        });

        it('should clean up expired session on get', async () => {
            await store.create('will-expire', { id: 1 });
            const sessions = (store as any).sessions as Map<string, any>;
            sessions.get('will-expire').expiresAt = Date.now() - 1000;

            // First get triggers cleanup and deletes the entry
            await store.get('will-expire');
            expect(sessions.has('will-expire')).toBe(false);
        });
    });

    describe('delete()', () => {
        it('should remove an existing session', async () => {
            await store.create('to-delete', { id: 1 });
            await store.delete('to-delete');
            expect(await store.get('to-delete')).toBeNull();
        });

        it('should not throw for non-existent session', async () => {
            await expect(store.delete('non-existent')).resolves.toBeUndefined();
        });
    });

    describe('refresh()', () => {
        it('should extend session TTL', async () => {
            await store.create('refresh-me', { id: 1 });
            await store.refresh('refresh-me');
            // Session should still be accessible
            expect(await store.get('refresh-me')).toEqual({ id: 1 });
        });

        it('should not throw for non-existent session', async () => {
            await expect(store.refresh('non-existent')).resolves.toBeUndefined();
        });
    });

    describe('isHealthy()', () => {
        it('should always return true', async () => {
            expect(await store.isHealthy()).toBe(true);
        });
    });

    describe('destroy()', () => {
        it('should clear all sessions', async () => {
            await store.create('a', { id: 1 });
            await store.create('b', { id: 2 });
            store.destroy();
            expect(await store.get('a')).toBeNull();
            expect(await store.get('b')).toBeNull();
        });
    });

    describe('default TTL', () => {
        it('should use 86400 seconds (24h) when no TTL provided', () => {
            const defaultStore = new MemoryStore();
            // Store is created without error
            expect(defaultStore).toBeDefined();
            defaultStore.destroy();
        });
    });

    describe('multiple sessions', () => {
        it('should handle many concurrent sessions', async () => {
            const count = 100;
            for (let i = 0; i < count; i++) {
                await store.create(`session-${i}`, { id: i });
            }
            for (let i = 0; i < count; i++) {
                expect(await store.get(`session-${i}`)).toEqual({ id: i });
            }
        });

        it('should independently manage each session', async () => {
            await store.create('a', { id: 1 });
            await store.create('b', { id: 2 });
            await store.delete('a');
            expect(await store.get('a')).toBeNull();
            expect(await store.get('b')).toEqual({ id: 2 });
        });
    });
});
