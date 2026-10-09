/**
 * Regression tests for the auth security review: each scenario was a working exploit
 * against the first version of the provider/session layer.
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const mockRows: Array<Record<string, any>> = [];
let mockDbDelayMs = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockMatches(row: Record<string, any>, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'OR') return (value as any[]).some((w) => mockMatches(row, w));
        if (value && typeof value === 'object') return String(row[key]).toLowerCase() === String(value.equals).toLowerCase();
        return row[key] === value;
    });
}

const mockUsers = {
    findFirst: jest.fn(async ({ where }: any) => {
        if (mockDbDelayMs) await sleep(mockDbDelayMs);
        return mockRows.find((r) => mockMatches(r, where)) ?? null;
    }),
    findMany: jest.fn(async ({ where }: any) => mockRows.filter((r) => mockMatches(r, where))),
    create: jest.fn(),
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
import { SessionStoreManager, MemoryStore } from '../../src/auth/stores';
import type { AuthOptions, AuthProvider, ExternalIdentity } from '../../src/types';

const PASSWORD = 'correct horse';
let hash: string;
const stores: Array<{ destroy?: () => unknown }> = [];

beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
    mockDbDelayMs = 0;
    mockRows.length = 0;
    mockRows.push(
        { id: 1, email: 'alice@example.com', password: hash, role: 'admin', status: 'active' },
        { id: 2, email: 'bob@example.com', password: hash, role: 'user', status: 'active' },
    );
});

afterAll(async () => {
    await Promise.all(stores.map((s) => s.destroy?.()));
});

const JWT = { secret: 'a'.repeat(40), refreshSecret: 'b'.repeat(40), accessExpiry: '15m', refreshExpiry: '7d' };

async function makeAuth(options: AuthOptions = {}, store?: any): Promise<Auth> {
    const auth = new Auth({ jwt: JWT, saltRounds: 4, ...options });
    const s = store ?? new SessionStoreManager({ store: 'memory', ttl: 3600, indexTtl: 7 * 86400 });
    stores.push(s);
    auth.setSessionStore(s);
    await auth.initialize();
    return auth;
}

const decode = (t: string) => jwt.decode(t) as Record<string, any>;
const identityOf = (overrides: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
    provider: 'ldap', subject: 'g-2', email: 'bob@example.com', groups: [], roles: [], claims: { dn: 'uid=bob,dc=x' }, ...overrides,
});

describe('revocation cannot be undone', () => {
    it('a refresh in flight while revokeUserSessions runs does not resurrect the session', async () => {
        const auth = await makeAuth();
        const { refreshToken, accessToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });

        mockDbDelayMs = 50; // the refresh is busy re-reading the user
        const inflight = auth.refresh({ refreshToken });
        await sleep(10);
        await auth.revokeUserSessions(1);
        await expect(inflight).rejects.toMatchObject({ status_code: 401 });
        mockDbDelayMs = 0;

        expect(await auth.authenticateToken(accessToken)).toBeNull();
        await expect(auth.refresh({ refreshToken })).rejects.toMatchObject({ status_code: 401 });
    });

    it('a logout during a Redis outage stays in effect when Redis recovers', async () => {
        const backing = new MemoryStore({ ttl: 3600 }); // stands in for Redis
        let down = false;
        const primary: any = { isHealthy: async () => !down };
        for (const op of ['create', 'get', 'delete', 'refresh', 'touch', 'take', 'replace', 'add', 'deleteByUser']) {
            primary[op] = async (...args: any[]) => {
                if (down) throw new Error('ECONNRESET');
                return (backing as any)[op](...args);
            };
        }
        const manager = new SessionStoreManager({ store: 'redis', ttl: 3600, indexTtl: 7 * 86400 });
        Object.assign(manager as any, { _initialized: true, _primaryStore: primary, _fallbackStore: new MemoryStore({ ttl: 3600 }) });
        stores.push(manager, backing);

        const auth = await makeAuth({}, manager);
        const { accessToken, refreshToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        const other = await auth.login({ user: 'bob@example.com', password: PASSWORD });

        down = true;
        await auth.revokeSession(decode(accessToken).sessionId);   // logout while Redis is down
        await auth.revokeUserSessions(2);                          // and a "log out everywhere"
        down = false;
        await (manager as any)._checkPrimaryHealth();              // recovery: replay, then switch back

        expect(await auth.authenticateToken(accessToken)).toBeNull();
        await expect(auth.refresh({ refreshToken })).rejects.toBeTruthy();
        expect(await auth.authenticateToken(other.accessToken)).toBeNull();
    });
});

describe('refresh sees the current account', () => {
    const ldap = (revalidate?: AuthProvider['revalidate']): AuthProvider => ({
        name: 'ldap', type: 'ldap',
        authenticate: async () => identityOf(),
        ...(revalidate ? { revalidate } : {}),
    });

    it('re-runs resolveUser, so validateUser sees a deactivation', async () => {
        const auth = await makeAuth({
            providers: [ldap()],
            resolveUser: (identity, helpers) => helpers.findUser({ email: identity.email }),
            validateUser: (user) => user.status === 'active',
        });
        const first = await auth.login({ user: 'bob', password: 'x' });
        mockRows[1].status = 'disabled';
        await expect(auth.refresh({ refreshToken: first.refreshToken })).rejects.toMatchObject({ status_code: 403 });
        expect(await auth.authenticateToken(first.accessToken)).toBeNull();
    });

    it('ends the session when the directory says the account is gone or disabled', async () => {
        let enabled = true;
        const auth = await makeAuth({ providers: [ldap(async () => enabled)] });
        const first = await auth.login({ user: 'bob', password: 'x' });
        const second = await auth.refresh({ refreshToken: first.refreshToken });

        enabled = false;
        await expect(auth.refresh({ refreshToken: second.refreshToken }))
            .rejects.toMatchObject({ status_code: 403, message: 'account_inactive' });
        expect(await auth.authenticateToken(second.accessToken)).toBeNull();
    });

    it('keeps the session when the directory cannot be asked (null)', async () => {
        const auth = await makeAuth({ providers: [ldap(async () => null)] });
        const first = await auth.login({ user: 'bob', password: 'x' });
        await expect(auth.refresh({ refreshToken: first.refreshToken })).resolves.toBeTruthy();
    });
});

describe('tokens that are not session-bound', () => {
    it('legacy refresh tokens are single-use', async () => {
        const auth = await makeAuth();
        const legacy = auth.generateRefreshToken({ id: 1 });
        await expect(auth.refresh({ refreshToken: legacy })).resolves.toBeTruthy();
        await expect(auth.refresh({ refreshToken: legacy })).rejects.toMatchObject({ status_code: 401 });
    });

    it('legacy refresh tokens issued before revokeUserSessions are dead', async () => {
        const auth = await makeAuth();
        const legacy = auth.generateRefreshToken({ id: 1 });
        await sleep(1100); // iat has second granularity
        await auth.revokeUserSessions(1);
        await expect(auth.refresh({ refreshToken: legacy })).rejects.toMatchObject({ status_code: 401 });
    });

    it('session-less access tokens honour the revocation cutoff', async () => {
        const auth = await makeAuth();
        const minted = auth.generateAccessToken({ id: 1, role: 'admin' });
        expect(await auth.authenticateToken(minted)).not.toBeNull();
        await auth.revokeUserSessions(1);
        expect(await auth.authenticateToken(minted)).toBeNull();
    });

    it('refresh tokens are never access tokens, even with a shared secret', async () => {
        const auth = await makeAuth({ jwt: { ...JWT, refreshSecret: JWT.secret } });
        const { refreshToken } = await auth.login({ user: 'alice@example.com', password: PASSWORD });
        expect(await auth.authenticateToken(refreshToken)).toBeNull();
    });

    it('JWT secrets are enforced even when schema loading fails', async () => {
        const dmmf = jest.requireMock('../../src/core/dmmf');
        dmmf.loadDMMF.mockRejectedValueOnce(new Error('no schema'));
        const saved = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            await expect(new Auth({ jwt: { accessExpiry: '15m', refreshExpiry: '7d' } } as any).initialize())
                .rejects.toThrow(/JWT_SECRET is required/);
        } finally {
            process.env.NODE_ENV = saved;
        }
    });
});

describe('external bearer tokens', () => {
    const externalToken = (iatOffset = 0) => jwt.sign(
        { iss: 'https://idp.example', sub: 'ext-1', iat: Math.floor(Date.now() / 1000) + iatOffset }, 'x', { expiresIn: 600 });

    const owner = (name: string, accepts: (t: string) => boolean): AuthProvider => ({
        name, type: 'oidc',
        ownsToken: (_t, claims) => claims?.iss === 'https://idp.example',
        verifyToken: async (t) => accepts(t) ? identityOf({ provider: name, email: 'alice@example.com' }) : null,
    });

    it('several providers may share an issuer — each gets a chance', async () => {
        const token = externalToken();
        const auth = await makeAuth({ providers: [{ type: 'local' }, owner('spa', () => false), owner('daemon', () => true)] });
        expect((await auth.authenticateToken(token))!.user.id).toBe(1);
    });

    it('tokens issued before revokeUserSessions are rejected', async () => {
        const auth = await makeAuth({ providers: [{ type: 'local' }, owner('idp', () => true)] });
        const old = externalToken(-10);
        expect(await auth.authenticateToken(old)).not.toBeNull();
        await auth.revokeUserSessions(1);
        expect(await auth.authenticateToken(old)).toBeNull();
        // a token issued afterwards (new login at the IdP) works again
        expect(await auth.authenticateToken(externalToken(5))).not.toBeNull();
    });
});

describe('session data isolation', () => {
    it('mutating request.user never rewrites the stored session', async () => {
        const auth = await makeAuth();
        const { accessToken } = await auth.login({ user: 'bob@example.com', password: PASSWORD });
        const first = (await auth.authenticateToken(accessToken))!.user;
        first.role = 'admin';
        expect((await auth.authenticateToken(accessToken))!.user.role).toBe('user');
    });
});
