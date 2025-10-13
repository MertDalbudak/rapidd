const express = require('express');
const {
    authenticateUser,
    register,
    login,
    logout,
    refreshToken,
    getCurrentUser,
    googleAuth,
    facebookAuth,
    requireAuth,
} = require('../../../middleware/auth');

const router = express.Router();
const {rateLimitMiddleware} = require('../../../src/Api');

// Apply rate limiting in production BEFORE authentication to protect database
if(process.env.NODE_ENV == "production"){
    router.use(rateLimitMiddleware());
}

router.all('*', authenticateUser);

/**
 * POST /auth/register
 * Register neuer User (Student oder Company)
 * 
 * Body:
 * {
 *   "email": "user@example.com",
 *   "password": "securePassword123",
 *   "role": "STUDENT" | "COMPANY",
 *   "firstName": "John",      // für STUDENT
 *   "lastName": "Doe",         // für STUDENT
 *   "companyName": "Acme Inc"  // für COMPANY
 * }
 */
router.post('/register', register);

/**
 * POST /auth/login
 * Login mit Email und Passwort
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
 * Logout User und lösche Session
 * 
 * Body:
 * {
 *   "refreshToken": "..."
 * }
 */
router.post('/logout', logout);

/**
 * POST /auth/refresh
 * Refresh Access Token mit Refresh Token
 * 
 * Body:
 * {
 *   "refreshToken": "..."
 * }
 */
router.post('/refresh', refreshToken);

/**
 * GET /auth/me
 * Hole aktuellen eingeloggten User
 * Requires: Authentication
 */
router.get('/me', requireAuth, getCurrentUser);

/**
 * POST /auth/google
 * Google SSO Login/Register
 * 
 * Body:
 * {
 *   "googleToken": "...",  // Google OAuth Token vom Frontend
 *   "role": "STUDENT"      // Nur bei neuen Usern nötig
 * }
 */
router.post('/google', googleAuth);

/**
 * POST /auth/facebook
 * Facebook SSO Login/Register
 *
 * Body:
 * {
 *   "facebookToken": "...",  // Facebook OAuth Token vom Frontend
 *   "role": "STUDENT"         // Nur bei neuen Usern nötig
 * }
 */
router.post('/facebook', facebookAuth);

module.exports = router;