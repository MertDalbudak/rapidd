const express = require('express');
const {
    authenticate,
    register,
    login,
    logout,
    refresh,
    me,
    requireAuth,
} = require('../../../rapidd/auth');

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
 * Register a new user
 *
 * Body:
 * {
 *   "email": "user@example.com",
 *   "password": "securePassword123"
 * }
 */
router.post('/register', register);

/**
 * POST /auth/login
 * Login with email/username and password
 *
 * Body:
 * {
 *   "email": "user@example.com",
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
