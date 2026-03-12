import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Request utilities plugin.
 * Decorates request with parseListQuery.
 */
const requestPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.decorateRequest('model', null);

    fastify.decorateRequest('parseListQuery', function (this: FastifyRequest) {
        const query = this.query as Record<string, string>;
        const { q = {}, include = '', sortBy = 'id', sortOrder = 'asc', fields = null } = query;
        return {
            q,
            include,
            sortBy,
            sortOrder,
            fields,
            limit: Number(query.limit || '25'),
            offset: Number(query.offset || '0'),
            totalResults: query.totalResults === 'true',
            pagination: process.env.PAGINATION_MODE === 'page'
                ? { page: Number(query.page || '1'), pageSize: Number(query.pageSize || '25') }
                : undefined,
        };
    });
};

export default fp(requestPlugin, { name: 'rapidd-request' });
