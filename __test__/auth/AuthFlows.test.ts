/**
 * End-to-end Auth flows on a real (in-memory) session store and a fake user table:
 * sessions, refresh rotation + reuse detection, revocation, hooks, provider chains,
 * external bearer tokens, redirect login and login tickets.
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const mockRows: Array<Record<string, any>> = [];

function mockMatches(row: Record<string, any>, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'OR') return (value as any[]).some((w) => mockMatches(row, w));
        if (value && typeof value === 'object') return String(row[key]).toLowerCase() === String(value.equals).toLowerCase();
        return row[key] === value;
    });
}

const mockUsers = {
    findFirst: jest.fn(async ({ where }: any) => mockRows.find((r) => mockMatches(r, where)) ?? null),
    findMany: jest.fn(async ({ where }: any) => mockRows.filter((r) => mockMatches(r, where))),
    create: jest.fn(async ({ data }: any) => {
        const row = { id: mockRows.length + 100, ...data };
        mockRows.push(row);
        return row;
    }),
};

jest.mock('../../src/core/prisma', () => ({
    rlsActive: () => false,
    authPrisma: { users: mockUsers },
    prisma: {},
    dbProvider: 'mysql',
    getAcl: () => ({ model: {} }),
}));

jest.mock('../../src/core/dmmf', () => ({
    loadDMMF: jest.fn().mockResolvedValue({}),
    findUserModel: jest.fn(() => ({ name: 'users' })),
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => 'password'),
    getPrimaryKey: jest.fn(() => 'id'),
    getScalarFields: jest.fn(() => ({ id: {}, email: {}, password: {}, role: {}, status: {} })),
}));

import { Auth } from '../../src/auth/Auth';
import { SessionStoreManager } from '../../src/auth/stores';
import { ErrorResponse } from '../../src/core/errors';
import type { AuthOptions, AuthProvider, ExternalIdentity } from '../../src/types';

const PASSWORD = 'correct horse';
let hash: string;

beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
});

const stores: SessionStoreManager[] = [];

async function makeAuth(options: AuthOptions = {}): Promise<Auth> {
    const auth = new Auth({
        jwt: { secret: 'a'.repeat(40), refreshSecret: 'b'.repeat(40), accessExpiry: '15m', refreshExpiry: '7d' },
        saltRounds: 4,
        ...options,
    });
    const store = new SessionStoreManager({ store: 'memory', ttl: 3600, indexTtl: 7 * 86400 });
    stores.push(store);
    auth.setSessionStore(store);
    await auth.initialize();
    return auth;
}

beforeEach(() => {
    mockRows.length = 0;
    mockRows.push(
        { id: 1, email: 'alice@example.com', password: hash, role: 'admin', status: 'active' },
        { id: 2, email: 'bob@example.com', password: hash, role: 'user', status: 'active' },
    );
    jest.clearAllMocks();
});

afterAll(async () => {
    await Promise.all(stores.map((s) => s.destroy()));
});

const decode = (token: string) => jwt.decode(token) as Record<string, any>;

describe('sessions', () => {
    it('logs in locally and authenticates the access token', async () => {
        const auth = await makeAuth();
        const { user, accessToken, refreshToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });

        expect(user).toEqual({ id: 1, email: 'alice@example.com', role: 'admin', status: 'active' });
        expect(decode(refreshToken)).toMatchObject({ type: 'refresh', sub: 1 });
        expect(decode(refreshToken).sid).toBe(decode(accessToken).sessionId);

        const authenticated = await auth.authenticateToken(accessToken);
        expect(authenticated).toEqual({ user, sessionId: decode(accessToken).sessionId });
    });

    it('spends a bcrypt comparison on unknown users (no timing oracle)', async () => {
        const auth = await makeAuth();
        const compare = jest.spyOn(bcrypt, 'compare');
        await expect(auth.login({ user: 'ghost@example.com', password: 'x' })).rejects.toMatchObject({ status_code: 401 });
        expect(compare).toHaveBeenCalledTimes(1);
        compare.mockRestore();
    });

    it('rotates refresh tokens and detects reuse', async () => {
        const auth = await makeAuth();
        const first = await auth.login({ user: 'alice@example.com', password: PASSWORD });

        const second = await auth.refresh({ refreshToken: first.refreshToken });
        expect(decode(second.refreshToken).jti).not.toBe(decode(first.refreshToken).jti);
        expect(await auth.authenticateToken(second.accessToken)).not.toBeNull();

        // The rotated-away token comes back after the grace window → stolen: revoke all
        const record = await auth.getSessionStore().get(`rt:${decode(first.refreshToken).sid}`);
        await auth.getSessionStore().create(`rt:${decode(first.refreshToken).sid}`, { ...record, rotatedAt: Date.now() - 60_000 });
        await expect(auth.refresh({ refreshToken: first.refreshToken })).rejects.toMatchObject({ status_code: 401, message: 'invalid_refresh_token' });

        expect(await auth.authenticateToken(second.accessToken)).toBeNull();
        await expect(auth.refresh({ refreshToken: second.refreshToken })).rejects.toMatchObject({ status_code: 401 });
    });

    it('tolerates concurrent refreshes of the same token (two tabs)', async () => {
        const auth = await makeAuth();
        const { refreshToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });

        const [a, b] = await Promise.all([
            auth.refresh({ refreshToken }),
            auth.refresh({ refreshToken }),
        ]);
        // Both tabs converge on the same successor in the chain
        expect(decode(a.refreshToken).jti).toBe(decode(b.refreshToken).jti);

        const late = await auth.refresh({ refreshToken }); // within the grace window
        expect(decode(late.refreshToken).jti).toBe(decode(a.refreshToken).jti);
        await expect(auth.refresh({ refreshToken: b.refreshToken })).resolves.toBeTruthy();
    });

    it('re-reads persisted users on refresh', async () => {
        const auth = await makeAuth();
        const { refreshToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        mockRows[0].role = 'user';

        const refreshed = await auth.refresh({ refreshToken });
        expect((await auth.authenticateToken(refreshed.accessToken))!.user.role).toBe('user');
    });

    it('revokes the session when the user was deleted', async () => {
        const auth = await makeAuth();
        const { refreshToken, accessToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        mockRows.splice(0, 1);

        await expect(auth.refresh({ refreshToken })).rejects.toMatchObject({ status_code: 401, message: 'user_not_found' });
        expect(await auth.authenticateToken(accessToken)).toBeNull();
    });

    it('enforces an absolute session lifetime', async () => {
        const auth = await makeAuth({ session: { maxAge: 3600 } } as any);
        const { refreshToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        const key = `rt:${decode(refreshToken).sid}`;
        const record = await auth.getSessionStore().get(key);
        await auth.getSessionStore().create(key, { ...record, createdAt: Date.now() - 2 * 3600_000 });

        await expect(auth.refresh({ refreshToken })).rejects.toMatchObject({ message: 'session_expired' });
    });

    it('still accepts legacy (unbound) refresh tokens', async () => {
        const auth = await makeAuth();
        const legacy = auth.generateRefreshToken({ id: 2 });
        const refreshed = await auth.refresh({ refreshToken: legacy });
        expect(decode(refreshed.refreshToken).sid).toBeDefined();
        expect((await auth.authenticateToken(refreshed.accessToken))!.user.id).toBe(2);
    });

    it('revokes one session, or all sessions of a user', async () => {
        const auth = await makeAuth();
        const a1 = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        const a2 = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        const b1 = await auth.login({ user: 'bob@example.com', password: PASSWORD });

        await auth.revokeSession(decode(a1.accessToken).sessionId);
        expect(await auth.authenticateToken(a1.accessToken)).toBeNull();
        await expect(auth.refresh({ refreshToken: a1.refreshToken })).rejects.toBeInstanceOf(ErrorResponse);
        expect(await auth.authenticateToken(a2.accessToken)).not.toBeNull();

        expect(await auth.revokeUserSessions(1)).toBe(2); // a2's session + refresh chain
        expect(await auth.authenticateToken(a2.accessToken)).toBeNull();
        await expect(auth.refresh({ refreshToken: a2.refreshToken })).rejects.toBeInstanceOf(ErrorResponse);
        expect(await auth.authenticateToken(b1.accessToken)).not.toBeNull();
    });

    it('reports stores that cannot revoke by user', async () => {
        const auth = await makeAuth();
        auth.setSessionStore({ create: jest.fn(), get: jest.fn(), delete: jest.fn(), refresh: jest.fn(), isHealthy: jest.fn() } as any);
        await expect(auth.revokeUserSessions(1)).rejects.toThrow(/does not support/);
    });

    it('revokes via the refresh token alone (clients whose access token expired)', async () => {
        const auth = await makeAuth();
        const { accessToken, refreshToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        await auth.revokeRefreshToken(refreshToken);
        expect(await auth.authenticateToken(accessToken)).toBeNull();
    });
});

describe('hooks', () => {
    it('validateUser gates login (false → 403 account_inactive, thrown errors pass through)', async () => {
        mockRows[1].status = 'invited';
        const auth = await makeAuth({
            validateUser: (user) => {
                if (user.status === 'invited') throw new ErrorResponse(403, 'account_not_activated');
                return user.status === 'active';
            },
        });
        await expect(auth.login({ user: 'bob@example.com', password: PASSWORD })).rejects.toMatchObject({ message: 'account_not_activated' });
        mockRows[1].status = 'banned';
        await expect(auth.login({ user: 'bob@example.com', password: PASSWORD })).rejects.toMatchObject({ status_code: 403, message: 'account_inactive' });
    });

    it('validateUser gates refresh and revokes the session', async () => {
        const auth = await makeAuth({ validateUser: (user) => user.status === 'active' });
        const { refreshToken, accessToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        mockRows[0].status = 'disabled';

        await expect(auth.refresh({ refreshToken })).rejects.toMatchObject({ status_code: 403 });
        expect(await auth.authenticateToken(accessToken)).toBeNull();
    });

    it('onLogin runs after login and never breaks it', async () => {
        const onLogin = jest.fn(async () => { throw new Error('audit db down'); });
        const auth = await makeAuth({ onLogin });
        await expect(auth.login({ user: 'alice@example.com', password: PASSWORD })).resolves.toBeTruthy();
        expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.objectContaining({ event: 'login', provider: 'local' }));
    });
});

describe('provider chains', () => {
    const passwordProvider = (name: string, behaviour: () => Promise<ExternalIdentity | null>): AuthProvider => ({
        name, type: 'custom', authenticate: jest.fn(behaviour),
    });
    const identityFor = (provider: string, email: string): ExternalIdentity => ({
        provider, subject: email, email, groups: [], roles: [], claims: {},
    });

    it('tries providers in order; an outage of one does not block the next', async () => {
        const down = passwordProvider('ldap', async () => { throw new ErrorResponse(503, 'auth_provider_unavailable'); });
        const auth = await makeAuth({ providers: [down, { type: 'local' }] });
        const result = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        expect(result.user.id).toBe(1);
    });

    it('reports 503 (not 401) when nobody accepted and a provider was down', async () => {
        const down = passwordProvider('ldap', async () => { throw new ErrorResponse(503, 'auth_provider_unavailable'); });
        const auth = await makeAuth({ providers: [down, { type: 'local' }] });
        await expect(auth.login({ user: 'alice@example.com', password: 'wrong' })).rejects.toMatchObject({ status_code: 503 });
    });

    it('links external identities to user-table rows', async () => {
        const ldap = passwordProvider('ldap', async () => identityFor('ldap', 'BOB@example.com'));
        const auth = await makeAuth({ providers: [ldap] });
        // MySQL compares case-sensitively here only because the fake table does; the
        // real lookup is case-insensitive on PostgreSQL (mode: insensitive)
        mockRows[1].email = 'BOB@example.com';
        const result = await auth.login({ user: 'bob', password: 'dir-pass' });
        expect(result.user.id).toBe(2);
    });

    it('rejects external identities that link to nobody', async () => {
        const ldap = passwordProvider('ldap', async () => identityFor('ldap', 'nobody@example.com'));
        const auth = await makeAuth({ providers: [ldap] });
        await expect(auth.login({ user: 'nobody', password: 'x' })).rejects.toMatchObject({ status_code: 401, message: 'account_not_linked' });
    });

    it('lets the client pick a provider, and 400s on unknown ones', async () => {
        const ldap = passwordProvider('ldap', async () => null);
        const auth = await makeAuth({ providers: [ldap, { type: 'local' }] });
        await expect(auth.login({ user: 'alice@example.com', password: PASSWORD, provider: 'ldap' })).rejects.toMatchObject({ status_code: 401 });
        await expect(auth.login({ user: 'alice@example.com', password: PASSWORD, provider: 'local' })).resolves.toBeTruthy();
        await expect(auth.login({ user: 'a', password: 'b', provider: 'nope' })).rejects.toMatchObject({ status_code: 400, message: 'auth_provider_not_found' });
    });

    it('rejects duplicate or URL-unsafe provider names', async () => {
        expect(() => new Auth({ providers: [{ type: 'local' }, { type: 'local' }] }).providers).toThrow(/Duplicate/);
        expect(() => new Auth({ providers: [{ type: 'local', name: 'my provider' }] }).providers).toThrow(/letters/);
    });

    it('describes providers for login UIs', async () => {
        const sso: AuthProvider = { name: 'entra', type: 'oidc', beginLogin: jest.fn(), completeLogin: jest.fn() } as any;
        const auth = await makeAuth({ providers: [{ type: 'local' }, sso] });
        expect(auth.describeProviders()).toEqual([
            { name: 'local', type: 'local', password: true, redirect: false },
            { name: 'entra', type: 'oidc', password: false, redirect: true },
        ]);
    });
});

describe('external bearer tokens', () => {
    const tokenProvider = (verify: (t: string) => Promise<ExternalIdentity | null>): AuthProvider & { verifyToken: jest.Mock } => ({
        name: 'idp',
        type: 'oidc',
        ownsToken: (_t: string, claims: Record<string, unknown> | null) => claims?.iss === 'https://idp.example',
        verifyToken: jest.fn(verify),
    });
    const externalToken = jwt.sign({ iss: 'https://idp.example', sub: 'ext-1' }, 'irrelevant', { expiresIn: 600 });

    it('accepts tokens a provider vouches for and caches the mapping', async () => {
        const provider = tokenProvider(async () => ({ provider: 'idp', subject: 'ext-1', email: 'alice@example.com', groups: [], roles: [], claims: {} }));
        const auth = await makeAuth({ providers: [{ type: 'local' }, provider] });

        const first = await auth.authenticateToken(externalToken);
        const second = await auth.authenticateToken(externalToken);
        expect(first).toEqual({ user: expect.objectContaining({ id: 1 }), sessionId: null });
        expect(second!.user.id).toBe(1);
        expect(provider.verifyToken).toHaveBeenCalledTimes(1);

        // Cached users are copies — request handlers can't corrupt the cache
        second!.user.role = 'hacked';
        expect((await auth.authenticateToken(externalToken))!.user.role).toBe('admin');
    });

    it('never falls back to session-token verification for tokens a provider owns', async () => {
        const provider = tokenProvider(async () => null);
        const auth = await makeAuth({ providers: [{ type: 'local' }, provider] });
        expect(await auth.authenticateToken(externalToken)).toBeNull();
    });

    it('applies validateUser to external tokens', async () => {
        const provider = tokenProvider(async () => ({ provider: 'idp', subject: 'ext-1', email: 'alice@example.com', groups: [], roles: [], claims: {} }));
        const auth = await makeAuth({ providers: [provider], validateUser: () => false });
        expect(await auth.authenticateToken(externalToken)).toBeNull();
    });

    it('drops cached external users on revokeUserSessions', async () => {
        const provider = tokenProvider(async () => ({ provider: 'idp', subject: 'ext-1', email: 'alice@example.com', groups: [], roles: [], claims: {} }));
        const auth = await makeAuth({ providers: [{ type: 'local' }, provider] });
        await auth.authenticateToken(externalToken);
        await auth.revokeUserSessions(1);
        await auth.authenticateToken(externalToken);
        expect(provider.verifyToken).toHaveBeenCalledTimes(2);
    });
});

describe('redirect login and tickets', () => {
    const redirectProvider = (): AuthProvider => ({
        name: 'sso',
        type: 'oidc',
        beginLogin: jest.fn(async ({ redirectUri }) => ({ url: `https://idp.example/authorize?cb=${redirectUri}`, state: 'state-1', flow: { verifier: 'v' } })),
        completeLogin: jest.fn(async (_query, flow) => {
            expect(flow).toEqual({ verifier: 'v' });
            return { provider: 'sso', subject: 's', email: 'alice@example.com', groups: [], roles: [], claims: {} };
        }),
    });

    it('binds the flow to the browser state and consumes it once', async () => {
        const auth = await makeAuth({ providers: [{ type: 'local' }, redirectProvider()] });
        const { url, state } = await auth.beginRedirectLogin('sso', { redirectUri: 'https://api/cb', returnTo: '/home' });
        expect(url).toContain('authorize');

        await expect(auth.completeRedirectLogin('sso', { state, code: 'c' }, 'other-browser'))
            .rejects.toMatchObject({ status_code: 400, message: 'auth_login_failed' });

        const { result, returnTo } = await auth.completeRedirectLogin('sso', { state, code: 'c' }, state);
        expect(returnTo).toBe('/home');
        expect(result.user.id).toBe(1);

        await expect(auth.completeRedirectLogin('sso', { state, code: 'c' }, state))
            .rejects.toMatchObject({ status_code: 400 }); // replay
    });

    it('404s for providers without redirect login', async () => {
        const auth = await makeAuth();
        await expect(auth.beginRedirectLogin('local', { redirectUri: 'x', returnTo: '/' }))
            .rejects.toMatchObject({ status_code: 404 });
    });

    it('login tickets are single-use', async () => {
        const auth = await makeAuth();
        const result = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        const ticket = await auth.issueLoginTicket(result);

        expect(await auth.redeemLoginTicket(ticket)).toEqual(result);
        await expect(auth.redeemLoginTicket(ticket)).rejects.toMatchObject({ status_code: 400, message: 'invalid_login_ticket' });
        await expect(auth.redeemLoginTicket(undefined as any)).rejects.toMatchObject({ status_code: 400 });
    });
});

describe('external-only deployments', () => {
    it('stays enabled without a user table when external providers exist', async () => {
        const dmmf = jest.requireMock('../../src/core/dmmf');
        dmmf.findUserModel.mockReturnValueOnce(null);
        const sso: AuthProvider = { name: 'idp', type: 'oidc', verifyToken: jest.fn(), ownsToken: () => false };
        const auth = new Auth({ providers: [sso], jwt: { secret: 'a'.repeat(40), refreshSecret: 'b'.repeat(40) } as any });
        await auth.initialize();
        expect(auth.isEnabled()).toBe(true);
    });

    it('stays disabled without a user table and without external providers', async () => {
        const dmmf = jest.requireMock('../../src/core/dmmf');
        dmmf.findUserModel.mockReturnValueOnce(null);
        const auth = new Auth({ jwt: { secret: 'a'.repeat(40), refreshSecret: 'b'.repeat(40) } as any });
        await auth.initialize();
        expect(auth.isEnabled()).toBe(false);
    });
});
