const express = require('express');
const {
    authenticateUser,
    register,
    login,
    logout,
    getCurrentUser,
    requireAuth,
} = require('../../../rapidd/auth');

const router = express.Router();
const { rateLimitMiddleware } = require('../../../src/Api');

// Apply rate limiting in production BEFORE authentication to protect database
if (process.env.NODE_ENV === 'production') {
    router.use(rateLimitMiddleware());
}

// Authenticate all requests
router.all('*', authenticateUser);

/**
 * POST /auth/register
 * Register a new user
 * TODO: Customize request body for your schema
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
 * Login with email and password
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
 *
 * Body:
 * {
 *   "refreshToken": "..."
 * }
 */
router.post('/logout', logout);

/**
 * GET /auth/me
 * Get current logged in user
 * Requires: Authentication
 */
router.get('/me', requireAuth, getCurrentUser);

module.exports = router;
