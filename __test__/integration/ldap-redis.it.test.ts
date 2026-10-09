/**
 * Integration tests against a real OpenLDAP and a real Redis.
 * Opt-in: `bash __test__/integration/setup.sh && RAPIDD_IT=1 npx jest __test__/integration --forceExit`
 */
import { LdapProvider } from '../../src/auth/providers/LdapProvider';
import { RedisStore } from '../../src/auth/stores/RedisStore';
import { SessionStoreManager } from '../../src/auth/stores';

const run = process.env.RAPIDD_IT === '1' ? describe : describe.skip;
jest.setTimeout(30000);

const LDAP_URL = 'ldap://127.0.0.1:51389';
const base = { type: 'ldap' as const, url: LDAP_URL, bindDN: 'cn=admin,dc=corp,dc=example', bindPassword: 'adminpw', searchBase: 'dc=corp,dc=example' };
const direct = () => new LdapProvider({ type: 'ldap', url: LDAP_URL, bindTemplate: 'uid={{username}},ou=people,dc=corp,dc=example', searchBase: 'dc=corp,dc=example' });

run('LdapProvider ↔ OpenLDAP', () => {
    const p = new LdapProvider(base);

    it('search-then-bind maps the entry (entryUUID subject)', async () => {
        const alice = await p.authenticate('alice', 'alice-pass');
        expect(alice).toMatchObject({ username: 'alice', email: 'alice@corp.example', name: 'Alice Doe', groups: [] });
        expect(alice!.subject).toMatch(/^[0-9a-f-]{36}$/);
        expect((await p.authenticate('alice@corp.example', 'alice-pass'))?.username).toBe('alice');
    });

    it('rejects wrong and empty passwords and filter injection', async () => {
        expect(await p.authenticate('alice', 'wrong')).toBeNull();
        expect(await p.authenticate('alice', '')).toBeNull();
        expect(await p.authenticate('*', 'alice-pass')).toBeNull();
        expect(await p.authenticate('*)(uid=*', 'alice-pass')).toBeNull();
    });

    it('resolves groups by group search, as full DNs', async () => {
        const grouped = new LdapProvider({ ...base, groupSearchBase: 'ou=groups,dc=corp,dc=example' });
        expect((await grouped.authenticate('alice', 'alice-pass'))!.groups.sort())
            .toEqual(['cn=admins,ou=groups,dc=corp,dc=example', 'cn=staff,ou=groups,dc=corp,dc=example']);
    });

    it('direct bind reads the own entry (users cannot search the tree here)', async () => {
        expect((await direct().authenticate('bob', 'bob-pass'))?.name).toBe('Bob, Jr.');
        expect(await direct().authenticate('bob', 'nope')).toBeNull();
    });

    it('fails over, and answers 503 for outages and a broken service account', async () => {
        const failover = new LdapProvider({ ...base, url: ['ldap://127.0.0.1:1', LDAP_URL] });
        expect((await failover.authenticate('alice', 'alice-pass'))?.username).toBe('alice');
        await expect(new LdapProvider({ ...base, bindPassword: 'rotated' }).authenticate('alice', 'alice-pass'))
            .rejects.toMatchObject({ status_code: 503 });
        await expect(new LdapProvider({ ...base, url: 'ldap://127.0.0.1:1', timeout: 1000 }).authenticate('alice', 'alice-pass'))
            .rejects.toMatchObject({ status_code: 503 });
    });

    it('revalidate(): true while the account exists, false once it is deleted', async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Client } = require('ldapts');
        const admin = new Client({ url: LDAP_URL });
        await admin.bind('cn=admin,dc=corp,dc=example', 'adminpw');
        const dn = `uid=temp${Date.now()},ou=people,dc=corp,dc=example`;
        await admin.add(dn, { objectClass: 'inetOrgPerson', uid: dn.slice(4, dn.indexOf(',')), cn: 'Temp', sn: 'T', userPassword: 'temp-pass' });
        try {
            const temp = (await p.authenticate(dn.slice(4, dn.indexOf(',')), 'temp-pass'))!;
            expect(await p.revalidate(temp)).toBe(true);
            expect(await direct().revalidate(temp)).toBeNull(); // no service account: cannot tell
            await admin.del(dn);
            expect(await p.revalidate(temp)).toBe(false);
        } finally {
            await admin.del(dn).catch(() => undefined);
            await admin.unbind();
        }
    });
});

run('RedisStore ↔ Redis', () => {
    let store: RedisStore;
    const saved = process.env.REDIS_URL;

    beforeAll(() => {
        process.env.REDIS_URL = 'redis://127.0.0.1:56379';
        store = new RedisStore({ ttl: 60, indexTtl: 600, prefix: `it:${Date.now()}:` });
    });
    afterAll(async () => {
        await store.destroy();
        process.env.REDIS_URL = saved;
    });

    it('touch, per-entry TTLs and an index that outlives its entries', async () => {
        await store.create('s1', { id: 1 }, { userId: 1 });
        await store.create('rt:s1', { jti: 'a' }, { userId: 1, ttl: 600 });
        expect(await store.touch('s1')).toEqual({ id: 1 });
        const client = (store as any).client;
        const ttlRt = await client.ttl((store as any)._key('rt:s1'));
        expect(ttlRt).toBeGreaterThan(500);
        expect(await client.ttl((store as any)._userKey(1))).toBeGreaterThanOrEqual(ttlRt);
    });

    it('take is single-use under concurrency; replace/add are conditional', async () => {
        await store.create('ticket', { v: 1 });
        const results = await Promise.all(Array.from({ length: 20 }, () => store.take('ticket')));
        expect(results.filter(Boolean)).toHaveLength(1);

        expect(await store.replace('missing', { v: 1 })).toBe(false);
        expect(await store.replace('s1', { id: 1, v: 2 }, { userId: 1 })).toBe(true);
        expect(await store.add('s1', { v: 3 })).toBe(false);
        expect(await store.add('fresh', { v: 1 }, { ttl: 60 })).toBe(true);
    });

    it('prunes expired index members and revokes one user only', async () => {
        const client = (store as any).client;
        await client.zadd((store as any)._userKey(1), Date.now() - 1000, 'expired-member');
        await store.create('s1b', { id: 1 }, { userId: 1 });
        expect(await client.zrange((store as any)._userKey(1), 0, -1)).not.toContain('expired-member');

        await store.create('s2', { id: 2 }, { userId: 2 });
        expect(await store.deleteByUser(1)).toBe(3); // s1, rt:s1, s1b
        expect(await store.get('s1')).toBeNull();
        expect(await store.get('s2')).toEqual({ id: 2 });
        expect(await store.isHealthy()).toBe(true);
    });

    it('SessionStoreManager runs on Redis', async () => {
        const manager = new SessionStoreManager({ store: 'redis', ttl: 60, indexTtl: 600 });
        try {
            await manager.create(`m-${Date.now()}`, { id: 9 }, { userId: 'it-9' });
            expect(manager.getStatus().active).toBe('redis');
            expect(await manager.deleteByUser('it-9')).toBe(1);
        } finally {
            await manager.destroy();
        }
    });
});
