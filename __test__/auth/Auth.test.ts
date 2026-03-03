import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

// Mock DMMF before importing Auth
jest.mock('../../src/core/dmmf', () => ({
    loadDMMF: jest.fn().mockResolvedValue({}),
    findUserModel: jest.fn(() => ({ name: 'users' })),
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => 'password'),
}));

jest.mock('../../src/core/prisma', () => ({
    authPrisma: {},
    prisma: {},
    prismaTransaction: jest.fn(),
    getAcl: () => ({ model: {} }),
}));

jest.mock('../../src/auth/stores', () => ({
    createStore: jest.fn(() => ({
        create: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue(undefined),
        refresh: jest.fn().mockResolvedValue(undefined),
        isHealthy: jest.fn().mockResolvedValue(true),
    })),
    SessionStoreManager: class {},
}));

import { Auth } from '../../src/auth/Auth';

describe('Auth', () => {
    let auth: Auth;
    const TEST_SECRET = 'test-secret-key-for-jwt-signing-1234567890';
    const TEST_REFRESH_SECRET = 'test-refresh-secret-key-1234567890';

    beforeEach(() => {
        auth = new Auth({
            jwt: { secret: TEST_SECRET, refreshSecret: TEST_REFRESH_SECRET, accessExpiry: '1h', refreshExpiry: '7d' },
            identifierFields: ['email'],
            passwordField: 'password',
            strategies: ['bearer'],
            cookieName: 'token',
            customHeaderName: 'X-Auth-Token',
        });
    });

    // ── Constructor ────────────────────────────────────────

    describe('constructor', () => {
        it('should set default options', () => {
            const a = new Auth();
            expect(a.options.identifierFields).toEqual(['email']);
            expect(a.options.passwordField).toBe('password');
            expect(a.options.strategies).toEqual(['bearer']);
            expect(a.options.cookieName).toBe('token');
            expect(a.options.customHeaderName).toBe('X-Auth-Token');
        });

        it('should accept custom options', () => {
            expect(auth.options.jwt.secret).toBe(TEST_SECRET);
            expect(auth.options.jwt.refreshSecret).toBe(TEST_REFRESH_SECRET);
        });

        it('should read strategies from env', () => {
            process.env.AUTH_STRATEGIES = 'bearer,cookie';
            const a = new Auth();
            expect(a.options.strategies).toEqual(['bearer', 'cookie']);
            delete process.env.AUTH_STRATEGIES;
        });

        it('should read cookie name from env', () => {
            process.env.AUTH_COOKIE_NAME = 'session';
            const a = new Auth();
            expect(a.options.cookieName).toBe('session');
            delete process.env.AUTH_COOKIE_NAME;
        });

        it('should read custom header from env', () => {
            process.env.AUTH_CUSTOM_HEADER = 'X-My-Token';
            const a = new Auth();
            expect(a.options.customHeaderName).toBe('X-My-Token');
            delete process.env.AUTH_CUSTOM_HEADER;
        });

        it('should read identifier fields from env', () => {
            process.env.DB_USER_IDENTIFIER_FIELDS = 'email,username';
            const a = new Auth();
            expect(a.options.identifierFields).toEqual(['email', 'username']);
            delete process.env.DB_USER_IDENTIFIER_FIELDS;
        });

        it('should read password field from env', () => {
            process.env.DB_USER_PASSWORD_FIELD = 'hash';
            const a = new Auth();
            expect(a.options.passwordField).toBe('hash');
            delete process.env.DB_USER_PASSWORD_FIELD;
        });

        it('should read salt rounds from env', () => {
            process.env.AUTH_SALT_ROUNDS = '12';
            const a = new Auth();
            expect(a.options.saltRounds).toBe(12);
            delete process.env.AUTH_SALT_ROUNDS;
        });

        it('should use options over env vars', () => {
            process.env.AUTH_STRATEGIES = 'basic';
            const a = new Auth({ strategies: ['cookie'] });
            expect(a.options.strategies).toEqual(['cookie']);
            delete process.env.AUTH_STRATEGIES;
        });

        it('should bind route handler methods', () => {
            expect(auth.login).toBeDefined();
            expect(auth.logout).toBeDefined();
            expect(auth.refresh).toBeDefined();
            expect(auth.me).toBeDefined();
        });
    });

    // ── Initialization ─────────────────────────────────────

    describe('initialize()', () => {
        it('should not re-initialize', async () => {
            await auth.initialize();
            await auth.initialize(); // second call is a no-op
            expect(auth.isEnabled()).toBe(true);
        });

        it('should auto-generate JWT secret if not set', async () => {
            const a = new Auth({ jwt: { accessExpiry: '1h', refreshExpiry: '7d' } });
            await a.initialize();
            expect(a.options.jwt.secret).toBeDefined();
            expect(typeof a.options.jwt.secret).toBe('string');
            expect(a.options.jwt.secret!.length).toBeGreaterThan(0);
        });

        it('should auto-generate refresh secret if not set', async () => {
            const a = new Auth({ jwt: { secret: TEST_SECRET, accessExpiry: '1h', refreshExpiry: '7d' } });
            await a.initialize();
            expect(a.options.jwt.refreshSecret).toBeDefined();
        });
    });

    // ── isEnabled ──────────────────────────────────────────

    describe('isEnabled()', () => {
        it('should return true when user model exists', () => {
            expect(auth.isEnabled()).toBe(true);
        });
    });

    // ── JWT Token Generation ───────────────────────────────

    describe('generateAccessToken()', () => {
        it('should generate a valid JWT token', () => {
            const user = { id: 1, email: 'test@test.com', role: 'user' };
            const token = auth.generateAccessToken(user);
            expect(typeof token).toBe('string');
            expect(token.split('.')).toHaveLength(3);
        });

        it('should include user sub claim', () => {
            const user = { id: 42, email: 'test@test.com', role: 'admin' };
            const token = auth.generateAccessToken(user);
            const decoded = jwt.verify(token, TEST_SECRET, { algorithms: ['HS256'] }) as any;
            expect(decoded.sub).toBe(42);
        });

        it('should include sessionId when provided', () => {
            const user = { id: 1, email: 'test@test.com', role: 'user' };
            const token = auth.generateAccessToken(user, 'session-123');
            const decoded = jwt.verify(token, TEST_SECRET, { algorithms: ['HS256'] }) as any;
            expect(decoded.sessionId).toBe('session-123');
        });

        it('should exclude password from token user payload', () => {
            const user = { id: 1, email: 'test@test.com', role: 'user', password: 'hashed' };
            const token = auth.generateAccessToken(user);
            const decoded = jwt.verify(token, TEST_SECRET, { algorithms: ['HS256'] }) as any;
            expect(decoded.user.password).toBeUndefined();
            expect(decoded.user.email).toBe('test@test.com');
        });

        it('should throw if JWT_SECRET is not set', () => {
            const a = new Auth({ jwt: { accessExpiry: '1h', refreshExpiry: '7d' } });
            expect(() => a.generateAccessToken({ id: 1 })).toThrow('JWT_SECRET');
        });

        it('should use HS256 algorithm', () => {
            const user = { id: 1, role: 'user' };
            const token = auth.generateAccessToken(user);
            const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
            expect(header.alg).toBe('HS256');
        });
    });

    describe('generateRefreshToken()', () => {
        it('should generate a valid refresh token', () => {
            const user = { id: 1, role: 'user' };
            const token = auth.generateRefreshToken(user);
            expect(typeof token).toBe('string');
        });

        it('should include type=refresh in payload', () => {
            const user = { id: 1, role: 'user' };
            const token = auth.generateRefreshToken(user);
            const decoded = jwt.verify(token, TEST_REFRESH_SECRET, { algorithms: ['HS256'] }) as any;
            expect(decoded.type).toBe('refresh');
            expect(decoded.sub).toBe(1);
        });

        it('should use refresh secret', () => {
            const user = { id: 1, role: 'user' };
            const token = auth.generateRefreshToken(user);
            // Should fail with wrong secret
            expect(jwt.verify(token, TEST_REFRESH_SECRET, { algorithms: ['HS256'] })).toBeTruthy();
            expect(() => jwt.verify(token, 'wrong-secret', { algorithms: ['HS256'] })).toThrow();
        });

        it('should fallback to main secret if refresh secret not set', () => {
            const a = new Auth({ jwt: { secret: TEST_SECRET, accessExpiry: '1h', refreshExpiry: '7d' } });
            const user = { id: 1, role: 'user' };
            const token = a.generateRefreshToken(user);
            const decoded = jwt.verify(token, TEST_SECRET, { algorithms: ['HS256'] }) as any;
            expect(decoded.sub).toBe(1);
        });
    });

    describe('verifyToken()', () => {
        it('should verify a valid access token', () => {
            const user = { id: 1, role: 'user' };
            const token = auth.generateAccessToken(user);
            const decoded = auth.verifyToken(token);
            expect(decoded).not.toBeNull();
            expect(decoded.sub).toBe(1);
        });

        it('should return null for invalid token', () => {
            expect(auth.verifyToken('invalid.token.here')).toBeNull();
        });

        it('should return null for expired token', () => {
            const expired = jwt.sign({ sub: 1 }, TEST_SECRET, { algorithm: 'HS256', expiresIn: '0s' });
            // Small delay to ensure expiry
            expect(auth.verifyToken(expired)).toBeNull();
        });

        it('should return null for token signed with wrong secret', () => {
            const token = jwt.sign({ sub: 1 }, 'wrong-secret', { algorithm: 'HS256' });
            expect(auth.verifyToken(token)).toBeNull();
        });

        it('should verify refresh token when isRefresh=true', () => {
            const user = { id: 1, role: 'user' };
            const token = auth.generateRefreshToken(user);
            const decoded = auth.verifyToken(token, true);
            expect(decoded).not.toBeNull();
            expect(decoded.type).toBe('refresh');
        });

        it('should reject non-HS256 tokens', () => {
            // HS384 token should be rejected
            const token = jwt.sign({ sub: 1 }, TEST_SECRET, { algorithm: 'HS384' } as any);
            expect(auth.verifyToken(token)).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(auth.verifyToken('')).toBeNull();
        });
    });

    describe('generateSessionId()', () => {
        it('should return a UUID', () => {
            const id = auth.generateSessionId();
            expect(typeof id).toBe('string');
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        });

        it('should generate unique IDs', () => {
            const ids = new Set(Array.from({ length: 100 }, () => auth.generateSessionId()));
            expect(ids.size).toBe(100);
        });
    });

    // ── Password Methods ───────────────────────────────────

    describe('hashPassword()', () => {
        it('should hash a password', async () => {
            const hash = await auth.hashPassword('mypassword');
            expect(typeof hash).toBe('string');
            expect(hash).not.toBe('mypassword');
            expect(hash.startsWith('$2')).toBe(true);
        });

        it('should produce different hashes for same password', async () => {
            const hash1 = await auth.hashPassword('same');
            const hash2 = await auth.hashPassword('same');
            expect(hash1).not.toBe(hash2);
        });
    });

    describe('comparePassword()', () => {
        it('should return true for matching password', async () => {
            const hash = await auth.hashPassword('correct');
            expect(await auth.comparePassword('correct', hash)).toBe(true);
        });

        it('should return false for non-matching password', async () => {
            const hash = await auth.hashPassword('correct');
            expect(await auth.comparePassword('wrong', hash)).toBe(false);
        });

        it('should return false for empty password', async () => {
            const hash = await auth.hashPassword('test');
            expect(await auth.comparePassword('', hash)).toBe(false);
        });
    });

    // ── Auth Handlers ──────────────────────────────────────

    describe('handleBearerAuth()', () => {
        it('should return user from token with sessionId', async () => {
            const userData = { id: 1, email: 'test@test.com', role: 'user' };
            const store = auth.getSessionStore();
            (store.get as jest.Mock).mockResolvedValueOnce(userData);

            const token = auth.generateAccessToken(userData, 'session-123');
            const result = await auth.handleBearerAuth(token);
            expect(result).toEqual(userData);
        });

        it('should return null for invalid token', async () => {
            const result = await auth.handleBearerAuth('invalid-token');
            expect(result).toBeNull();
        });

        it('should return null if session not found', async () => {
            const userData = { id: 1, role: 'user' };
            const token = auth.generateAccessToken(userData, 'expired-session');
            const store = auth.getSessionStore();
            (store.get as jest.Mock).mockResolvedValueOnce(null);

            const result = await auth.handleBearerAuth(token);
            expect(result).toBeNull();
        });

        it('should return user from token without sessionId', async () => {
            const user = { id: 1, email: 'test@test.com', role: 'user' };
            const token = auth.generateAccessToken(user);
            const result = await auth.handleBearerAuth(token);
            expect(result).not.toBeNull();
            expect(result!.id).toBe(1);
        });

        it('should return minimal user from sub-only token', async () => {
            const token = jwt.sign({ sub: 99 }, TEST_SECRET, { algorithm: 'HS256' });
            const result = await auth.handleBearerAuth(token);
            expect(result).toEqual({ id: 99, role: 'user' });
        });
    });

    describe('handleCookieAuth()', () => {
        it('should delegate to handleBearerAuth', async () => {
            const spy = jest.spyOn(auth, 'handleBearerAuth').mockResolvedValueOnce({ id: 1, role: 'user' });
            const result = await auth.handleCookieAuth('some-token');
            expect(spy).toHaveBeenCalledWith('some-token');
            expect(result).toEqual({ id: 1, role: 'user' });
            spy.mockRestore();
        });

        it('should return null for empty cookie', async () => {
            const result = await auth.handleCookieAuth('');
            expect(result).toBeNull();
        });
    });

    describe('handleCustomHeaderAuth()', () => {
        it('should delegate to handleBearerAuth', async () => {
            const spy = jest.spyOn(auth, 'handleBearerAuth').mockResolvedValueOnce({ id: 2, role: 'admin' });
            const result = await auth.handleCustomHeaderAuth('header-token');
            expect(spy).toHaveBeenCalledWith('header-token');
            expect(result).toEqual({ id: 2, role: 'admin' });
            spy.mockRestore();
        });

        it('should return null for empty header', async () => {
            const result = await auth.handleCustomHeaderAuth('');
            expect(result).toBeNull();
        });
    });

    describe('handleBasicAuth()', () => {
        it('should return null for invalid base64', async () => {
            const result = await auth.handleBasicAuth('not-valid-base64!!!');
            expect(result).toBeNull();
        });

        it('should return null for missing colon in decoded string', async () => {
            const encoded = Buffer.from('nocolon').toString('base64');
            const result = await auth.handleBasicAuth(encoded);
            expect(result).toBeNull();
        });

        it('should return null for empty identifier', async () => {
            const encoded = Buffer.from(':password').toString('base64');
            const result = await auth.handleBasicAuth(encoded);
            expect(result).toBeNull();
        });

        it('should return null for empty password', async () => {
            const encoded = Buffer.from('user:').toString('base64');
            const result = await auth.handleBasicAuth(encoded);
            expect(result).toBeNull();
        });

        it('should return null when user model not found', async () => {
            const encoded = Buffer.from('test@test.com:password').toString('base64');
            const result = await auth.handleBasicAuth(encoded);
            expect(result).toBeNull();
        });
    });

    // ── Route Handlers ─────────────────────────────────────

    describe('login()', () => {
        it('should throw 400 if user is missing', async () => {
            await expect(auth.login({ user: '', password: 'pass' }))
                .rejects.toMatchObject({ status_code: 400 });
        });

        it('should throw 400 if password is missing', async () => {
            await expect(auth.login({ user: 'test@test.com', password: '' }))
                .rejects.toMatchObject({ status_code: 400 });
        });

        it('should throw 500 if user model not configured', async () => {
            await expect(auth.login({ user: 'test@test.com', password: 'pass' }))
                .rejects.toMatchObject({ status_code: 500 });
        });
    });

    describe('logout()', () => {
        it('should return logged_out message with no auth header', async () => {
            const result = await auth.logout(undefined);
            expect(result).toEqual({ message: 'logged_out' });
        });

        it('should return logged_out with non-bearer header', async () => {
            const result = await auth.logout('Basic abc123');
            expect(result).toEqual({ message: 'logged_out' });
        });

        it('should delete session for valid bearer token', async () => {
            const user = { id: 1, role: 'user' };
            const token = auth.generateAccessToken(user, 'session-to-delete');
            const store = auth.getSessionStore();

            const result = await auth.logout(`Bearer ${token}`);
            expect(result).toEqual({ message: 'logged_out' });
            expect(store.delete).toHaveBeenCalledWith('session-to-delete');
        });

        it('should handle invalid bearer token gracefully', async () => {
            const result = await auth.logout('Bearer invalid-token');
            expect(result).toEqual({ message: 'logged_out' });
        });
    });

    describe('refresh()', () => {
        it('should throw 400 if refreshToken is missing', async () => {
            await expect(auth.refresh({ refreshToken: '' }))
                .rejects.toMatchObject({ status_code: 400 });
        });

        it('should throw 401 for invalid refresh token', async () => {
            await expect(auth.refresh({ refreshToken: 'invalid-token' }))
                .rejects.toMatchObject({ status_code: 401 });
        });

        it('should throw 401 for non-refresh token', async () => {
            const user = { id: 1, role: 'user' };
            const accessToken = auth.generateAccessToken(user);
            await expect(auth.refresh({ refreshToken: accessToken }))
                .rejects.toMatchObject({ status_code: 401 });
        });
    });

    describe('me()', () => {
        it('should return user when authenticated', async () => {
            const user = { id: 1, email: 'test@test.com', role: 'admin' };
            const result = await auth.me(user);
            expect(result).toEqual({ user });
        });

        it('should throw 401 when user is null', async () => {
            await expect(auth.me(null))
                .rejects.toMatchObject({ status_code: 401 });
        });
    });

    // ── Session Store ──────────────────────────────────────

    describe('getSessionStore()', () => {
        it('should return a session store', () => {
            const store = auth.getSessionStore();
            expect(store).toBeDefined();
            expect(typeof store.create).toBe('function');
            expect(typeof store.get).toBe('function');
            expect(typeof store.delete).toBe('function');
        });

        it('should return same store on repeated calls', () => {
            const store1 = auth.getSessionStore();
            const store2 = auth.getSessionStore();
            expect(store1).toBe(store2);
        });
    });

    describe('setSessionStore()', () => {
        it('should replace the session store', () => {
            const mockStore = {
                create: jest.fn(),
                get: jest.fn(),
                delete: jest.fn(),
                refresh: jest.fn(),
                isHealthy: jest.fn(),
            };
            auth.setSessionStore(mockStore as any);
            expect(auth.getSessionStore()).toBe(mockStore);
        });
    });
});
