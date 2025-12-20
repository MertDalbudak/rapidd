const express = require('express');
const {
    authenticate,
    login,
    logout,
    refresh,
    me,
    requireAuth,
    hashPassword,
    generateAccessToken,
    generateRefreshToken,
    getSessionStore,
} = require('../../../rapidd/auth');
const crypto = require('crypto');
const { authPrisma } = require('../../../rapidd/rapidd');
const { Response, ErrorResponse } = require('../../../src/Api');

const router = express.Router();
const { rateLimitMiddleware } = require('../../../src/Api');

// Apply rate limiting in production BEFORE authentication to protect database
if (process.env.NODE_ENV === 'production') {
    router.use(rateLimitMiddleware());
}

// Authenticate all requests (supports Basic and Bearer auth)
router.use(authenticate());

/**
 * POST /auth/register
 * Register a new user (example - customize as needed)
 *
 * Body:
 * {
 *   "email": "user@example.com",
 *   "password": "securePassword123",
 *   "name": "John Doe"
 * }
 */
router.post('/register', async (req, res) => {
    const { email, password, ...userData } = req.body;

    if (!email || !password) {
        throw new ErrorResponse(400, 'email_and_password_required');
    }

    // Check if user exists
    const existing = await authPrisma.users.findUnique({
        where: { email }
    }).catch(() => null);

    if (existing) {
        throw new ErrorResponse(409, 'email_already_exists');
    }

    // Create user
    const hashedPassword = await hashPassword(password);
    const user = await authPrisma.users.create({
        data: {
            email,
            password: hashedPassword,
            ...userData
        }
    });
    const response = new Response(201, 'user_registered', { userId: user.id });
    res.status(201).json(response.toJSON(req.language));
});

/**
 * POST /auth/login
 * Login with user (email/username) and password
 *
 * Body:
 * {
 *   "user": "user@example.com",
 *   "password": "securePassword123"
 * }
 */
router.post('/login', login);

/**
 * POST /auth/logout
 * Logout user and delete session
 */
router.post('/logout', logout);

/**
 * POST /auth/refresh
 * Refresh access token using refresh token
 *
 * Body:
 * {
 *   "refreshToken": "..."
 * }
 */
router.post('/refresh', refresh);

/**
 * GET /auth/me
 * Get current logged in user
 * Requires: Authentication
 */
router.get('/me', requireAuth, me);

module.exports = router;
