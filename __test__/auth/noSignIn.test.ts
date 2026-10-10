/**
 * AUTH_PROVIDERS=none: sign-in is off on purpose — every request is the anonymous user,
 * access rules apply, no JWT secrets are needed.
 */
import path from 'path';
import fs from 'fs';

jest.mock('../../src/core/prisma', () => ({
    rlsActive: () => false,
    prisma: { $queryRawUnsafe: jest.fn().mockResolvedValue([{ ok: 1 }]) },
    prismaTransaction: jest.fn(),
    requestContext: { run: jest.fn((_store: any, fn: any) => fn()) },
    getAcl: () => ({ model: {} }),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
    rlsEnabled: false,
}));

const mockFindUserModel = jest.fn((): { name: string } | null => ({ name: 'users' }));
jest.mock('../../src/core/dmmf', () => ({
    loadDMMF: jest.fn().mockResolvedValue({}),
    getDMMFSync: jest.fn(() => ({ datamodel: { models: [] } })),
    getModel: jest.fn(),
    getFields: jest.fn(() => ({})),
    getScalarFields: jest.fn(() => ({})),
    getPrimaryKey: jest.fn(() => 'id'),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn(() => false),
    getRelationInfo: jest.fn(),
    buildRelationships: jest.fn(() => []),
    findUserModel: () => mockFindUserModel(),
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => 'password'),
}));

jest.mock('../../src/core/i18n', () => ({
    LanguageDict: {
        initialize: jest.fn(),
        get: jest.fn((key: string) => key),
        getAvailableLanguages: jest.fn(() => ['en_US']),
        hasLanguage: jest.fn(() => true),
        getDictionary: jest.fn(() => ({})),
        defaultLanguage: 'en_US',
    },
}));

import { buildApp } from '../../src/app';
import { Auth } from '../../src/auth/Auth';
import { providerConfigsFromEnv } from '../../src/auth/providers';
import { anonymousUser, isSystemUser } from '../../src/core/user';
import { aclFromRules } from '../../src/core/aclRules';

// Per run: the IDE's watcher may run this file at the same time
const ROUTES = fs.mkdtempSync(path.join(__dirname, '__temp_routes_no_sign_in_'));
// buildApp validates DATABASE_URL (nothing here connects) — set before the snapshot afterEach
// restores, or every test after the first would lose it
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
const saved = { ...process.env };

beforeAll(() => {
    fs.mkdirSync(path.join(ROUTES, 'api'), { recursive: true });
    // Like a generated route: refuses requests without a user
    fs.writeFileSync(path.join(ROUTES, 'api', 'items.js'), `
        module.exports = async function (fastify) {
            fastify.addHook('preHandler', async (request, reply) => {
                if (!request.user) return reply.code(401).send({ error: 'no_valid_session' });
            });
            fastify.get('/', async (request) => ({ user: request.user }));
        };
    `);
});
afterAll(() => fs.rmSync(ROUTES, { recursive: true, force: true }));
beforeEach(() => {
    // Independent of the developer's .env
    delete process.env.DB_USER_TABLE;
    delete process.env.AUTH_PROVIDERS;
    process.env.ROUTES_PATH = ROUTES;
});
afterEach(() => {
    process.env = { ...saved };
    mockFindUserModel.mockReset().mockReturnValue({ name: 'users' });
});

const build = () => buildApp({ routesPath: ROUTES, rateLimit: false, processHandlers: false });

describe('AUTH_PROVIDERS=none', () => {
    it('every request is the anonymous user — routes serve it; there are no sign-in routes', async () => {
        process.env.AUTH_PROVIDERS = 'none';
        const app = await build();
        try {
            const res = await app.inject({ method: 'GET', url: '/api/items' });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ user: { id: null, role: 'anonymous' } });
            expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { user: 'a', password: 'b' } })).statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('needs no JWT secrets in production', async () => {
        process.env.AUTH_PROVIDERS = 'none';
        process.env.NODE_ENV = 'production';
        delete process.env.JWT_SECRET;
        delete process.env.JWT_REFRESH_SECRET;
        const auth = new Auth();
        await expect(auth.initialize()).resolves.toBeUndefined();
        expect(auth.isEnabled()).toBe(false);
        expect(auth.isAnonymous()).toBe(true);
    });

    it('without it, a project without a user table keeps refusing requests — no anonymous access by accident', async () => {
        delete process.env.AUTH_PROVIDERS;
        delete process.env.DB_USER_TABLE;
        mockFindUserModel.mockReturnValue(null);
        const app = await build();
        try {
            expect((await app.inject({ method: 'GET', url: '/api/items' })).statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('a project without a user table starts in production without JWT secrets (auth is off)', async () => {
        delete process.env.AUTH_PROVIDERS;
        process.env.NODE_ENV = 'production';
        delete process.env.JWT_SECRET;
        delete process.env.JWT_REFRESH_SECRET;
        mockFindUserModel.mockReturnValue(null);
        const auth = new Auth();
        await auth.initialize();
        expect(auth.isEnabled()).toBe(false);
        expect(auth.isAnonymous()).toBe(false);
        // With a user table the secrets are still required
        mockFindUserModel.mockReturnValue({ name: 'users' });
        await expect(new Auth().initialize()).rejects.toThrow(/JWT_SECRET is required/);
    });

    it('stands alone; providers: [] in code does the same', async () => {
        expect(providerConfigsFromEnv({ AUTH_PROVIDERS: 'none' })).toEqual([]);
        expect(providerConfigsFromEnv({ AUTH_PROVIDERS: ' None ' })).toEqual([]);
        expect(() => providerConfigsFromEnv({ AUTH_PROVIDERS: 'none,local' })).toThrow(/cannot be combined/);
        const auth = new Auth({ providers: [] });
        await auth.initialize();
        expect(auth.isAnonymous()).toBe(true);
    });

    it('the anonymous user is no system user: access rules apply to it', () => {
        const user = anonymousUser();
        expect(isSystemUser(user)).toBe(false);
        const acl = aclFromRules({ models: {
            product: { read: { '*': 'all' }, create: { anonymous: false, '*': true } },
            order: { read: { '*': { where: { owner_id: '$user.id' } } } },
        } });
        expect(acl.product.getAccessFilter!(user)).toBe(true);
        expect(acl.product.canCreate!(user)).toBe(false);
        // No id: rules on $user.id give it no rows
        expect(acl.order.getAccessFilter!(user)).toBe(false);
    });
});
