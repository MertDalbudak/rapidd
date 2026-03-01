import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ErrorResponse, ErrorBasicResponse } from '../core/errors';
import { LanguageDict } from '../core/i18n';
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
        const body = {
            data,
            meta: {
                ...(meta.total != null ? { total: meta.total } : {}),
                count: (data as unknown[]).length,
                limit: meta.take,
                offset: meta.skip,
                ...(meta.total != null ? { hasMore: meta.skip + meta.take < meta.total } : {}),
            },
        };
        return this.send(body);
    });

    fastify.decorateReply('sendError', function (this: FastifyReply, statusCode: number, message: string, data?: unknown) {
        const request = this.request;
        const language = request?.language || 'en_US';
        const error = new ErrorResponse(statusCode, message, data as Record<string, unknown> | null);
        console.error(`Error ${statusCode}: ${message}`);
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
                ? 'Something went wrong'
                : err.message || String(error);

        console.error(error);
        return reply.code(status).send({ status_code: status, message });
    });
};

export default fp(responsePlugin, { name: 'rapidd-response' });
