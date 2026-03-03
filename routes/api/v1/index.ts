import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';


const rootRoutes: FastifyPluginAsync = async (fastify) => {
    const auth = fastify.auth;

    fastify.post('/health', async (request: FastifyRequest, reply: FastifyReply) => {
        if(request.user) {
            return { status: 'ok' };
        }
        else {
            reply.status(401);
            return reply.sendError(401, 'no_valid_session');
        }
    });
};

export default rootRoutes;
