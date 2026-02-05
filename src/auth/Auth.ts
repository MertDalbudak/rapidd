import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { authPrisma } from '../core/prisma';
import { ErrorResponse } from '../core/errors';
import { createStore, SessionStoreManager } from './stores';
import type { RapiddUser, AuthOptions, ISessionStore } from '../types';

export class Auth {
    options: Required<Pick<AuthOptions, 'passwordField' | 'saltRounds'>> & AuthOptions & {
        identifierFields: string[];
        session: { ttl: number; store?: string };
        jwt: { secret?: string; refreshSecret?: string; accessExpiry: string; refreshExpiry: string };
    };

    private _userModel: any = null;
    private _sessionStore: ISessionStore | null = null;

    constructor(options: AuthOptions = {}) {
        this.options = {
            userModel: options.userModel || process.env.DB_USER_TABLE,
            userSelect: options.userSelect || null,
            userInclude: options.userInclude || null,
            identifierFields: options.identifierFields || ['email'],
            passwordField: options.passwordField || 'password',
            session: {
                ttl: parseInt(process.env.AUTH_SESSION_TTL || '86400', 10),
                ...options.session,
            },
            jwt: {
                secret: process.env.JWT_SECRET,
                refreshSecret: process.env.JWT_REFRESH_SECRET,
                accessExpiry: process.env.AUTH_ACCESS_TOKEN_EXPIRY || '1d',
                refreshExpiry: process.env.AUTH_REFRESH_TOKEN_EXPIRY || '7d',
                ...options.jwt,
            },
            saltRounds: options.saltRounds || parseInt(process.env.AUTH_SALT_ROUNDS || '10', 10),
        };

        // Bind methods for use as handlers
        this.login = this.login.bind(this);
        this.logout = this.logout.bind(this);
        this.refresh = this.refresh.bind(this);
        this.me = this.me.bind(this);
    }

    // ── User Model ──────────────────────────────────

    getUserModel(): any {
        if (this._userModel) return this._userModel;

        const modelName = this.options.userModel?.toLowerCase();
        const models = Object.keys(authPrisma).filter((k: string) => !k.startsWith('$') && !k.startsWith('_'));

        if (modelName) {
            const match = models.find((m: string) => m.toLowerCase() === modelName);
            if (match) {
                this._userModel = (authPrisma as any)[match];
                return this._userModel;
            }
            console.warn(`[Auth] userModel="${modelName}" not found in Prisma models`);
        }

        for (const name of ['users', 'user', 'Users', 'User']) {
            if ((authPrisma as any)[name]) {
                this._userModel = (authPrisma as any)[name];
                return this._userModel;
            }
        }

        throw new Error('[Auth] Could not find user model. Set userModel option or DB_USER_TABLE env.');
    }

    private _buildUserQuery(includePassword = false): Record<string, unknown> {
        const query: Record<string, unknown> = {};

        if (this.options.userSelect) {
            query.select = { ...this.options.userSelect };
            if (includePassword) {
                (query.select as Record<string, boolean>)[this.options.passwordField] = true;
            }
        } else if (this.options.userInclude) {
            query.include = { ...this.options.userInclude };
        }

        return query;
    }

    private _sanitizeUser(user: Record<string, unknown> | null): RapiddUser | null {
        if (!user) return null;
        const { [this.options.passwordField]: _, ...sanitized } = user;
        return sanitized as RapiddUser;
    }

    // ── Session Store ───────────────────────────────

    getSessionStore(): ISessionStore {
        if (!this._sessionStore) {
            this._sessionStore = createStore({ ttl: this.options.session.ttl });
        }
        return this._sessionStore;
    }

    setSessionStore(store: ISessionStore): void {
        this._sessionStore = store;
    }

    // ── JWT Helpers ─────────────────────────────────

    generateAccessToken(user: Record<string, unknown>, sessionId: string | null = null): string {
        if (!this.options.jwt.secret) {
            throw new Error('[Auth] JWT_SECRET is required');
        }

        const sanitizedUser = this._sanitizeUser(user);
        return jwt.sign(
            { sub: user.id, sessionId, user: sanitizedUser },
            this.options.jwt.secret,
            { expiresIn: this.options.jwt.accessExpiry } as any
        );
    }

    generateRefreshToken(user: Record<string, unknown>): string {
        const secret = this.options.jwt.refreshSecret || this.options.jwt.secret;
        if (!secret) throw new Error('[Auth] JWT_SECRET is required');

        return jwt.sign(
            { sub: user.id, type: 'refresh' },
            secret,
            { expiresIn: this.options.jwt.refreshExpiry } as any
        );
    }

    verifyToken(token: string, isRefresh = false): any | null {
        try {
            const secret = isRefresh
                ? (this.options.jwt.refreshSecret || this.options.jwt.secret)
                : this.options.jwt.secret;
            if (!secret) return null;
            return jwt.verify(token, secret);
        } catch {
            return null;
        }
    }

    generateSessionId(): string {
        return crypto.randomUUID();
    }

    // ── Auth Handlers ───────────────────────────────

    async handleBasicAuth(credentials: string): Promise<RapiddUser | null> {
        try {
            const decoded = Buffer.from(credentials, 'base64').toString('utf-8');
            const colonIndex = decoded.indexOf(':');
            if (colonIndex === -1) return null;

            const identifier = decoded.substring(0, colonIndex);
            const password = decoded.substring(colonIndex + 1);
            if (!identifier || !password) return null;

            const User = this.getUserModel();
            let user: Record<string, unknown> | null = null;

            for (const field of this.options.identifierFields) {
                try {
                    user = await User.findUnique({
                        where: { [field]: identifier },
                        ...this._buildUserQuery(true),
                    });
                    if (user) break;
                } catch {
                    // Field might not exist or not be unique
                }
            }

            if (!user?.[this.options.passwordField]) return null;

            const valid = await bcrypt.compare(password, user[this.options.passwordField] as string);
            if (!valid) return null;

            return this._sanitizeUser(user);
        } catch {
            return null;
        }
    }

    async handleBearerAuth(token: string): Promise<RapiddUser | null> {
        const decoded = this.verifyToken(token);
        if (!decoded) return null;

        if (decoded.sessionId) {
            const store = this.getSessionStore();
            const session = await store.get(decoded.sessionId);
            if (session) {
                await store.refresh(decoded.sessionId);
                return session as unknown as RapiddUser;
            }
            return null;
        }

        if (decoded.user) return decoded.user;
        if (decoded.sub) return { id: decoded.sub, role: 'user' } as RapiddUser;
        return null;
    }

    // ── Route Handlers (framework-agnostic) ─────────

    async login(body: { user: string; password: string }): Promise<{
        user: RapiddUser;
        accessToken: string;
        refreshToken: string;
    }> {
        const { user: identifier, password } = body;

        if (!identifier || !password) {
            throw new ErrorResponse(400, 'user_and_password_required');
        }

        const User = this.getUserModel();
        const search = this.options.identifierFields.reduce((acc: Record<string, string>, curr: string) => {
            acc[curr] = identifier;
            return acc;
        }, {});

        const user = await User.findFirst({
            where: search,
            ...this._buildUserQuery(true),
        });

        if (!user?.[this.options.passwordField]) {
            throw new ErrorResponse(401, 'invalid_credentials');
        }

        const valid = await bcrypt.compare(password, user[this.options.passwordField]);
        if (!valid) {
            throw new ErrorResponse(401, 'invalid_credentials');
        }

        const sanitizedUser = this._sanitizeUser(user)!;
        const sessionId = this.generateSessionId();
        await this.getSessionStore().create(sessionId, sanitizedUser as unknown as Record<string, unknown>);

        const accessToken = this.generateAccessToken(user, sessionId);
        const refreshToken = this.generateRefreshToken(user);

        return { user: sanitizedUser, accessToken, refreshToken };
    }

    async logout(authHeader: string | undefined): Promise<{ message: string }> {
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = this.verifyToken(token);
            if (decoded?.sessionId) {
                await this.getSessionStore().delete(decoded.sessionId);
            }
        }
        return { message: 'logged_out' };
    }

    async refresh(body: { refreshToken: string }): Promise<{
        accessToken: string;
        refreshToken: string;
    }> {
        const { refreshToken } = body;

        if (!refreshToken) {
            throw new ErrorResponse(400, 'refresh_token_required');
        }

        const decoded = this.verifyToken(refreshToken, true);
        if (!decoded || decoded.type !== 'refresh') {
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }

        const User = this.getUserModel();
        const user = await User.findUnique({
            where: { id: decoded.sub },
            ...this._buildUserQuery(false),
        });

        if (!user) {
            throw new ErrorResponse(401, 'user_not_found');
        }

        const sanitizedUser = this._sanitizeUser(user)!;
        const sessionId = this.generateSessionId();
        await this.getSessionStore().create(sessionId, sanitizedUser as unknown as Record<string, unknown>);

        const accessToken = this.generateAccessToken(user, sessionId);
        const newRefreshToken = this.generateRefreshToken(user);

        return { accessToken, refreshToken: newRefreshToken };
    }

    async me(user: RapiddUser | null): Promise<{ user: RapiddUser }> {
        if (!user) {
            throw new ErrorResponse(401, 'not_authenticated');
        }
        return { user };
    }

    // ── Password Helpers ────────────────────────────

    async hashPassword(password: string): Promise<string> {
        return bcrypt.hash(password, this.options.saltRounds);
    }

    async comparePassword(password: string, hash: string): Promise<boolean> {
        return bcrypt.compare(password, hash);
    }
}

// Default instance
export const defaultAuth = new Auth();
