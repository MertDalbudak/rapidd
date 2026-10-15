/**
 * HTTP-level tests for the auth plugin: cookie sessions, logout/refresh transports,
 * the provider list, redirect validation, and complete OIDC and SAML browser logins against
 * (mock) identity providers.
 */
import bcrypt from 'bcrypt';

const mockRows: Array<Record<string, any>> = [];
const mockUsers = {
    findFirst: jest.fn(async ({ where }: any) => mockRows.find((r) =>
        (where.OR ? where.OR.some((w: any) => Object.entries(w).every(([k, v]) => r[k] === v)) : Object.entries(where).every(([k, v]) => r[k] === v))) ?? null),
    findMany: jest.fn(async ({ where }: any) => mockRows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))),
};

jest.mock('../../src/core/prisma', () => ({
    rlsActive: () => false,
    authPrisma: { users: mockUsers },
    prisma: {},
    dbProvider: 'mysql',
    getAcl: () => ({ model: {} }),
    requestContext: { run: jest.fn((_s: any, fn: any) => fn()) },
    rlsEnabled: false,
}));

jest.mock('../../src/core/dmmf', () => ({
    loadDMMF: jest.fn().mockResolvedValue({}),
    findUserModel: jest.fn(() => ({ name: 'users' })),
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => 'password'),
    getPrimaryKey: jest.fn(() => 'id'),
    getScalarFields: jest.fn(() => ({ id: {}, email: {}, password: {}, role: {} })),
    getDMMFSync: jest.fn(() => ({ datamodel: { models: [] } })),
    getModel: jest.fn(),
    getFields: jest.fn(() => ({})),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn(() => false),
    getRelationInfo: jest.fn(),
    buildRelationships: jest.fn(() => []),
}));

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import authPlugin from '../../src/plugins/auth';
import responsePlugin from '../../src/plugins/response';
import { Auth } from '../../src/auth/Auth';
import { SessionStoreManager } from '../../src/auth/stores';
import { startMockIdp, MockIdp } from '../helpers/mockIdp';
import { idpMetadata, readRequest, samlResponse } from '../helpers/samlIdp';
import type { AuthOptions } from '../../src/types';

const PASSWORD = 'pw-123456';

async function buildApp(authOptions: AuthOptions = {}, cookieSecret?: string): Promise<{ app: FastifyInstance; auth: Auth }> {
    const app = Fastify();
    await app.register(fastifyCookie, { secret: cookieSecret });
    await app.register(fastifyFormbody);
    await app.register(responsePlugin);
    const auth = new Auth({
        jwt: { secret: 's'.repeat(40), refreshSecret: 'r'.repeat(40), accessExpiry: '15m', refreshExpiry: '7d' },
        saltRounds: 4,
        ...authOptions,
    });
    auth.setSessionStore(new SessionStoreManager({ store: 'memory', ttl: 3600 }));
    await app.register(authPlugin, { auth });
    app.get('/private', async (request) => ({ user: request.user, sessionId: request.authSessionId }));
    await app.ready();
    return { app, auth };
}

/** Cookies from a response as a name → value map, plus the raw Set-Cookie headers */
function cookiesOf(response: { headers: Record<string, any> }) {
    const raw: string[] = [].concat(response.headers['set-cookie'] || []);
    const map: Record<string, string> = {};
    for (const line of raw) {
        const [pair] = line.split(';');
        const [name, ...value] = pair.split('=');
        map[name] = value.join('=');
    }
    return { map, raw };
}

/** The state cookie a redirect login set — one per sign-in, named after its state — as inject's `cookies` */
function stateCookieOf(response: { headers: Record<string, any> }): Record<string, string> {
    return Object.fromEntries(Object.entries(cookiesOf(response).map).filter(([name, value]) => name.startsWith('rapidd_auth_state_') && value));
}

beforeAll(async () => {
    mockRows.push({ id: 1, email: 'alice@example.com', password: await bcrypt.hash(PASSWORD, 4), role: 'admin' });
});

const savedEnv = { ...process.env };
afterEach(() => {
    process.env = { ...savedEnv };
});

describe('cookie sessions', () => {
    it('cookie-only mode: login sets access + refresh cookies and returns no tokens', async () => {
        const { app } = await buildApp({ strategies: ['cookie'], cookieDomain: '.example.com' }, 'cookie-secret');
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: PASSWORD } });

        expect(login.statusCode).toBe(200);
        expect(login.json()).toEqual({ user: { id: 1, email: 'alice@example.com', role: 'admin' } });
        const { map, raw } = cookiesOf(login);
        expect(map.token).toBeTruthy();
        expect(map.token_refresh).toBeTruthy();
        expect(raw.find(c => c.startsWith('token_refresh='))).toMatch(/Path=\/auth/);
        expect(raw.find(c => c.startsWith('token='))).toMatch(/HttpOnly/);

        // The signed cookie authenticates requests and identifies the session
        const me = await app.inject({ method: 'GET', url: '/private', cookies: { token: map.token } });
        expect(me.json().user.id).toBe(1);
        expect(me.json().sessionId).toEqual(expect.any(String));
        await app.close();
    });

    it('cookie-only mode: refresh works from the refresh cookie alone', async () => {
        const { app } = await buildApp({ strategies: ['cookie'] }, 'cookie-secret');
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: PASSWORD } });
        const { map } = cookiesOf(login);

        const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', cookies: { token_refresh: map.token_refresh } });
        expect(refresh.statusCode).toBe(200);
        expect(refresh.json()).toEqual({ message: 'refreshed' });
        expect(cookiesOf(refresh).map.token).toBeTruthy();
        await app.close();
    });

    it('logout revokes a cookie session server-side and clears cookies with their domain', async () => {
        const { app } = await buildApp({ strategies: ['cookie'], cookieDomain: '.example.com' }, 'cookie-secret');
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: PASSWORD } });
        const { map } = cookiesOf(login);

        const logout = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { token: map.token } });
        expect(logout.statusCode).toBe(200);
        const cleared = cookiesOf(logout).raw;
        expect(cleared.find(c => c.startsWith('token='))).toMatch(/Domain=\.example\.com/);
        expect(cleared.find(c => c.startsWith('token_refresh='))).toMatch(/Path=\/auth/);

        // A copy of the stolen cookie no longer works
        const replay = await app.inject({ method: 'GET', url: '/private', cookies: { token: map.token } });
        expect(replay.json().user).toBeNull();
        await app.close();
    });

    it('works without COOKIE_SECRET (no signing) instead of crashing', async () => {
        const { app } = await buildApp({ strategies: ['bearer', 'cookie'] });
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: PASSWORD } });
        expect(login.json().accessToken).toBeTruthy(); // not cookie-only → tokens in the body too
        const { map } = cookiesOf(login);
        const me = await app.inject({ method: 'GET', url: '/private', cookies: { token: map.token } });
        expect(me.statusCode).toBe(200);
        expect(me.json().user.id).toBe(1);
        await app.close();
    });

    it('signs cookies when a secret is configured, and ignores tampered ones', async () => {
        const { app } = await buildApp({ strategies: ['cookie'] }, 'cookie-secret');
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: PASSWORD } });
        const token = decodeURIComponent(cookiesOf(login).map.token);
        const [jwtPart, signature] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];
        expect(app.unsignCookie(token).valid).toBe(true);

        // Valid JWT, wrong cookie signature → rejected by the cookie layer
        const forged = `${jwtPart}.${signature.split('').reverse().join('')}`;
        const me = await app.inject({ method: 'GET', url: '/private', cookies: { token: forged } });
        expect(me.json().user).toBeNull();
        await app.close();
    });
});

describe('bearer sessions', () => {
    it('logout with only a refresh token revokes the session', async () => {
        const { app } = await buildApp();
        const { accessToken, refreshToken } = (await app.inject({
            method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: PASSWORD },
        })).json();

        await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });
        const me = await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${accessToken}` } });
        expect(me.json().user).toBeNull();
        await app.close();
    });

    it('answers wrong passwords with 401 invalid_credentials', async () => {
        const { app } = await buildApp();
        const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: 'nope' } });
        expect(res.statusCode).toBe(401);
        expect(res.json().key).toBe('invalid_credentials');
        await app.close();
    });

    it('lists providers', async () => {
        const { app } = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/auth/providers' });
        expect(res.json()).toEqual({ providers: [{ name: 'local', type: 'local', password: true, redirect: false }] });
        await app.close();
    });
});

describe('OIDC browser login', () => {
    let idp: MockIdp;

    beforeEach(async () => {
        idp = await startMockIdp();
    });

    afterEach(async () => {
        await idp.close();
    });

    const withIdp = (options: AuthOptions = {}) => buildApp({
        providers: [
            { type: 'local' },
            { type: 'oidc', name: 'idp', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
        ],
        ...options,
    });

    async function loginThroughIdp(app: FastifyInstance, redirect?: string) {
        const start = await app.inject({ method: 'GET', url: `/auth/idp/login${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ''}` });
        expect(start.statusCode).toBe(302);
        const stateCookie = stateCookieOf(start);
        expect(Object.keys(stateCookie)).toHaveLength(1);

        // The browser visits the IdP, which redirects back to our callback
        const atIdp = await fetch(start.headers.location as string, { redirect: 'manual' });
        const callback = new URL(atIdp.headers.get('location')!);
        expect(callback.pathname).toBe('/auth/idp/callback');

        return app.inject({
            method: 'GET',
            url: `${callback.pathname}${callback.search}`,
            cookies: stateCookie,
        });
    }

    it('logs in through the IdP and hands the SPA a single-use ticket', async () => {
        process.env.ALLOWED_ORIGINS = 'app.example.com';
        const { app } = await withIdp();

        const callback = await loginThroughIdp(app, 'https://app.example.com/after-login');
        expect(callback.statusCode).toBe(302);
        const landing = new URL(callback.headers.location as string);
        expect(landing.origin + landing.pathname).toBe('https://app.example.com/after-login');
        const ticket = landing.searchParams.get('auth_ticket')!;
        expect(ticket).toBeTruthy();

        const exchange = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { ticket } });
        expect(exchange.statusCode).toBe(200);
        const { user, accessToken } = exchange.json();
        expect(user).toEqual({ id: 1, email: 'alice@example.com', role: 'admin' }); // linked by email

        const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
        expect(me.json().user.id).toBe(1);

        const replay = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { ticket } });
        expect(replay.statusCode).toBe(400);
        await app.close();
    });

    it('two tabs signing in at once both land — each callback takes only its own state', async () => {
        const { app } = await withIdp();
        // Both begin in the same instant — neither request carries the other's cookie
        const [startA, startB] = await Promise.all([
            app.inject({ method: 'GET', url: '/auth/idp/login?redirect=/a' }),
            app.inject({ method: 'GET', url: '/auth/idp/login?redirect=/b' }),
        ]);
        // The browser keeps both cookies: one per sign-in
        const jar = { ...stateCookieOf(startA), ...stateCookieOf(startB) };
        expect(Object.keys(jar)).toHaveLength(2);
        const back = async (start: any) => new URL((await fetch(start.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
        const callbackA = await back(startA);
        const callbackB = await back(startB);

        const doneA = await app.inject({ method: 'GET', url: `${callbackA.pathname}${callbackA.search}`, cookies: jar });
        expect(new URL(doneA.headers.location as string, 'http://api.test').pathname).toBe('/a');
        const doneB = await app.inject({ method: 'GET', url: `${callbackB.pathname}${callbackB.search}`, cookies: jar });
        expect(new URL(doneB.headers.location as string, 'http://api.test').pathname).toBe('/b');
        expect(doneB.headers.location).toMatch(/auth_ticket=/);
        await app.close();
    });

    it('rejects a callback without the browser-bound state cookie (login CSRF)', async () => {
        const { app } = await withIdp();
        const start = await app.inject({ method: 'GET', url: '/auth/idp/login' });
        const atIdp = await fetch(start.headers.location as string, { redirect: 'manual' });
        const callback = new URL(atIdp.headers.get('location')!);

        const res = await app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}` });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/?auth_error=auth_login_failed');
        await app.close();
    });

    it('never redirects to foreign origins (open redirect)', async () => {
        process.env.ALLOWED_ORIGINS = '*'; // CORS wildcard must not open redirects
        const { app } = await withIdp();
        const callback = await loginThroughIdp(app, 'https://evil.example/steal');
        expect(callback.headers.location).toMatch(/^\/\?auth_ticket=/);
        await app.close();
    });

    it('accepts the IdP access token as a bearer token', async () => {
        const { app } = await withIdp();
        const res = await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${idp.sign({ email: 'alice@example.com' })}` } });
        expect(res.json().user).toMatchObject({ id: 1, email: 'alice@example.com' });
        expect(res.json().sessionId).toBeNull();
        await app.close();
    });

    it('404s for unknown providers', async () => {
        const { app } = await withIdp();
        const res = await app.inject({ method: 'GET', url: '/auth/nope/login' });
        expect(res.statusCode).toBe(404);
        await app.close();
    });

    describe('security review regressions', () => {
        it('cookie-only mode: a tab-smuggled redirect cannot leave the site', async () => {
            const { app } = await withIdp({ strategies: ['cookie'] });
            const callback = await loginThroughIdp(app, '/\t/evil.example/phish');
            expect(callback.headers.location).toBe('/');
            await app.close();
        });

        it('refuses Host-derived callback URLs in production', async () => {
            process.env.NODE_ENV = 'production';
            delete process.env.PUBLIC_URL;
            const { app } = await withIdp();
            const res = await app.inject({ method: 'GET', url: '/auth/idp/login', headers: { host: 'evil.example' } });
            expect(res.statusCode).toBe(500);
            expect(res.json().key).toBe('auth_not_configured');
            await app.close();
        });
    });
});

describe('SAML browser login', () => {
    const ACS = 'https://api.example.com/auth/saml/callback';
    const withSaml = (options: AuthOptions = {}) => {
        process.env.PUBLIC_URL = 'https://api.example.com';
        return buildApp({ providers: [{ type: 'local' }, { type: 'saml', idpMetadata: idpMetadata() }], ...options });
    };

    /** The login begun in a browser: the IdP's URL and the browser's state cookie */
    async function begin(app: FastifyInstance) {
        const start = await app.inject({ method: 'GET', url: '/auth/saml/login' });
        expect(start.statusCode).toBe(302);
        return { request: readRequest(start.headers.location as string), cookie: stateCookieOf(start) };
    }

    /** The IdP's form POST: cross-site — no cookies; its origin is the IdP's */
    const post = (app: FastifyInstance, SAMLResponse: string, RelayState: string) => app.inject({
        method: 'POST', url: '/auth/saml/callback',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example.com' },
        payload: new URLSearchParams({ SAMLResponse, RelayState }).toString(),
    });

    it('IdP → form POST → 303 to the GET callback, which carries the state cookie → ticket → the linked user', async () => {
        const { app } = await withSaml();
        const { request, cookie } = await begin(app);
        expect(request.acs).toBe(ACS);
        const SAMLResponse = await samlResponse({ inResponseTo: request.id, attributes: [['email', 'alice@example.com']] });

        const posted = await post(app, SAMLResponse, request.relayState);
        expect(posted.statusCode).toBe(303);
        const next = new URL(posted.headers.location as string);
        expect(next.origin + next.pathname).toBe(ACS);
        expect(next.searchParams.get('state')).toBe(request.relayState);

        const callback = await app.inject({ method: 'GET', url: `${next.pathname}${next.search}`, cookies: cookie });
        expect(callback.statusCode).toBe(302);
        const ticket = new URL(callback.headers.location as string, 'https://x').searchParams.get('auth_ticket')!;
        const exchange = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { ticket } });
        expect(exchange.json().user).toEqual({ id: 1, email: 'alice@example.com', role: 'admin' });

        // The same answer again: its request id is spent
        const replay = await post(app, SAMLResponse, request.relayState);
        expect(replay.headers.location).toBe('/?auth_error=auth_login_failed');
        await app.close();
    });

    it('an answer meant for another browser does not log this one in (login CSRF)', async () => {
        const { app } = await withSaml();
        const attacker = await begin(app);
        const victim = await begin(app);
        const attackersAnswer = await samlResponse({ inResponseTo: attacker.request.id, attributes: [['email', 'alice@example.com']] });

        // Posted under the victim's state — the request id is not the victim's
        const posted = await post(app, attackersAnswer, victim.request.relayState);
        const next = new URL(posted.headers.location as string);
        const res = await app.inject({ method: 'GET', url: `${next.pathname}${next.search}`, cookies: victim.cookie });
        expect(res.headers.location).toBe('/?auth_error=auth_login_failed');

        // Posted under the attacker's own state — the victim's browser lacks its cookie
        const own = await post(app, await samlResponse({ inResponseTo: (await begin(app)).request.id }), attacker.request.relayState);
        expect(own.statusCode).toBe(303);
        await app.close();
    });

    it('a parked answer is taken once, with the state it was parked for', async () => {
        const { app } = await withSaml();
        const { request, cookie } = await begin(app);
        const posted = await post(app, await samlResponse({ inResponseTo: request.id }), request.relayState);
        const next = new URL(posted.headers.location as string);
        const forged = new URL(next);
        forged.searchParams.set('response', 'not-the-key');
        const bad = await app.inject({ method: 'GET', url: `${forged.pathname}${forged.search}`, cookies: cookie });
        expect(bad.headers.location).toBe('/?auth_error=auth_login_failed');
        await app.close();
    });

    it('serves this API\'s metadata; the provider list offers the login', async () => {
        const { app } = await withSaml();
        const metadata = await app.inject({ method: 'GET', url: '/auth/saml/metadata' });
        expect(metadata.statusCode).toBe(200);
        expect(metadata.headers['content-type']).toMatch(/^application\/samlmetadata\+xml/);
        expect(metadata.body).toContain('entityID="https://api.example.com/auth/saml/metadata"');
        expect(metadata.body).toContain(`Location="${ACS}"`);
        expect((await app.inject({ method: 'GET', url: '/auth/local/metadata' })).statusCode).toBe(404);
        const providers = (await app.inject({ method: 'GET', url: '/auth/providers' })).json().providers;
        expect(providers).toContainEqual({ name: 'saml', type: 'saml', password: false, redirect: true, loginUrl: '/auth/saml/login' });
        await app.close();
    });
});

describe('cookie secret edge cases', () => {
    it('an empty COOKIE_SECRET falls back to unsigned cookies instead of failing every request', async () => {
        const { app } = await buildApp({ strategies: ['cookie'] }, '');
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'alice@example.com', password: PASSWORD } });
        expect(login.statusCode).toBe(200);
        const me = await app.inject({ method: 'GET', url: '/private', cookies: { token: cookiesOf(login).map.token } });
        expect(me.json().user.id).toBe(1);
        await app.close();
    });
});
