const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { authPrisma } = require('./rapidd');
const { ErrorResponse } = require('../src/Api');

const SALT_ROUNDS = process.env.SALT_ROUNDS ? parseInt(process.env.SALT_ROUNDS) : 10;

// ============================================
// JWT HELPER FUNCTIONS
// ============================================

/**
 * Generates a JWT access token for a user
 * @param {Object} user - The user object
 * @param {string} user.id - User ID
 * @param {string} user.email - User email
 * @param {string} [user.role] - User role
 * @param {string|null} [sessionId=null] - Session ID to include in the token
 * @returns {string} Signed JWT access token (expires in 1 day)
 */
function generateAccessToken(user, sessionId = null) {
    return jwt.sign(
        {
            sessionId,
            userId: user.id,
            email: user.email,
            role: user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: '1d' }
    );
}

/**
 * Generates a JWT refresh token for a user
 * @param {Object} user - The user object
 * @param {string} user.id - User ID
 * @param {string} user.email - User email
 * @returns {string} Signed JWT refresh token (expires in 7 days)
 */
function generateRefreshToken(user) {
    return jwt.sign(
        {
            userId: user.id,
            email: user.email,
        },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: '7d' }
    );
}

/**
 * Verifies a JWT token and returns the decoded payload
 * @param {string} token - The JWT token to verify
 * @param {string} [secret=process.env.JWT_SECRET] - The secret to use for verification
 * @returns {Object|null} Decoded token payload, or null if invalid
 */
function verifyToken(token, secret = process.env.JWT_SECRET) {
    try {
        return jwt.verify(token, secret);
    } catch (error) {
        return null;
    }
}

// ============================================
// AUTH MIDDLEWARE
// ============================================

/**
 * Main authentication middleware that extracts and validates JWT from Authorization header.
 * Sets req.user if token is valid. Runs for ALL routes (including public ones).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return next();
        }

        const token = authHeader.substring(7);
        const decoded = verifyToken(token);

        if (!decoded) {
            return next();
        }

        // TODO: Customize session/user query for your schema
        const session = await authPrisma.sessions.findUnique({
            where: { id: decoded.sessionId },
            select: {
                // TODO: Replace with your user relation name
                user: {
                    select: {
                        id: true,
                        email: true,
                        role: true,
                        // TODO: Add any additional user fields/relations you need
                    }
                }
            }
        });

        if (!session || !session.user) {
            return next();
        }

        // TODO: Map to your desired req.user structure
        req.user = {
            id: session.user.id,
            email: session.user.email,
            role: session.user.role,
            // TODO: Add any additional fields from your schema
        };

        next();
    } catch (error) {
        next();
    }
}

/**
 * Middleware that requires authentication. Must be used AFTER authenticateUser.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @throws {ErrorResponse} 401 if user is not authenticated
 */
function requireAuth(req, res, next) {
    if (!req.user) {
        throw new ErrorResponse(401, 'auth_required_message');
    }
    next();
}

/**
 * Middleware that requires email verification
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @throws {ErrorResponse} 401 if not authenticated, 403 if email not verified
 */
function requireVerified(req, res, next) {
    if (!req.user) {
        throw new ErrorResponse(401, 'auth_required');
    }

    if (!req.user.emailVerified) {
        throw new ErrorResponse(403, 'email_verification_required_message');
    }

    next();
}

// ============================================
// AUTH ROUTES / HANDLERS
// ============================================

/**
 * POST /auth/register - Registers a new user
 * TODO: Customize this function for your schema
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body
 * @param {string} req.body.email - User email
 * @param {string} req.body.password - User password
 * @param {Object} res - Express response object
 */
async function register(req, res) {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new ErrorResponse(400, 'required_fields', { fields: 'email, password' });
    }

    // TODO: Adjust role validation for your schema
    // if (!['USER', 'ADMIN'].includes(role)) {
    //     throw new ErrorResponse(400, 'invalid_role_message');
    // }

    // TODO: Replace 'users' with your user model name
    const existingUser = await authPrisma.users.findUnique({
        where: { email },
    });

    if (existingUser) {
        throw new ErrorResponse(409, 'email_already_registered_message');
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // TODO: Customize user creation for your schema
    const user = await authPrisma.users.create({
        data: {
            email,
            password: hashedPassword,
            // TODO: Add your schema-specific fields
        },
        select: {
            id: true,
            email: true,
            // TODO: Add fields you need in the response
        },
    });

    // TODO: Create any related records (profiles, etc.) for your schema

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // TODO: Replace 'sessions' with your session model name
    await authPrisma.sessions.create({
        data: {
            userId: user.id,
            token: refreshToken,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            // TODO: Add any additional session fields
        },
    });

    res.status(201).json({
        user,
        accessToken,
        refreshToken,
    });
}

/**
 * POST /auth/login - Authenticates a user with email and password
 * TODO: Customize this function for your schema
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body
 * @param {string} req.body.email - User email
 * @param {string} req.body.password - User password
 * @param {Object} res - Express response object
 */
async function login(req, res) {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new ErrorResponse(400, 'required_fields', { fields: 'email, password' });
    }

    // TODO: Replace 'users' with your user model name and adjust fields
    const user = await authPrisma.users.findUnique({
        where: { email },
        select: {
            id: true,
            email: true,
            password: true,
            // TODO: Add your schema-specific fields (role, etc.)
        },
    });

    if (!user) {
        throw new ErrorResponse(401, 'invalid_credentials_message');
    }

    // TODO: If you have authProvider field, check it here
    // if (user.authProvider !== 'LOCAL') {
    //     throw new ErrorResponse(400, 'invalid_login_method', {provider: user.authProvider});
    // }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
        throw new ErrorResponse(401, 'invalid_credentials_message');
    }

    const refreshToken = generateRefreshToken(user);

    // TODO: Replace 'sessions' with your session model name
    const session = await authPrisma.sessions.create({
        data: {
            userId: user.id,
            token: refreshToken,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            // TODO: Add any additional session fields
        },
    });

    const accessToken = generateAccessToken(user, session.id);

    // TODO: Build response user object for your schema
    const responseUser = {
        id: user.id,
        email: user.email,
        // TODO: Add additional fields
    };

    res.json({
        user: responseUser,
        accessToken,
        refreshToken,
    });
}

/**
 * POST /auth/logout - Logs out the current user by deleting their session
 * TODO: Customize this function for your schema
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body
 * @param {string} [req.body.refreshToken] - Refresh token to invalidate
 * @param {Object} res - Express response object
 */
async function logout(req, res) {
    try {
        const { refreshToken } = req.body;
        const authHeader = req.headers.authorization;
        const token = authHeader?.substring(7);
        const decoded = verifyToken(token);

        if (!decoded) {
            return res.json({ message: 'logged_out_successfully' });
        }

        if (refreshToken || decoded.sessionId) {
            // TODO: Replace 'sessions' with your session model name
            await authPrisma.sessions.deleteMany({
                where: {
                    OR: [
                        { token: refreshToken },
                        { id: decoded.sessionId }
                    ].filter(Boolean)
                }
            });
        }

        res.json({ message: 'logged_out_successfully' });
    } catch (error) {
        throw new ErrorResponse(500, 'logout_failed');
    }
}

/**
 * GET /auth/me - Returns the currently authenticated user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @throws {ErrorResponse} 401 if not authenticated
 */
async function getCurrentUser(req, res) {
    if (!req.user) {
        throw new ErrorResponse(401, 'not_authenticated');
    }

    res.json({ user: req.user });
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Middleware
    authenticateUser,
    requireAuth,
    requireVerified,

    // Route Handlers
    register,
    login,
    logout,
    getCurrentUser,

    // Helpers
    generateAccessToken,
    generateRefreshToken,
    verifyToken,
};