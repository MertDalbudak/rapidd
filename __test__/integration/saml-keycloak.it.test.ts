/**
 * SAML 2.0 against a real Keycloak 26: its metadata, the sign-in through Keycloak's own login
 * form, its signed answer posted to the callback — and the user it becomes. Keycloak signs the
 * response (not the assertion) by default; a second client signs only the assertion.
 * Opt-in: `bash __test__/integration/setup.sh && RAPIDD_IT=1 npx jest __test__/integration/saml --forceExit`
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
    findUserModel: jest.fn(() => null), // no user table: users come from the assertion
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
import fastifyFormbody from '@fastify/formbody';
import authPlugin from '../../src/plugins/auth';
import responsePlugin from '../../src/plugins/response';
import { Auth } from '../../src/auth/Auth';
import { SessionStoreManager } from '../../src/auth/stores';

const run = process.env.RAPIDD_IT === '1' ? describe : describe.skip;
jest.setTimeout(60000);

const KEYCLOAK = 'http://127.0.0.1:58080';
const REALM = `${KEYCLOAK}/realms/corp`;
const API = 'http://rapidd.test';

async function adminToken(): Promise<string> {
    const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }),
    });
    return ((await response.json()) as { access_token: string }).access_token;
}

/** A SAML client in Keycloak for this API, as an administrator would register it */
async function samlClient(name: string, signAssertion: boolean): Promise<void> {
    const token = await adminToken();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const clientId = `${API}/auth/${name}/metadata`;
    const existing = (await (await fetch(`${KEYCLOAK}/admin/realms/corp/clients?clientId=${encodeURIComponent(clientId)}`, { headers })).json()) as { id: string }[];
    for (const c of existing) await fetch(`${KEYCLOAK}/admin/realms/corp/clients/${c.id}`, { method: 'DELETE', headers });
    const created = await fetch(`${KEYCLOAK}/admin/realms/corp/clients`, {
        method: 'POST', headers,
        body: JSON.stringify({
            clientId, protocol: 'saml', enabled: true, redirectUris: [`${API}/*`],
            attributes: {
                'saml.server.signature': signAssertion ? 'false' : 'true',
                'saml.assertion.signature': signAssertion ? 'true' : 'false',
                'saml.client.signature': 'false',
                'saml.signature.algorithm': 'RSA_SHA256',
                saml_force_name_id_format: 'true',
                saml_name_id_format: 'username',
                saml_assertion_consumer_url_post: `${API}/auth/${name}/callback`,
            },
            protocolMappers: [
                { name: 'email', protocol: 'saml', protocolMapper: 'saml-user-property-mapper', config: { 'user.attribute': 'email', 'attribute.name': 'email', 'attribute.nameformat': 'Basic' } },
                { name: 'first name', protocol: 'saml', protocolMapper: 'saml-user-property-mapper', config: { 'user.attribute': 'firstName', 'attribute.name': 'givenName', 'attribute.nameformat': 'Basic' } },
                { name: 'last name', protocol: 'saml', protocolMapper: 'saml-user-property-mapper', config: { 'user.attribute': 'lastName', 'attribute.name': 'sn', 'attribute.nameformat': 'Basic' } },
            ],
        }),
    });
    if (created.status !== 201) throw new Error(`Keycloak client: ${created.status} ${await created.text()}`);
}

/** A minimal cookie-jar browser at Keycloak */
function browser() {
    const jar = new Map<string, string>();
    return async (url: string, init: RequestInit = {}) => {
        const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(';');
            const i = pair.indexOf('=');
            jar.set(pair.slice(0, i), pair.slice(i + 1));
        }
        return res;
    };
}

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#x3D;/gi, '=').replace(/&#x2B;/gi, '+').replace(/&quot;/g, '"');

run('SAML ↔ Keycloak 26', () => {
    let app: FastifyInstance;
    const savedEnv = { ...process.env };

    beforeAll(async () => {
        process.env.PUBLIC_URL = API;
        await samlClient('keycloak', false);
        await samlClient('keycloak-assertion', true);
        app = Fastify();
        await app.register(fastifyCookie, { secret: 'cookie-secret-1234567890' });
        await app.register(fastifyFormbody);
        await app.register(responsePlugin);
        const auth = new Auth({
            providers: [
                { type: 'saml', name: 'keycloak', idpMetadataUrl: `${REALM}/protocol/saml/descriptor` },
                { type: 'saml', name: 'keycloak-assertion', idpMetadataUrl: `${REALM}/protocol/saml/descriptor`, wantAssertionsSigned: true },
            ],
            jwt: { secret: 's'.repeat(40), refreshSecret: 'r'.repeat(40), accessExpiry: '15m', refreshExpiry: '7d' },
        });
        auth.setSessionStore(new SessionStoreManager({ store: 'memory', ttl: 3600 }));
        await app.register(authPlugin, { auth });
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        process.env = savedEnv;
    });

    /** Sign in at Keycloak's form; its answer is a page that posts SAMLResponse + RelayState to the callback */
    async function signIn(provider: string) {
        const start = await app.inject({ method: 'GET', url: `/auth/${provider}/login?redirect=/after` });
        expect(start.statusCode).toBe(302);
        // One state cookie per sign-in, named after its state
        const stateCookie = start.cookies.find((c) => c.name.startsWith('rapidd_auth_state_'))!;
        expect(start.headers.location).toMatch(new RegExp(`^${REALM}/protocol/saml\\?SAMLRequest=`));

        const browse = browser();
        const form = await (await browse(start.headers.location as string)).text();
        const action = unescape(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(form)![1]);
        const answer = await (await browse(action, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'alice', password: 'alice-pass', credentialId: '' }),
        })).text();
        const target = unescape(/<form[^>]*action="([^"]+)"/.exec(answer)![1]);
        const field = (name: string) => unescape(new RegExp(`name="${name}"\\s+value="([^"]*)"`, "i").exec(answer)![1]);
        expect(target).toBe(`${API}/auth/${provider}/callback`);
        return { stateCookie: { [stateCookie.name]: stateCookie.value }, SAMLResponse: field('SAMLResponse'), RelayState: field('RelayState') };
    }

    async function finish(provider: string, answer: { stateCookie: Record<string, string>; SAMLResponse: string; RelayState: string }) {
        // Keycloak's page posts it — cross-site, so without our cookies
        const posted = await app.inject({
            method: 'POST', url: `/auth/${provider}/callback`,
            headers: { 'content-type': 'application/x-www-form-urlencoded', origin: KEYCLOAK },
            payload: new URLSearchParams({ SAMLResponse: answer.SAMLResponse, RelayState: answer.RelayState }).toString(),
        });
        expect(posted.statusCode).toBe(303);
        const next = new URL(posted.headers.location as string, API);
        if (next.pathname !== `/auth/${provider}/callback`) return { posted, done: null };
        const done = await app.inject({ method: 'GET', url: `${next.pathname}${next.search}`, cookies: answer.stateCookie });
        return { posted, done };
    }

    it('Keycloak\'s metadata; sign-in through its form → signed response → ticket → the user from the assertion', async () => {
        const answer = await signIn('keycloak');
        const { done } = await finish('keycloak', answer);
        expect(done!.statusCode).toBe(302);
        const landing = new URL(done!.headers.location as string, API);
        expect(landing.pathname).toBe('/after');

        const tokens = (await app.inject({ method: 'POST', url: '/auth/exchange', payload: { ticket: landing.searchParams.get('auth_ticket') } })).json();
        const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokens.accessToken}` } })).json();
        expect(me.user).toMatchObject({ id: 'keycloak:alice', email: 'alice@example.com', name: 'Alice Doe', provider: 'keycloak' });
        // Keycloak's role list: realm roles as repeated Role attributes
        expect(me.user.roles).toContain('admin');

        // Posted again: the request id is spent
        const replay = await finish('keycloak', answer);
        expect(replay.posted.headers.location).toMatch(/auth_error=auth_login_failed/);
    });

    it('a client that signs only the assertion — required by the provider — signs in too', async () => {
        const { done } = await finish('keycloak-assertion', await signIn('keycloak-assertion'));
        expect(done!.headers.location).toMatch(/^\/after\?auth_ticket=/);
    });

    it('this API\'s metadata as Keycloak imports it', async () => {
        const metadata = await app.inject({ method: 'GET', url: '/auth/keycloak/metadata' });
        const token = await adminToken();
        const converted = await fetch(`${KEYCLOAK}/admin/realms/corp/client-description-converter`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/xml' }, body: metadata.body,
        });
        expect(converted.status).toBe(200);
        const client = await converted.json() as { clientId: string; protocol: string; attributes: Record<string, string> };
        expect(client).toMatchObject({ clientId: `${API}/auth/keycloak/metadata`, protocol: 'saml' });
        expect(client.attributes.saml_assertion_consumer_url_post).toBe(`${API}/auth/keycloak/callback`);
    });
});
