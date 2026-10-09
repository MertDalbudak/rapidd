/**
 * The setup wizard's connection checks against real servers.
 * Opt-in: `bash __test__/integration/setup.sh && RAPIDD_IT=1 npx jest __test__/integration --forceExit`
 */
import { runCheck } from '../../src/setup/checks';

const run = process.env.RAPIDD_IT === '1' ? describe : describe.skip;
jest.setTimeout(30000);

const LDAP = {
    AUTH_PROVIDERS: 'ldap', LDAP_URL: 'ldap://127.0.0.1:51389', LDAP_BIND_DN: 'cn=admin,dc=corp,dc=example',
    LDAP_BIND_PASSWORD: 'adminpw', LDAP_SEARCH_BASE: 'dc=corp,dc=example',
};

run('setup checks ↔ real servers', () => {
    it('PostgreSQL: version, database and tables; wrong password and database explained', async () => {
        const ok = await runCheck('database', { DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:56543/app?schema=public' });
        expect(ok).toMatchObject({ ok: true, message: expect.stringMatching(/^Connected to PostgreSQL 16/), details: { database: 'app (schema public)' } });
        expect(await runCheck('database', { DATABASE_URL: 'postgresql://postgres:wrong@127.0.0.1:56543/app' }))
            .toMatchObject({ ok: false, message: expect.stringContaining('Authentication failed') });
        expect(await runCheck('database', { DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:56543/nope' }))
            .toMatchObject({ ok: false, message: expect.stringContaining('does not exist') });
    });

    it('Redis: version', async () => {
        expect(await runCheck('redis', { REDIS_URL: 'redis://127.0.0.1:56379' }))
            .toMatchObject({ ok: true, message: expect.stringMatching(/^Connected to Redis 7/) });
    });

    it('OpenLDAP: service account, search base, and a real sign-in mapped to an identity', async () => {
        const ok = await runCheck('ldap', LDAP, { username: 'alice', password: 'alice-pass' });
        expect(ok.ok).toBe(true);
        expect(ok.steps?.map((s) => s.target)).toEqual(['ldap://127.0.0.1:51389', 'service account', 'sign-in as alice']);
        expect(ok.details?.identity).toMatchObject({ username: 'alice', email: 'alice@corp.example', name: 'Alice Doe' });

        const badBind = await runCheck('ldap', { ...LDAP, LDAP_BIND_PASSWORD: 'rotated' });
        expect(badBind.steps?.[1]).toMatchObject({ ok: false, message: expect.stringContaining('Bind failed') });
        const badBase = await runCheck('ldap', { ...LDAP, LDAP_SEARCH_BASE: 'ou=missing,dc=corp,dc=example' });
        expect(badBase.steps?.[1]).toMatchObject({ ok: false, message: 'The search base does not exist' });
        const badUser = await runCheck('ldap', LDAP, { username: 'alice', password: 'wrong' });
        expect(badUser.steps?.at(-1)).toMatchObject({ ok: false, message: expect.stringContaining('rejected') });
    });

    it('Keycloak: discovery, signing keys, redirect URI to register', async () => {
        const r = await runCheck('oidc', { OIDC_ISSUER: 'http://127.0.0.1:58080/realms/corp', PUBLIC_URL: 'https://api.example.com' });
        expect(r).toMatchObject({ ok: true, details: { register_redirect_uri: 'https://api.example.com/auth/oidc/callback' } });
        expect(await runCheck('oidc', { OIDC_ISSUER: 'http://127.0.0.1:58080/realms/corp/' }))
            .toMatchObject({ ok: false, message: expect.stringContaining('Issuer mismatch') });
    });
});
