import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Auth } from '../../../src/auth/Auth';
import { authPrisma } from '../../../src/core/prisma';
import { ErrorResponse } from '../../../src/core/errors';

/**
 * Auth routes — /register, /login, /logout, /refresh, /me
 */
const rootRoutes: FastifyPluginAsync = async (fastify) => {
    const auth = fastify.auth ?? new Auth();

    /**
     * POST /register
     * Register a new user.
     *
     * Body:
     * {
     *   "email": "user@example.com",
     *   "password": "securePassword123",
     *   "name": "John Doe"
     * }
     */
    fastify.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { email, password, ...userData } = request.body as Record<string, unknown>;

            if (!email || !password) {
                return reply.sendError(400, 'email_and_password_required');
            }

            // Check if user exists
            const existing = await authPrisma.users.findUnique({
                where: { email: email as string },
            }).catch(() => null);

            if (existing) {
                return reply.sendError(409, 'email_already_exists');
            }

            // Create user
            const hashedPassword = await auth.hashPassword(password as string);
            const user = await authPrisma.users.create({
                data: {
                    email: email as string,
                    password: hashedPassword,
                    ...userData,
                },
            });

            return reply.sendResponse(201, 'user_registered', { userId: user.id });
        } catch (error: any) {
            if (error instanceof ErrorResponse) {
                throw error;
            }
            return reply.sendError(500, error.message || 'internal_server_error');
        }
    });

    /**
     * POST /login
     * Login with user (email/username) and password.
     *
     * Body:
     * {
     *   "user": "user@example.com",
     *   "password": "securePassword123"
     * }
     */
    fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
        const result = await auth.login(request.body as { user: string; password: string });
        return reply.send(result);
    });

    /**
     * POST /logout
     * Logout user and delete session.
     */
    fastify.post('/logout', async (request: FastifyRequest, reply: FastifyReply) => {
        const result = await auth.logout(request.headers.authorization);
        return reply.send(result);
    });

    /**
     * POST /refresh
     * Refresh access token using refresh token.
     *
     * Body:
     * {
     *   "refreshToken": "..."
     * }
     */
    fastify.post('/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
        const result = await auth.refresh(request.body as { refreshToken: string });
        return reply.send(result);
    });

    /**
     * GET /me
     * Get current logged-in user.
     * Requires: Authentication
     */
    fastify.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        const result = await auth.me(request.user);
        return reply.send(result);
    });
};

export default rootRoutes;
