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
        const { include = '', fields = null } = query;
        // ?q= is canonical; ?filter= is the documented alias
        const q: string | Record<string, any> = query.q ?? query.filter ?? {};

        // ?sort=field:order (e.g. sort=name:desc, sort=user.name) — order defaults to asc.
        // The last colon separates the order so relation paths stay intact.
        // No sort param -> the model orders by its key (Model.getMany).
        let sortBy: string | null = null;
        let sortOrder: string | null = null;
        if (typeof query.sort === 'string' && query.sort.trim() !== '') {
            const sep = query.sort.lastIndexOf(':');
            if (sep === -1) {
                sortBy = query.sort.trim();
                sortOrder = 'asc';
            } else {
                sortBy = query.sort.substring(0, sep).trim();
                // Whatever follows ':' is passed through — sort() rejects invalid orders
                sortOrder = query.sort.substring(sep + 1).trim();
            }
        }

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
