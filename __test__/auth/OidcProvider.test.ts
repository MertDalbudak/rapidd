import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OidcProvider } from '../../src/auth/providers/OidcProvider';
import { startMockIdp, MockIdp } from '../helpers/mockIdp';

describe('OidcProvider', () => {
    let idp: MockIdp;

    beforeEach(async () => {
        idp = await startMockIdp();
    });

    afterEach(async () => {
        await idp.close();
    });

    const provider = (overrides: Record<string, unknown> = {}) => new OidcProvider({
        type: 'oidc',
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        ...overrides,
    } as any);

    describe('configuration', () => {
        it('requires an issuer or explicit endpoints', () => {
            expect(() => new OidcProvider({ type: 'oidc' } as any)).toThrow(/issuer/);
        });

        it('never accepts symmetric algorithms, even when configured', async () => {
            const p = provider({ algorithms: ['HS256', 'RS256', 'none'] });
            const hs = jwt.sign({ iss: idp.issuer, aud: idp.clientId, sub: 'x' }, 'shared-secret', { algorithm: 'HS256' });
            expect(await p.verifyToken(hs)).toBeNull();
        });

        it('initialize() swallows an IdP outage', async () => {
            idp.down = true;
            await expect(provider().initialize()).resolves.toBeUndefined();
        });
    });

    describe('bearer tokens (resource server)', () => {
        it('accepts a valid access token and maps its claims', async () => {
            const identity = await provider().verifyToken(idp.sign({
                email: 'alice@example.com', name: 'Alice', roles: ['Writer'], groups: ['Staff'],
            }));
            expect(identity).toMatchObject({
                provider: 'oidc', subject: 'user-123', email: 'alice@example.com', name: 'Alice',
                roles: ['Writer'], groups: ['Staff'],
            });
        });

        it('claims tokens by issuer only', () => {
            const p = provider();
            expect(p.ownsToken('t', { iss: idp.issuer })).toBe(true);
            expect(p.ownsToken('t', { iss: 'https://other' })).toBe(false);
            expect(p.ownsToken('t', null)).toBe(false); // opaque, no introspection
        });

        it.each([
            ['wrong audience', { aud: 'someone-else' }, {}],
            ['wrong issuer', { iss: 'https://evil.example' }, {}],
            ['expired', {}, { expiresIn: -3600 }],
        ])('rejects a token with %s', async (_label, claims, options) => {
            expect(await provider().verifyToken(idp.sign(claims, options))).toBeNull();
        });

        it('rejects a token signed by an unknown key', async () => {
            const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
            expect(await provider().verifyToken(idp.sign({}, { key: privateKey }))).toBeNull();
        });

        it('rejects unsigned (alg: none) tokens', async () => {
            const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
            const payload = Buffer.from(JSON.stringify({ iss: idp.issuer, aud: idp.clientId, sub: 'x', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
            expect(await provider().verifyToken(`${header}.${payload}.`)).toBeNull();
        });

        it('honours a custom audience', async () => {
            const p = provider({ audience: 'api://orders' });
            expect(await p.verifyToken(idp.sign({ aud: 'api://orders' }))).not.toBeNull();
            expect(await p.verifyToken(idp.sign())).toBeNull(); // aud = clientId no longer accepted
        });

        it('enforces required scopes (scp string or scope)', async () => {
            const p = provider({ requiredScopes: ['orders.read'] });
            expect(await p.verifyToken(idp.sign({ scp: 'profile orders.read' }))).not.toBeNull();
            expect(await p.verifyToken(idp.sign({ scope: 'orders.read' }))).not.toBeNull();
            expect(await p.verifyToken(idp.sign({ scp: 'profile' }))).toBeNull();
        });

        it('uses subjectClaim as the stable id (Entra oid)', async () => {
            const identity = await provider({ subjectClaim: 'oid' }).verifyToken(idp.sign({ oid: 'object-id-1' }));
            expect(identity!.subject).toBe('object-id-1');
        });

        it('drops an email the IdP marks unverified', async () => {
            const identity = await provider().verifyToken(idp.sign({ email: 'x@example.com', email_verified: false }));
            expect(identity!.email).toBeUndefined();
        });

        it('collects Keycloak realm and client roles', async () => {
            const identity = await provider().verifyToken(idp.sign({
                realm_access: { roles: ['admin'] },
                resource_access: { [idp.clientId]: { roles: ['editor'] }, other: { roles: ['nope'] } },
            }));
            expect(identity!.roles.sort()).toEqual(['admin', 'editor']);
        });

        it('caches signing keys and refetches on rotation', async () => {
            const p = provider();
            await p.verifyToken(idp.sign());
            await p.verifyToken(idp.sign());
            expect(idp.hits['/jwks']).toBe(1);

            idp.rotateKeys();
            // Unknown kid → refetch, but rate-limited: the first fetch was just now
            expect(await p.verifyToken(idp.sign())).toBeNull();
            expect(idp.hits['/jwks']).toBe(1);

            // Once the cooldown passed, an unknown kid triggers exactly one refetch
            (p as any).keysFetchedAt = Date.now() - 31_000;
            expect(await p.verifyToken(idp.sign())).not.toBeNull();
            expect(idp.hits['/jwks']).toBe(2);
        });

        it('verifies kid-less tokens against all keys of the right type', async () => {
            expect(await provider().verifyToken(idp.sign({}, { kid: null }))).not.toBeNull();
        });

        it('rejects bearer tokens when no audience is known', async () => {
            const p = new OidcProvider({ type: 'oidc', issuer: idp.issuer } as any);
            expect(await p.verifyToken(idp.sign())).toBeNull();
        });

        it('fails discovery when the document reports another issuer', async () => {
            idp.reportedIssuer = 'https://impostor.example';
            expect(await provider().verifyToken(idp.sign())).toBeNull();
        });
    });

    describe('opaque tokens (introspection)', () => {
        it('introspects and caches active tokens', async () => {
            idp.opaqueTokens.set('opaque-1', { sub: 'svc-1', aud: idp.clientId, exp: Math.floor(Date.now() / 1000) + 600 });
            const p = provider({ introspection: true });
            expect(p.ownsToken('opaque-1', null)).toBe(true);
            expect((await p.verifyToken('opaque-1'))!.subject).toBe('svc-1');
            await p.verifyToken('opaque-1');
            expect(idp.hits['/introspect']).toBe(1);
        });

        it('rejects inactive tokens and foreign audiences', async () => {
            idp.opaqueTokens.set('foreign', { sub: 'svc-1', aud: 'another-api' });
            const p = provider({ introspection: true });
            expect(await p.verifyToken('unknown')).toBeNull();
            expect(await p.verifyToken('foreign')).toBeNull();
        });

        it('ignores opaque tokens without introspection', async () => {
            expect(await provider().verifyToken('opaque-1')).toBeNull();
        });
    });

    describe('redirect login (authorization code + PKCE)', () => {
        async function runLogin(p: OidcProvider, mutate?: (query: URLSearchParams) => void) {
            const redirectUri = 'http://app.test/auth/oidc/callback';
            const { url, state, flow } = await p.beginLogin({ redirectUri });
            // Follow the IdP's authorize redirect without a browser
            const response = await fetch(url, { redirect: 'manual' });
            const back = new URL(response.headers.get('location')!);
            mutate?.(back.searchParams);
            return { state, back, identity: p.completeLogin(Object.fromEntries(back.searchParams), flow) };
        }

        it('builds a PKCE authorization request', async () => {
            const { url, state, flow } = await provider({ scopes: ['openid', 'email'], authorizationParams: { prompt: 'login' } })
                .beginLogin({ redirectUri: 'http://app.test/cb' });
            const params = new URL(url).searchParams;
            expect(params.get('response_type')).toBe('code');
            expect(params.get('client_id')).toBe(idp.clientId);
            expect(params.get('state')).toBe(state);
            expect(params.get('code_challenge_method')).toBe('S256');
            expect(params.get('code_challenge')).toBe(
                crypto.createHash('sha256').update(String(flow.verifier)).digest('base64url'));
            expect(params.get('scope')).toBe('openid email');
            expect(params.get('prompt')).toBe('login');
            expect(params.get('nonce')).toBe(flow.nonce);
        });

        it('completes a login and validates the id_token', async () => {
            const { identity } = await runLogin(provider());
            await expect(identity).resolves.toMatchObject({
                subject: 'user-123', email: 'alice@example.com', username: 'alice', groups: ['Staff'],
            });
        });

        it('merges roles that only the access token carries (Keycloak realm roles)', async () => {
            idp.accessRoles = ['admin'];
            const { identity } = await runLogin(provider());
            expect((await identity).roles).toEqual(['admin']);
        });

        it('rejects an id_token with the wrong nonce', async () => {
            idp.badNonce = true;
            const { identity } = await runLogin(provider());
            await expect(identity).rejects.toMatchObject({ status_code: 401, message: 'auth_login_failed' });
        });

        it('rejects a code replayed with a different verifier', async () => {
            const p = provider();
            const { back, identity } = await runLogin(p);
            await expect(identity).resolves.toBeTruthy(); // the legitimate exchange consumes the code
            // Fresh flow (new verifier) presenting the old code
            const other = await p.beginLogin({ redirectUri: 'http://app.test/auth/oidc/callback' });
            await expect(p.completeLogin(Object.fromEntries(back.searchParams), other.flow))
                .rejects.toMatchObject({ status_code: 401 });
        });

        it('surfaces IdP errors as a failed login', async () => {
            const p = provider();
            const { flow } = await p.beginLogin({ redirectUri: 'http://app.test/cb' });
            await expect(p.completeLogin({ error: 'access_denied' }, flow)).rejects.toMatchObject({ status_code: 401 });
        });

        it('maps an IdP outage during code exchange to 503', async () => {
            const p = provider();
            const { flow } = await p.beginLogin({ redirectUri: 'http://app.test/cb' });
            idp.down = true;
            await expect(p.completeLogin({ code: 'x' }, flow)).rejects.toMatchObject({ status_code: 503 });
        });

        it('is disabled without a client id', async () => {
            const p = new OidcProvider({ type: 'oidc', issuer: idp.issuer, audience: 'api' } as any);
            expect(p.loginEnabled).toBe(false);
            await expect(p.beginLogin({ redirectUri: 'x' })).rejects.toMatchObject({ status_code: 404 });
        });
    });

    describe('security review regressions', () => {
        it('rejects id_tokens presented as bearer tokens', async () => {
            expect(await provider().verifyToken(idp.sign({ typ: 'ID', nonce: 'n' }))).toBeNull();      // Keycloak
            expect(await provider().verifyToken(idp.sign({ token_use: 'id' }))).toBeNull();           // Cognito
        });

        it('accepts audience-less introspected tokens only when issued to our own client', async () => {
            const exp = Math.floor(Date.now() / 1000) + 600;
            idp.opaqueTokens.set('foreign', { sub: 'u-9', client_id: 'some-other-client', exp });
            idp.opaqueTokens.set('ours', { sub: 'u-1', client_id: idp.clientId, exp });
            const p = provider({ introspection: true });
            expect(await p.verifyToken('foreign')).toBeNull();
            expect((await p.verifyToken('ours'))!.subject).toBe('u-1');
        });

        it('treats email_verified "false" (string) as unverified', async () => {
            const identity = await provider().verifyToken(idp.sign({ email: 'x@example.com', email_verified: 'false' }));
            expect(identity!.email).toBeUndefined();
        });
    });
});
