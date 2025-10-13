const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('../rapidd/rapidd');
const { RestApi } = require('../lib/RestApi');
const { ErrorResponse } = require('../src/Api');

const SALT_ROUNDS = process.env.SALT_ROUNDS ? parseInt(process.env.SALT_ROUNDS) : 10;

const authPrisma = new PrismaClient();

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

        // User aus DB laden (mit authPrisma, OHNE RLS!)
        const session = await authPrisma.session.findUnique({
            where: { id: decoded.sessionId },
            select: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        role: true,
                        emailVerified: true,
                        studentProfile: {
                            select: { id: true, firstName: true, lastName: true }
                        },
                        companyProfile: {
                            select: { id: true, companyName: true, isVerified: true }
                        }
                    }
                }
            }
        });

        if (!session) {
            return next(); // User existiert nicht mehr
        }

        // User an Request hängen
        req.user = session.user;
        
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

/**
 * Middleware: Company muss verifiziert sein
 */
function requireVerifiedCompany(req, res, next) {
    if (!req.user || req.user.role !== 'COMPANY') {
        throw new ErrorResponse(403, 'company_account_required');
    }

    if (!req.user.companyProfile?.isVerified) {
        throw new ErrorResponse(403, 'company_verification_required_message');
    }

    next();
}

// ============================================
// AUTH ROUTES / HANDLERS
// ============================================

/**
 * POST /auth/register - User registrieren
 */
async function register(req, res) {
    const { email, password, role, firstName, lastName, companyName } = req.body;

    // Validierung
    if (!email || !password || !role) {
        throw new ErrorResponse(400, 'required_fields', {fields: 'email, password, role'});
    }

    if (!['STUDENT', 'COMPANY'].includes(role)) {
        throw new ErrorResponse(400, 'invalid_role_message');
    }

    // Check ob Email bereits existiert
    const existingUser = await authPrisma.user.findUnique({
        where: { email },
    });

    if (existingUser) {
        throw new ErrorResponse(409, 'email_already_registered_message');
    }

    // Passwort hashen
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // User erstellen mit Profil
    const user = await authPrisma.user.create({
        data: {
            email,
            password: hashedPassword,
            role,
            authProvider: 'LOCAL',
            createdBy: 'system', // System für initial registration
            updatedBy: 'system',
            // Student Profil
            ...(role === 'STUDENT' && {
                studentProfile: {
                    create: {
                        firstName: firstName || '',
                        lastName: lastName || '',
                        createdBy: 'system',
                        updatedBy: 'system',
                    },
                },
            }),
            // Company Profil
            ...(role === 'COMPANY' && {
                companyProfile: {
                    create: {
                        companyName: companyName || '',
                        description: '',
                        createdBy: 'system',
                        updatedBy: 'system',
                    },
                },
            }),
        },
        select: {
            id: true,
            email: true,
            role: true,
            studentProfile: {
                select: { id: true, firstName: true, lastName: true },
            },
            companyProfile: {
                select: { id: true, companyName: true },
            },
        },
    });

    // Für COMPANY: Automatisch OWNER Member erstellen
    if (role === 'COMPANY' && user.companyProfile) {
        await authPrisma.companyMember.create({
            data: {
                companyId: user.companyProfile.id,
                userId: user.id,
                role: 'OWNER',
                status: 'ACTIVE',
                canEditCompany: true,
                canManageJobs: true,
                canViewApplications: true,
                canManageApplications: true,
                canManageMembers: true,
                canManageSubscription: true,
                createdBy: 'system',
                updatedBy: 'system',
            },
        });
    }

    // Tokens generieren
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Session erstellen
    await authPrisma.session.create({
        data: {
            userId: user.id,
            token: refreshToken,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 Tage
            createdBy: user.id,
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
 */
async function login(req, res) {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new ErrorResponse(400, 'required_fields', {fields: 'email, password'});
    }

    // User finden
    const user = await authPrisma.user.findUnique({
        where: { email },
        select: {
            id: true,
            email: true,
            role: true,
            password: true,
            emailVerified: true,
            authProvider: true,
            studentProfile: {
                select: { id: true, firstName: true, lastName: true }
            },
            companyProfile: {
                select: { id: true, companyName: true, isVerified: true }
            }
        },
    });
    
    if (!user) {
        throw new ErrorResponse(401, 'invalid_credentials_message');
    }

    // Check Auth Provider
    if (user.authProvider !== 'LOCAL') {
        throw new ErrorResponse(400, 'invalid_login_method', {provider: user.authProvider});
    }

    // Passwort prüfen
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
        throw new ErrorResponse(401, 'invalid_credentials_message');
    }

    // Passwort aus Response entfernen
    delete user.password;

    // Tokens generieren
    const refreshToken = generateRefreshToken(user);

    // Session erstellen
    const session = await authPrisma.session.create({
        data: {
            userId: user.id,
            token: refreshToken,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            createdBy: user.id
        },
    });

    const accessToken = generateAccessToken(user, session.id);

    res.json({
        user,
        accessToken,
        refreshToken,
    });
}

/**
 * POST /auth/refresh - Refresh Access Token
 */
async function refreshToken(req, res) {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            throw new ErrorResponse(400, 'refresh_token_required');
        }

        // Token verifizieren
        const decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);

        if (!decoded) {
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }

        // Session prüfen
        const session = await authPrisma.session.findFirst({
            where: {
                token: refreshToken,
                userId: decoded.userId,
                expiresAt: { gt: new Date() },
            },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        role: true,
                        studentProfile: { select: { id: true } },
                        companyProfile: { select: { id: true } },
                    },
                },
            },
        });

        if (!session) {
            throw new ErrorResponse(401, 'session_expired_or_invalid');
        }

        // Neuen Access Token generieren
        const accessToken = generateAccessToken(session.user);

        res.json({ accessToken });
    } catch (error) {
        console.error('Refresh Token Error:', error);
        throw new ErrorResponse(500, 'token_refresh_failed');
    }
}

/**
 * POST /auth/logout - User logout
 */
async function logout(req, res) {
    try {
        const { refreshToken } = req.body;
        const authHeader = req.headers.authorization;

        const token = authHeader?.substring(7);

        // Token verifizieren
        const decoded = verifyToken(token);
        
        if (!decoded) {
            return next(); // Ungültiger Token = kein User
        }

        if (refreshToken || token) {
            // Session löschen
            await authPrisma.session.deleteMany({
                where: {
                    OR: [{token: refreshToken}, { id: decoded.sessionId }]
                }
            });
        }

        res.json({ message: req.getTranslation('logged_out_successfully') });
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
 */
async function googleAuth(req, res) {
    try {
        const { googleToken, role } = req.body; // Google OAuth Token vom Frontend

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

        // Check ob User mit dieser Email existiert
        let user = await authPrisma.user.findUnique({
            where: { email: googleUser.email },
            include: {
                studentProfile: true,
                companyProfile: true,
                ssoAccounts: true,
            },
        });

        if (user) {
            // User existiert - SSO Account aktualisieren/erstellen
            await authPrisma.sSOAccount.upsert({
                where: {
                    provider_providerId: {
                        provider: 'GOOGLE',
                        providerId: googleUser.id,
                    }
                },
                create: {
                    userId: user.id,
                    provider: 'GOOGLE',
                    providerId: googleUser.id,
                    providerEmail: googleUser.email,
                    createdBy: user.id,
                    updatedBy: user.id,
                },
                update: {
                    providerEmail: googleUser.email,
                    updatedBy: user.id,
                },
            });
        } else {
            // Create New User
            if (!role || !['STUDENT', 'COMPANY'].includes(role)) {
                throw new ErrorResponse(400, 'role_required_for_new_users_message');
            }

            user = await authPrisma.user.create({
                data: {
                    email: googleUser.email,
                    emailVerified: googleUser.emailVerified ? new Date() : null,
                    authProvider: 'GOOGLE',
                    role,
                    createdBy: 'system',
                    updatedBy: 'system',
                    ssoAccounts: {
                        create: {
                            provider: 'GOOGLE',
                            providerId: googleUser.id,
                            providerEmail: googleUser.email,
                            createdBy: 'system',
                            updatedBy: 'system',
                        },
                    },
                    ...(role === 'STUDENT' && {
                        studentProfile: {
                            create: {
                                firstName: googleUser.firstName || '',
                                lastName: googleUser.lastName || '',
                                createdBy: 'system',
                                updatedBy: 'system',
                            },
                        },
                    }),
                    ...(role === 'COMPANY' && {
                        companyProfile: {
                            create: {
                                companyName: '',
                                description: '',
                                createdBy: 'system',
                                updatedBy: 'system',
                            },
                        },
                    }),
                },
                include: {
                    studentProfile: true,
                    companyProfile: true,
                },
            });

            // Für COMPANY: Automatisch OWNER Member erstellen
            if (role === 'COMPANY' && user.companyProfile) {
                await authPrisma.companyMember.create({
                    data: {
                        companyId: user.companyProfile.id,
                        userId: user.id,
                        role: 'OWNER',
                        status: 'ACTIVE',
                        canEditCompany: true,
                        canManageJobs: true,
                        canViewApplications: true,
                        canManageApplications: true,
                        canManageMembers: true,
                        canManageSubscription: true,
                        createdBy: 'system',
                        updatedBy: 'system',
                    },
                });
            }
        }

        // Tokens generieren
        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);

        // Session erstellen
        await authPrisma.session.create({
            data: {
                userId: user.id,
                token: refreshToken,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                createdBy: user.id,
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
 */
async function facebookAuth(req, res) {
    try {
        const { facebookToken, role } = req.body; // Facebook OAuth Token vom Frontend

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

        // Check ob User mit dieser Email existiert
        let user = await authPrisma.user.findUnique({
            where: { email: facebookUser.email },
            include: {
                studentProfile: true,
                companyProfile: true,
                ssoAccounts: true,
            },
        });

        if (user) {
            // User existiert - SSO Account aktualisieren/erstellen
            await authPrisma.sSOAccount.upsert({
                where: {
                    provider_providerId: {
                        provider: 'FACEBOOK',
                        providerId: facebookUser.id,
                    },
                },
                create: {
                    userId: user.id,
                    provider: 'FACEBOOK',
                    providerId: facebookUser.id,
                    providerEmail: facebookUser.email,
                    createdBy: user.id,
                    updatedBy: user.id,
                },
                update: {
                    providerEmail: facebookUser.email,
                    updatedBy: user.id,
                },
            });
        } else {
            // Create new User
            if (!role || !['STUDENT', 'COMPANY'].includes(role)) {
                throw new ErrorResponse(400, 'role_required_for_new_users_message');
            }

            user = await authPrisma.user.create({
                data: {
                    email: facebookUser.email,
                    emailVerified: new Date(), // Facebook Email ist bereits verifiziert
                    authProvider: 'FACEBOOK',
                    role,
                    createdBy: 'system',
                    updatedBy: 'system',
                    ssoAccounts: {
                        create: {
                            provider: 'FACEBOOK',
                            providerId: facebookUser.id,
                            providerEmail: facebookUser.email,
                            createdBy: 'system',
                            updatedBy: 'system',
                        },
                    },
                    ...(role === 'STUDENT' && {
                        studentProfile: {
                            create: {
                                firstName: facebookUser.firstName || '',
                                lastName: facebookUser.lastName || '',
                                createdBy: 'system',
                                updatedBy: 'system',
                            },
                        },
                    }),
                    ...(role === 'COMPANY' && {
                        companyProfile: {
                            create: {
                                companyName: '',
                                description: '',
                                createdBy: 'system',
                                updatedBy: 'system',
                            },
                        },
                    }),
                },
                include: {
                    studentProfile: true,
                    companyProfile: true,
                },
            });

            // Für COMPANY: Automatisch OWNER Member erstellen
            if (role === 'COMPANY' && user.companyProfile) {
                await authPrisma.companyMember.create({
                    data: {
                        companyId: user.companyProfile.id,
                        userId: user.id,
                        role: 'OWNER',
                        status: 'ACTIVE',
                        canEditCompany: true,
                        canManageJobs: true,
                        canViewApplications: true,
                        canManageApplications: true,
                        canManageMembers: true,
                        canManageSubscription: true,
                        createdBy: 'system',
                        updatedBy: 'system',
                    },
                });
            }
        }

        // Tokens generieren
        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);

        // Session erstellen
        await authPrisma.session.create({
            data: {
                userId: user.id,
                token: refreshToken,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                createdBy: user.id,
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
    requireVerifiedCompany,

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