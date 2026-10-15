/**
 * Integration tests against a real Keycloak 26: IdP access tokens as bearer tokens, and the
 * full browser login (authorization code + PKCE) through Keycloak's own login form.
 * Opt-in: `bash __test__/integration/setup.sh && RAPIDD_IT=1 npx jest __test__/integration --forceExit`
 */
jest.mock('../../src/core/prisma', () => ({
    rlsActive: () => false,
    authPrisma: {},
    prisma: {},
    dbProvider: 'postgresql',
    getAcl: () => ({ model: {} }),
    requestContext: { run: jest.fn((_s: any, fn: any) => fn()) },
    rlsEnabled: false,
}));
jest.mock('../../src/core/dmmf', () => ({
    loadDMMF: jest.fn().mockResolvedValue({}),
    findUserModel: jest.fn(() => null), // no user table: users come from Keycloak claims
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => null),
    getPrimaryKey: jest.fn(() => 'id'),
    getScalarFields: jest.fn(() => ({})),
    getDMMFSync: jest.fn(() => ({ datamodel: { models: [] } })),
    getModel: jest.fn(), getFields: jest.fn(() => ({})), getRelations: jest.fn(() => []),
    isListRelation: jest.fn(() => false), getRelationInfo: jest.fn(), buildRelationships: jest.fn(() => []),
}));

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import authPlugin from '../../src/plugins/auth';
import responsePlugin from '../../src/plugins/response';
import { Auth } from '../../src/auth/Auth';
import { SessionStoreManager } from '../../src/auth/stores';

const run = process.env.RAPIDD_IT === '1' ? describe : describe.skip;
jest.setTimeout(30000);

const KC = 'http://127.0.0.1:58080/realms/corp';

async function passwordGrant(): Promise<{ access_token: string }> {
    const response = await fetch(`${KC}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password', client_id: 'rapidd-api', client_secret: 'rapidd-secret',
            username: 'alice', password: 'alice-pass', scope: 'openid',
        }),
    });
    return response.json() as Promise<{ access_token: string }>;
}

run('Auth ↔ Keycloak 26', () => {
    let app: FastifyInstance;
    const savedEnv = { ...process.env };

    beforeAll(async () => {
        process.env.PUBLIC_URL = 'http://rapidd.test';
        app = Fastify();
        await app.register(fastifyCookie, { secret: 'cookie-secret-1234567890' });
        await app.register(responsePlugin);
        const auth = new Auth({
            providers: [{
                type: 'oidc', name: 'keycloak', issuer: KC, clientId: 'rapidd-api', clientSecret: 'rapidd-secret',
            }],
            jwt: { secret: 's'.repeat(40), refreshSecret: 'r'.repeat(40), accessExpiry: '15m', refreshExpiry: '7d' },
        });
        auth.setSessionStore(new SessionStoreManager({ store: 'memory', ttl: 3600 }));
        await app.register(authPlugin, { auth });
        app.get('/private', async (request) => ({ user: request.user }));
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        process.env = savedEnv;
    });

    it('accepts Keycloak access tokens; realm roles arrive as data (user.roles)', async () => {
        const { access_token } = await passwordGrant();
        const me = (await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${access_token}` } })).json();
        expect(me.user).toMatchObject({ username: 'alice', email: 'alice@example.com', provider: 'keycloak' });
        expect(me.user.roles).toContain('admin');
        expect(me.user).not.toHaveProperty('role');
        expect(me.user.id).toMatch(/^keycloak:/);

        const tampered = access_token.slice(0, -4) + 'AAAA';
        expect((await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${tampered}` } })).json().user).toBeNull();
    });

    it('rejects tokens from another realm', async () => {
        const response = await fetch('http://127.0.0.1:58080/realms/master/protocol/openid-connect/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }),
        });
        const { access_token } = await response.json() as { access_token: string };
        expect((await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${access_token}` } })).json().user).toBeNull();
    });

    it('browser login through the Keycloak login form → ticket → session (same roles as bearer)', async () => {
        const start = await app.inject({ method: 'GET', url: '/auth/keycloak/login?redirect=/after' });
        expect(start.statusCode).toBe(302);
        // One state cookie per sign-in, named after its state
        const stateCookie = start.cookies.find((c) => c.name.startsWith('rapidd_auth_state_'))!;
        const authorizeUrl = new URL(start.headers.location as string);
        expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://rapidd.test/auth/keycloak/callback');

        // A minimal cookie-jar "browser" at Keycloak
        const jar = new Map<string, string>();
        const browse = async (url: string, init: RequestInit = {}) => {
            const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
            for (const c of res.headers.getSetCookie()) {
                const [pair] = c.split(';');
                const i = pair.indexOf('=');
                jar.set(pair.slice(0, i), pair.slice(i + 1));
            }
            return res;
        };
        const html = await (await browse(authorizeUrl.toString())).text();
        const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&');
        const submitted = await browse(action, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'alice', password: 'alice-pass', credentialId: '' }),
        });
        expect(submitted.status).toBe(302);
        const callback = new URL(submitted.headers.get('location')!);
        expect(callback.origin + callback.pathname).toBe('http://rapidd.test/auth/keycloak/callback');

        const done = await app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}`, cookies: { [stateCookie.name]: stateCookie.value } });
        expect(done.statusCode).toBe(302);
        const landing = new URL(done.headers.location as string, 'http://rapidd.test');
        expect(landing.pathname).toBe('/after');

        const tokens = (await app.inject({ method: 'POST', url: '/auth/exchange', payload: { ticket: landing.searchParams.get('auth_ticket') } })).json();
        const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokens.accessToken}` } })).json();
        expect(me.user).toMatchObject({ username: 'alice' });
        expect(me.user.roles).toContain('admin'); // realm role from the ACCESS token

        // The callback is single-use
        const replay = await app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}`, cookies: { [stateCookie.name]: stateCookie.value } });
        expect(replay.headers.location).toMatch(/auth_error=auth_login_failed/);

        // Refresh, then logout ends the SSO session
        const refreshed = (await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: tokens.refreshToken } })).json();
        expect(refreshed.accessToken).toBeTruthy();
        await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${refreshed.accessToken}` } });
        expect((await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${refreshed.accessToken}` } })).json().user).toBeNull();
    });
});
