/**
 * A user table whose key isn't called `id`: user.id is the row's key, so sessions, tokens,
 * refresh and revocation follow it — and clients see only what the user model's access
 * control lets the user read of a user row.
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const mockRows: Array<Record<string, any>> = [];
const mockKey: { fields: string | string[] } = { fields: 'member_id' };
const mockAcl: { model: Record<string, any> } = { model: {} };

const mockMembers = {
    findFirst: jest.fn(async ({ where }: any) => mockRows.find((row) => Object.entries(where).every(([key, value]: [string, any]) =>
        key === 'OR' ? value.some((w: any) => Object.entries(w).every(([k, v]) => row[k] === v)) : row[key] === value)) ?? null),
    findMany: jest.fn(async () => []),
    create: jest.fn(),
};

jest.mock('../../src/core/dmmf', () => ({
    loadDMMF: jest.fn().mockResolvedValue({}),
    getDMMFSync: jest.fn(() => ({ datamodel: { models: [{ name: 'members', fields: [] }] } })),
    findUserModel: jest.fn(() => ({ name: 'members' })),
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => 'password'),
    getPrimaryKey: jest.fn(() => mockKey.fields),
    getScalarFields: jest.fn(() => ({
        member_id: { name: 'member_id', kind: 'scalar', type: 'Int' },
        tenant_id: { name: 'tenant_id', kind: 'scalar', type: 'Int' },
        member_no: { name: 'member_no', kind: 'scalar', type: 'Int' },
        email: { name: 'email', kind: 'scalar', type: 'String' },
    })),
}));

jest.mock('../../src/core/prisma', () => ({
    rlsActive: () => false,
    authPrisma: { members: mockMembers },
    prisma: {},
    dbProvider: 'postgresql',
    getAcl: () => mockAcl,
}));

import { Auth } from '../../src/auth/Auth';
import { SessionStoreManager } from '../../src/auth/stores';

const PASSWORD = 'correct horse';
let hash: string;
const stores: SessionStoreManager[] = [];

beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
    mockKey.fields = 'member_id';
    mockAcl.model = {};
    mockRows.length = 0;
    mockRows.push({ member_id: 7, tenant_id: 1, member_no: 7, email: 'ada@example.com', password: hash, totp_secret: 'JBSWY3DP' });
    jest.clearAllMocks();
});

afterAll(async () => {
    await Promise.all(stores.map((s) => s.destroy()));
});

async function makeAuth(): Promise<Auth> {
    const auth = new Auth({
        jwt: { secret: 'a'.repeat(40), refreshSecret: 'b'.repeat(40), accessExpiry: '15m', refreshExpiry: '7d' },
        saltRounds: 4,
    });
    const store = new SessionStoreManager({ store: 'memory', ttl: 3600, indexTtl: 7 * 86400 });
    stores.push(store);
    auth.setSessionStore(store);
    await auth.initialize();
    return auth;
}

const decode = (token: string) => jwt.decode(token) as Record<string, any>;

describe('a user table keyed by member_id', () => {
    it('user.id is the key: tokens, refresh and revocation follow it', async () => {
        const auth = await makeAuth();
        const login = await auth.login({ user: 'ada@example.com', password: PASSWORD });
        expect(login.user).toMatchObject({ id: 7, member_id: 7 });
        expect(decode(login.accessToken).sub).toBe(7);

        const refreshed = await auth.refresh({ refreshToken: login.refreshToken });
        expect(decode(refreshed.accessToken).sub).toBe(7);
        expect(await auth.handleBearerAuth(refreshed.accessToken)).toMatchObject({ id: 7 });

        expect(await auth.revokeUserSessions(7)).toBeGreaterThan(0);
        expect(await auth.handleBearerAuth(refreshed.accessToken)).toBeNull();
    });

    it('a composite key becomes "a~b" — and is read back by its columns on refresh', async () => {
        mockKey.fields = ['tenant_id', 'member_no'];
        const auth = await makeAuth();
        const login = await auth.login({ user: 'ada@example.com', password: PASSWORD });
        expect(login.user.id).toBe('1~7');
        const refreshed = await auth.refresh({ refreshToken: login.refreshToken });
        expect(await auth.handleBearerAuth(refreshed.accessToken)).toMatchObject({ id: '1~7' });
        expect(mockMembers.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { tenant_id: 1, member_no: 7 } }));
    });
});

describe('the user as clients see it', () => {
    it('follows the user model\'s getOmitFields in tokens and /auth/me — the session keeps the row', async () => {
        mockAcl.model.members = { getOmitFields: () => ['totp_secret'] };
        const auth = await makeAuth();
        const login = await auth.login({ user: 'ada@example.com', password: PASSWORD });

        expect(decode(login.accessToken).user).not.toHaveProperty('totp_secret');
        expect(decode(login.accessToken).user).not.toHaveProperty('password');
        expect(auth.publicUser(login.user)).toEqual({ id: 7, member_id: 7, tenant_id: 1, member_no: 7, email: 'ada@example.com' });

        const sessionUser = await auth.handleBearerAuth(login.accessToken);
        expect(sessionUser).toMatchObject({ totp_secret: 'JBSWY3DP' });
        expect((await auth.me(sessionUser)).user).not.toHaveProperty('totp_secret');
    });
});
