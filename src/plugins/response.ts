import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ErrorResponse, ErrorBasicResponse } from '../core/errors';
import { LanguageDict } from '../core/i18n';
import { Logger } from '../utils/Logger';
import { getEnv } from '../core/env';
import type { ListMeta } from '../types';

/**
 * API utilities plugin.
 * Decorates reply with sendList, sendError, sendResponse.
 * Decorates request with getTranslation.
 * Registers a global error handler for ErrorResponse.
 */
const responsePlugin: FastifyPluginAsync = async (fastify) => {
    // Decorate request
    fastify.decorateRequest('user', null);
    fastify.decorateRequest('remoteAddress', '');
    fastify.decorateRequest('getTranslation', function (this: FastifyRequest, key: string, data?: Record<string, unknown> | null, language?: string) {
        return LanguageDict.get(key, data ?? null, language || this.language || 'en_US');
    });

    // Decorate reply
    fastify.decorateReply('sendList', function (this: FastifyReply, data: unknown[], meta: ListMeta) {
        const count = (data as unknown[]).length;
        const hasTotal = meta.total != null;

        let responseMeta: Record<string, unknown>;

        if (meta.page != null && meta.pageSize != null) {
            // Page-based pagination
            const totalPages = hasTotal ? Math.ceil(meta.total! / meta.pageSize) : undefined;
            responseMeta = {
                ...(hasTotal ? { total: meta.total } : {}),
                count,
                page: meta.page,
                pageSize: meta.pageSize,
                ...(totalPages != null ? { totalPages } : {}),
                hasNextPage: hasTotal ? meta.page < totalPages! : meta.hasMore ?? count >= meta.pageSize,
            };
        } else {
            // Offset-based pagination (default)
            responseMeta = {
                ...(hasTotal ? { total: meta.total } : {}),
                count,
                limit: meta.take,
                offset: meta.skip,
                hasMore: hasTotal ? meta.skip + meta.take < meta.total! : meta.hasMore ?? count >= meta.take,
            };
        }

        return this.send({ data, meta: responseMeta });
    });

    fastify.decorateReply('sendError', function (this: FastifyReply, statusCode: number, message: string, data?: unknown) {
        const request = this.request;
        const language = request?.language || 'en_US';
        const error = new ErrorResponse(statusCode, message, data as Record<string, unknown> | null);
        Logger.error(message, { statusCode });
        return this.code(statusCode).send(error.toJSON(language));
    });

    fastify.decorateReply('sendResponse', function (this: FastifyReply, statusCode: number, message: string, params?: unknown) {
        const request = this.request;
        const language = request?.language || 'en_US';
        const translatedMessage = LanguageDict.get(message, params as Record<string, unknown> | null, language);
        return this.code(statusCode).send({ status_code: statusCode, message: translatedMessage });
    });

    // Set remote address (Fastify resolves X-Forwarded-For when trustProxy is enabled)
    fastify.addHook('onRequest', async (request) => {
        request.remoteAddress = request.ip;
    });

    // Global error handler
    fastify.setErrorHandler((error, request, reply) => {
        const language = request.language || 'en_US';
        const status = (error as any).status_code || (error as any).statusCode || 500;

        if (error instanceof ErrorResponse) {
            return reply.code(status).send(error.toJSON(language));
        }

        if (error instanceof ErrorBasicResponse) {
            return reply.code(status).send(error.toJSON());
        }

        const err = error as Error;
        const message =
            Object.getPrototypeOf(err).constructor === Error && process.env.NODE_ENV === 'production'
                ? LanguageDict.get('internal_server_error', null, language)
                : err.message || String(error);

        Logger.error(error);
        return reply.code(status).send({ status_code: status, message });
    });
};

export default fp(responsePlugin, { name: 'rapidd-response' });
