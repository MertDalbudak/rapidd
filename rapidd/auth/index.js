const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { authPrisma } = require('../rapidd');
const { ErrorResponse } = require('../../src/Api');
const { createStore } = require('./stores');

// ============================================
// AUTH CLASS
// ============================================

class Auth {
    /**
     * @param {Object} options
     * @param {string} [options.userModel] - Prisma user model name (default: auto-detect)
     * @param {Object} [options.userSelect] - Prisma select for user queries
     * @param {Object} [options.userInclude] - Prisma include for user queries
     * @param {string[]} [options.identifierFields=['email', 'username']] - Fields to use for login identifier
     * @param {string} [options.passwordField='password'] - Password field name
     * @param {Object} [options.session] - Session store options
     * @param {Object} [options.jwt] - JWT options
     */
    constructor(options = {}) {
        this.options = {
            userModel: options.userModel || process.env.DB_USER_TABLE,
            userSelect: options.userSelect || null,
            userInclude: options.userInclude || null,
            identifierFields: options.identifierFields || ['email', 'username'],
            passwordField: options.passwordField || 'password',
            session: {
                ttl: parseInt(process.env.AUTH_SESSION_TTL, 10) || 86400,
                ...options.session
            },
            jwt: {
                secret: process.env.JWT_SECRET,
                refreshSecret: process.env.JWT_REFRESH_SECRET,
                accessExpiry: process.env.AUTH_ACCESS_TOKEN_EXPIRY || '1d',
                refreshExpiry: process.env.AUTH_REFRESH_TOKEN_EXPIRY || '7d',
                ...options.jwt
            },
            saltRounds: options.saltRounds || parseInt(process.env.AUTH_SALT_ROUNDS, 10) || 10
        };

        this._userModel = null;
        this._sessionStore = null;

        // Bind methods to preserve 'this' context when used as middleware
        this.authenticate = this.authenticate.bind(this);
        this.requireAuth = this.requireAuth.bind(this);
        this.register = this.register.bind(this);
        this.login = this.login.bind(this);
        this.logout = this.logout.bind(this);
        this.refresh = this.refresh.bind(this);
        this.me = this.me.bind(this);
    }

    // ============================================
    // USER MODEL
    // ============================================

    /**
     * Get the Prisma user model
     */
    getUserModel() {
        if (this._userModel) return this._userModel;

        const modelName = this.options.userModel?.toLowerCase();
        const models = Object.keys(authPrisma).filter(k => !k.startsWith('$') && !k.startsWith('_'));

        if (modelName) {
            const match = models.find(m => m.toLowerCase() === modelName);
            if (match) {
                this._userModel = authPrisma[match];
                return this._userModel;
            }
            console.warn(`[Auth] userModel="${modelName}" not found in Prisma models`);
        }

        // Auto-detect common names
        for (const name of ['users', 'user', 'Users', 'User']) {
            if (authPrisma[name]) {
                this._userModel = authPrisma[name];
                return this._userModel;
            }
        }

        throw new Error('[Auth] Could not find user model. Set userModel option or DB_USER_TABLE env.');
    }

    /**
     * Build select/include object for user queries
     * Excludes password field from results
     */
    _buildUserQuery(includePassword = false) {
        const query = {};

        if (this.options.userSelect) {
            query.select = { ...this.options.userSelect };
            if (includePassword) {
                query.select[this.options.passwordField] = true;
            }
        } else if (this.options.userInclude) {
            query.include = { ...this.options.userInclude };
            if (includePassword) {
                // When using include, we need select to control password
                // This is a limitation - include and select can't be combined at same level
            }
        }

        return query;
    }

    /**
     * Strip password and sensitive fields from user object
     */
    _sanitizeUser(user) {
        if (!user) return null;
        const { [this.options.passwordField]: _, ...sanitized } = user;
        return sanitized;
    }

    // ============================================
    // SESSION STORE
    // ============================================

    /**
     * Get or initialize session store
     */
    getSessionStore() {
        if (!this._sessionStore) {
            this._sessionStore = createStore({ ttl: this.options.session.ttl });
        }
        return this._sessionStore;
    }

    /**
     * Set custom session store
     */
    setSessionStore(store) {
        this._sessionStore = store;
    }

    // ============================================
    // JWT HELPERS
    // ============================================

    /**
     * Generate access token with full user data
     */
    generateAccessToken(user, sessionId = null) {
        if (!this.options.jwt.secret) {
            throw new Error('[Auth] JWT_SECRET is required');
        }

        const sanitizedUser = this._sanitizeUser(user);

        return jwt.sign(
            {
                sub: user.id,
                sessionId,
                user: sanitizedUser
            },
            this.options.jwt.secret,
            { expiresIn: this.options.jwt.accessExpiry }
        );
    }

    /**
     * Generate refresh token
     */
    generateRefreshToken(user) {
        const secret = this.options.jwt.refreshSecret || this.options.jwt.secret;

        return jwt.sign(
            {
                sub: user.id,
                type: 'refresh'
            },
            secret,
            { expiresIn: this.options.jwt.refreshExpiry }
        );
    }

    /**
     * Verify JWT token
     */
    verifyToken(token, isRefresh = false) {
        try {
            const secret = isRefresh
                ? (this.options.jwt.refreshSecret || this.options.jwt.secret)
                : this.options.jwt.secret;

            return jwt.verify(token, secret);
        } catch {
            return null;
        }
    }

    /**
     * Generate session ID
     */
    generateSessionId() {
        return crypto.randomUUID();
    }

    // ============================================
    // AUTH HANDLERS
    // ============================================

    /**
     * Handle Basic Auth (stateless)
     */
    async handleBasicAuth(credentials) {
        try {
            const decoded = Buffer.from(credentials, 'base64').toString('utf-8');
            const colonIndex = decoded.indexOf(':');
            if (colonIndex === -1) return null;

            const identifier = decoded.substring(0, colonIndex);
            const password = decoded.substring(colonIndex + 1);

            if (!identifier || !password) return null;

            const User = this.getUserModel();

            // Try each identifier field
            let user = null;
            for (const field of this.options.identifierFields) {
                try {
                    user = await User.findUnique({
                        where: { [field]: identifier },
                        ...this._buildUserQuery(true)
                    });
                    if (user) break;
                } catch {
                    // Field might not exist or not be unique, continue
                }
            }

            if (!user?.[this.options.passwordField]) return null;

            const valid = await bcrypt.compare(password, user[this.options.passwordField]);
            if (!valid) return null;

            return this._sanitizeUser(user);
        } catch {
            return null;
        }
    }

    /**
     * Handle Bearer/JWT Auth (session-based)
     */
    async handleBearerAuth(token) {
        const decoded = this.verifyToken(token);
        if (!decoded) return null;

        // If token has sessionId, validate against session store
        if (decoded.sessionId) {
            const store = this.getSessionStore();
            const session = await store.get(decoded.sessionId);

            if (session) {
                await store.refresh(decoded.sessionId);
                return session;
            }

            // Session expired or deleted
            return null;
        }

        // Stateless JWT - return embedded user data
        if (decoded.user) {
            return decoded.user;
        }

        // Legacy: minimal payload
        if (decoded.sub) {
            return { id: decoded.sub };
        }

        return null;
    }

    // ============================================
    // MIDDLEWARE
    // ============================================

    /**
     * Authentication middleware
     * @param {Object} [options]
     * @param {boolean} [options.required=false] - Require authentication
     */
    authenticate(options = {}) {
        const { required = false } = options;

        const self = this;
        return async function (req, res, next) {
            try {
                const authHeader = req.headers.authorization;

                if (authHeader) {
                    let user = null;

                    if (authHeader.startsWith('Basic ')) {
                        user = await self.handleBasicAuth(authHeader.substring(6));
                    } else if (authHeader.startsWith('Bearer ')) {
                        user = await self.handleBearerAuth(authHeader.substring(7));
                    }

                    if (user) {
                        req.user = user;
                    }
                }

                if (required && !req.user) {
                    throw new ErrorResponse(401, 'authentication_required');
                }

                next();
            } catch (error) {
                if (error instanceof ErrorResponse) {
                    return res.status(error.status).json({ error: error.message });
                }
                next();
            }
        };
    }

    /**
     * Require authentication middleware
     */
    requireAuth(req, res, next) {
        if (!req.user) {
            throw new ErrorResponse(401, 'authentication_required');
        }
        next();
    }

    /**
     * Require specific role(s)
     */
    requireRole(...roles) {
        const allowedRoles = roles.flat().map(r => r.toLowerCase());

        return (req, res, next) => {
            if (!req.user) {
                throw new ErrorResponse(401, 'authentication_required');
            }

            const userRole = req.user.role?.toLowerCase();
            if (!userRole || !allowedRoles.includes(userRole)) {
                throw new ErrorResponse(403, 'insufficient_permissions');
            }

            next();
        };
    }

    // ============================================
    // ROUTE HANDLERS
    // ============================================

    /**
     * POST /auth/register
     */
    async register(req, res) {
        const { [this.options.passwordField]: password, ...userData } = req.body;

        // Check required identifier
        const hasIdentifier = this.options.identifierFields.some(f => userData[f]);
        if (!hasIdentifier || !password) {
            throw new ErrorResponse(400, 'identifier_and_password_required');
        }

        const User = this.getUserModel();

        // Check for existing user
        for (const field of this.options.identifierFields) {
            if (userData[field]) {
                const existing = await User.findUnique({
                    where: { [field]: userData[field] }
                }).catch(() => null);

                if (existing) {
                    throw new ErrorResponse(409, `${field}_already_exists`);
                }
            }
        }

        const hashedPassword = await bcrypt.hash(password, this.options.saltRounds);

        const user = await User.create({
            data: {
                ...userData,
                [this.options.passwordField]: hashedPassword
            },
            ...this._buildUserQuery(false)
        });

        const sanitizedUser = this._sanitizeUser(user);

        // Create session
        const sessionId = this.generateSessionId();
        await this.getSessionStore().create(sessionId, sanitizedUser);

        const accessToken = this.generateAccessToken(user, sessionId);
        const refreshToken = this.generateRefreshToken(user);

        res.status(201).json({
            user: sanitizedUser,
            accessToken,
            refreshToken
        });
    }

    /**
     * POST /auth/login
     */
    async login(req, res) {
        const { [this.options.passwordField]: password, ...identifiers } = req.body;

        // Find which identifier was provided
        const identifierField = this.options.identifierFields.find(f => identifiers[f]);
        if (!identifierField || !password) {
            throw new ErrorResponse(400, 'identifier_and_password_required');
        }

        const User = this.getUserModel();
        const user = await User.findUnique({
            where: { [identifierField]: identifiers[identifierField] },
            ...this._buildUserQuery(true)
        });

        if (!user?.[this.options.passwordField]) {
            throw new ErrorResponse(401, 'invalid_credentials');
        }

        const valid = await bcrypt.compare(password, user[this.options.passwordField]);
        if (!valid) {
            throw new ErrorResponse(401, 'invalid_credentials');
        }

        const sanitizedUser = this._sanitizeUser(user);

        // Create session
        const sessionId = this.generateSessionId();
        await this.getSessionStore().create(sessionId, sanitizedUser);

        const accessToken = this.generateAccessToken(user, sessionId);
        const refreshToken = this.generateRefreshToken(user);

        res.json({
            user: sanitizedUser,
            accessToken,
            refreshToken
        });
    }

    /**
     * POST /auth/logout
     */
    async logout(req, res) {
        const authHeader = req.headers.authorization;

        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = this.verifyToken(token);

            if (decoded?.sessionId) {
                await this.getSessionStore().delete(decoded.sessionId);
            }
        }

        res.json({ message: 'logged_out' });
    }

    /**
     * POST /auth/refresh
     */
    async refresh(req, res) {
        const { refreshToken } = req.body;

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
            ...this._buildUserQuery(false)
        });

        if (!user) {
            throw new ErrorResponse(401, 'user_not_found');
        }

        const sanitizedUser = this._sanitizeUser(user);

        // Create new session
        const sessionId = this.generateSessionId();
        await this.getSessionStore().create(sessionId, sanitizedUser);

        const accessToken = this.generateAccessToken(user, sessionId);
        const newRefreshToken = this.generateRefreshToken(user);

        res.json({
            accessToken,
            refreshToken: newRefreshToken
        });
    }

    /**
     * GET /auth/me
     */
    async me(req, res) {
        if (!req.user) {
            throw new ErrorResponse(401, 'not_authenticated');
        }
        res.json({ user: req.user });
    }
}

// ============================================
// DEFAULT INSTANCE
// ============================================

const defaultAuth = new Auth();

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Class for custom configuration
    Auth,

    // Default instance methods (for simple usage)
    authenticate: (options) => defaultAuth.authenticate(options),
    requireAuth: defaultAuth.requireAuth,
    requireRole: (...roles) => defaultAuth.requireRole(...roles),
    register: defaultAuth.register,
    login: defaultAuth.login,
    logout: defaultAuth.logout,
    refresh: defaultAuth.refresh,
    me: defaultAuth.me,
    getSessionStore: () => defaultAuth.getSessionStore(),
    generateAccessToken: (user, sessionId) => defaultAuth.generateAccessToken(user, sessionId),
    generateRefreshToken: (user) => defaultAuth.generateRefreshToken(user),
    verifyToken: (token, isRefresh) => defaultAuth.verifyToken(token, isRefresh)
};
