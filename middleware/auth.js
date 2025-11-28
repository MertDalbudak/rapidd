const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { authPrisma } = require('../rapidd/rapidd');
const { RestApi } = require('../lib/RestApi');
const { ErrorResponse } = require('../src/Api');

const SALT_ROUNDS = process.env.SALT_ROUNDS ? parseInt(process.env.SALT_ROUNDS) : 10;

// ============================================
// JWT HELPER FUNCTIONS
// ============================================

/**
 * Generate JWT Access Token
 */
function generateAccessToken(user, sessionId = null) {
    return jwt.sign({
        sessionId,
        userId: user.id,
        email: user.email,
        role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: '1d' });
}

/**
 * Generate JWT Refresh Token
 */
function generateRefreshToken(user) {
    return jwt.sign({
        userId: user.id,
        email: user.email,
    }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

/**
 * Verify JWT Token
 */
function verifyToken(token, secret = process.env.JWT_SECRET) {
    try {
        return jwt.verify(token, secret);
    } catch (error) {
        return null;
    }
}

// ============================================
// OAUTH2 HELPER FUNCTIONS
// ============================================

/**
 * Verify Google OAuth2 Token and get user info
 * @param {string} accessToken - Google access token from client
 * @returns {Promise<Object>} User information from Google
 */
async function verifyGoogleToken(accessToken) {
    try {
        // Verify token with Google's tokeninfo endpoint
        const tokenInfoApi = await RestApi.create('GoogleOAuth', 'verifyToken', {
            queries: { access_token: accessToken }
        });
        const tokenInfo = await tokenInfoApi.get();

        // Check if token is valid and has email scope
        if (!tokenInfo.email) {
            throw new ErrorResponse(401, 'token_missing_email');
        }

        // Get user info from Google
        const userInfoApi = await RestApi.create('GoogleAPI', 'getUserInfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userInfo = await userInfoApi.get();

        return {
            id: userInfo.id,
            email: userInfo.email,
            name: userInfo.name,
            firstName: userInfo.given_name || '',
            lastName: userInfo.family_name || '',
            picture: userInfo.picture,
            emailVerified: userInfo.verified_email || false
        };
    } catch (error) {
        console.error('Google token verification failed:', error);
        throw new ErrorResponse(401, 'invalid_token_message', {message: error.message});
    }
}

/**
 * Verify Facebook OAuth2 Token and get user info
 * @param {string} accessToken - Facebook access token from client
 * @returns {Promise<Object>} User information from Facebook
 */
async function verifyFacebookToken(accessToken) {
    try {
        // Facebook requires App Access Token or App ID + App Secret for token verification
        // Get app access token format: app_id|app_secret
        const appId = process.env.FACEBOOK_APP_ID;
        const appSecret = process.env.FACEBOOK_APP_SECRET;

        if (!appId || !appSecret) {
            throw new ErrorResponse(500, 'oauth_config_missing', {provider: 'Facebook'});
        }

        const appAccessToken = `${appId}|${appSecret}`;

        // Debug/verify the user token
        const debugApi = await RestApi.create('FacebookGraph', 'debugToken', {
            queries: {
                input_token: accessToken,
                access_token: appAccessToken
            }
        });
        const debugResponse = await debugApi.get();

        // Check if token is valid
        if (!debugResponse.data || !debugResponse.data.is_valid) {
            throw new ErrorResponse(401, 'invalid_token', {provider: 'Facebook'});
        }

        // Verify the token belongs to our app
        if (debugResponse.data.app_id !== appId) {
            throw new ErrorResponse(401, 'token_app_mismatch');
        }

        // Get user info from Facebook
        const userInfoApi = await RestApi.create('FacebookGraph', 'getUserInfo', {
            queries: {
                access_token: accessToken
            }
        });
        const userInfo = await userInfoApi.get();

        if (!userInfo.email) {
            throw new ErrorResponse(403, 'oauth_email_permission_missing', {provider: 'Facebook'});
        }

        return {
            id: userInfo.id,
            email: userInfo.email,
            name: userInfo.name,
            firstName: userInfo.first_name || '',
            lastName: userInfo.last_name || '',
            picture: userInfo.picture?.data?.url || null
        };
    } catch (error) {
        console.error('Facebook token verification failed:', error);
        throw new ErrorResponse(401, 'invalid_token_message', {message: error.message});
    }
}

// ============================================
// AUTH MIDDLEWARE
// ============================================

/**
 * Hauptmiddleware: Authentifiziere User aus JWT Token
 * Setzt req.user wenn Token valid ist
 * Läuft für ALLE Routes (auch öffentliche)
 */
async function authenticateUser(req, res, next) {
    try {
        // Token aus Header holen
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // Kein Token = kein User (OK für öffentliche Routes)
            return next();
        }

        const token = authHeader.substring(7); // "Bearer " entfernen
        
        // Token verifizieren
        const decoded = verifyToken(token);
        
        if (!decoded) {
            return next(); // Ungültiger Token = kein User
        }

        // TODO: Customize session/user query for your schema
        // Load user from session - adjust model names and relations for your schema
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
            return next(); // Session/User not found
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
        console.error('Auth Error:', error);
        next(); // Bei Fehler weitermachen ohne User
    }
}

/**
 * Middleware: Route erfordert Authentication
 * Muss NACH authenticateUser verwendet werden
 */
function requireAuth(req, res, next) {
    if (!req.user) {
        throw new ErrorResponse(401, 'auth_required_message');
    }
    next();
}

/**
 * Middleware: Route erfordert bestimmte Rolle(n)
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            throw new ErrorResponse(401, 'auth_required_message');
        }

        if (!roles.includes(req.user.role)) {
            throw new ErrorResponse(403, 'forbidden_role_message', {roles: roles.join(', ')});
        }
        next();
    };
}

/**
 * Middleware: User muss verifiziert sein
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
 * POST /auth/register - User registration
 * TODO: Customize this function for your schema
 */
async function register(req, res) {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
        throw new ErrorResponse(400, 'required_fields', {fields: 'email, password'});
    }

    // TODO: Adjust role validation for your schema
    // if (!['USER', 'ADMIN'].includes(role)) {
    //     throw new ErrorResponse(400, 'invalid_role_message');
    // }

    // Check if email already exists
    // TODO: Replace 'users' with your user model name
    const existingUser = await authPrisma.users.findUnique({
        where: { email },
    });

    if (existingUser) {
        throw new ErrorResponse(409, 'email_already_registered_message');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // TODO: Customize user creation for your schema
    const user = await authPrisma.users.create({
        data: {
            email,
            password: hashedPassword,
            // TODO: Add your schema-specific fields
            // role,
            // createdBy: 'system',
        },
        select: {
            id: true,
            email: true,
            // TODO: Add fields you need in the response
        },
    });

    // TODO: Create any related records (profiles, etc.) for your schema

    // Generate tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Create session
    // TODO: Replace 'sessions' with your session model name
    await authPrisma.sessions.create({
        data: {
            userId: user.id,
            token: refreshToken,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
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
 * POST /auth/login - User login
 * TODO: Customize this function for your schema
 */
async function login(req, res) {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new ErrorResponse(400, 'required_fields', {fields: 'email, password'});
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

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
        throw new ErrorResponse(401, 'invalid_credentials_message');
    }

    // Generate tokens
    const refreshToken = generateRefreshToken(user);

    // Create session
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
 * POST /auth/refresh - Refresh Access Token
 * TODO: Customize this function for your schema
 */
async function refreshToken(req, res) {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            throw new ErrorResponse(400, 'refresh_token_required');
        }

        // Verify token
        const decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);

        if (!decoded) {
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }

        // TODO: Replace 'sessions' with your session model and adjust user relation
        const session = await authPrisma.sessions.findFirst({
            where: {
                token: refreshToken,
                userId: decoded.userId,
                expiresAt: { gt: new Date() },
            },
            include: {
                // TODO: Replace with your user relation name
                user: {
                    select: {
                        id: true,
                        email: true,
                        // TODO: Add fields needed for token generation
                    },
                },
            },
        });

        if (!session || !session.user) {
            throw new ErrorResponse(401, 'session_expired_or_invalid');
        }

        // Generate new access token
        const accessToken = generateAccessToken(session.user);

        res.json({ accessToken });
    } catch (error) {
        console.error('Refresh Token Error:', error);
        throw new ErrorResponse(500, 'token_refresh_failed');
    }
}

/**
 * POST /auth/logout - User logout
 * TODO: Customize this function for your schema
 */
async function logout(req, res) {
    try {
        const { refreshToken } = req.body;
        const authHeader = req.headers.authorization;

        const token = authHeader?.substring(7);

        // Verify token
        const decoded = verifyToken(token);

        if (!decoded) {
            // No valid token, but still return success
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
        console.error('Logout Error:', error);
        throw new ErrorResponse(500, 'logout_failed');
    }
}

/**
 * GET /auth/me - Aktueller User
 */
async function getCurrentUser(req, res) {
    if (!req.user) {
        throw new ErrorResponse(401, 'not_authenticated');
    }

    res.json({ user: req.user });
}

/**
 * POST /auth/google - Google SSO Login
 * TODO: Customize this function for your schema
 */
async function googleAuth(req, res) {
    try {
        const { googleToken } = req.body;

        if (!googleToken) {
            throw new ErrorResponse(400, 'field_required', {field: 'googleToken'});
        }

        // Verify Google Token and get user info
        let googleUser;
        try {
            googleUser = await verifyGoogleToken(googleToken);
        } catch (error) {
            throw new ErrorResponse(401, 'invalid_token', {provider: 'Google'});
        }

        // TODO: Customize user lookup and creation for your schema
        // Check if user with this email exists
        let user = await authPrisma.users.findUnique({
            where: { email: googleUser.email },
        });

        if (!user) {
            // TODO: Create new user for your schema
            user = await authPrisma.users.create({
                data: {
                    email: googleUser.email,
                    // TODO: Add your schema-specific fields
                    // emailVerified: googleUser.emailVerified ? new Date() : null,
                    // authProvider: 'GOOGLE',
                },
            });

            // TODO: Create any related records (SSO accounts, profiles, etc.)
        }

        // Generate tokens
        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);

        // Create session
        // TODO: Replace 'sessions' with your session model name
        await authPrisma.sessions.create({
            data: {
                userId: user.id,
                token: refreshToken,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                // TODO: Add any additional session fields
            }
        });

        res.json({
            user,
            accessToken,
            refreshToken,
        });
    } catch (error) {
        console.error('Google Auth Error:', error);
        throw new ErrorResponse(500, 'google_auth_failed');
    }
}

/**
 * POST /auth/facebook - Facebook SSO Login
 * TODO: Customize this function for your schema
 */
async function facebookAuth(req, res) {
    try {
        const { facebookToken } = req.body;

        if (!facebookToken) {
            throw new ErrorResponse(400, 'field_required', {field: 'facebookToken'});
        }

        // Verify Facebook Token and get user info
        let facebookUser;
        try {
            facebookUser = await verifyFacebookToken(facebookToken);
        } catch (error) {
            throw new ErrorResponse(401, 'invalid_token', {provider: 'Facebook'});
        }

        // TODO: Customize user lookup and creation for your schema
        // Check if user with this email exists
        let user = await authPrisma.users.findUnique({
            where: { email: facebookUser.email },
        });

        if (!user) {
            // TODO: Create new user for your schema
            user = await authPrisma.users.create({
                data: {
                    email: facebookUser.email,
                    // TODO: Add your schema-specific fields
                    // emailVerified: new Date(),
                    // authProvider: 'FACEBOOK',
                },
            });

            // TODO: Create any related records (SSO accounts, profiles, etc.)
        }

        // Generate tokens
        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);

        // Create session
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

        res.json({
            user,
            accessToken,
            refreshToken,
        });
    } catch (error) {
        console.error('Facebook Auth Error:', error);
        throw new ErrorResponse(500, 'facebook_auth_failed');
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Middleware
    authenticateUser,
    requireAuth,
    requireRole,
    requireVerified,

    // Route Handlers
    register,
    login,
    logout,
    refreshToken,
    getCurrentUser,
    googleAuth,
    facebookAuth,

    // Helpers
    generateAccessToken,
    generateRefreshToken,
    verifyToken,
    verifyGoogleToken,
    verifyFacebookToken,
};