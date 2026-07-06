import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ErrorResponse, ErrorBasicResponse } from '../core/errors';
import { LanguageDict } from '../core/i18n';
import { Logger } from '../utils/Logger';
import { QueryBuilder } from '../orm/QueryBuilder';
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

    fastify.decorateReply('handleError', function (this: FastifyReply, error: any, data: Record<string, unknown> = {}) {
        const response = QueryBuilder.errorHandler(error, data, this.request?.language || null);
        return this.code(response.status_code).send(response);
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

    // Global error handler — the single sink for ALL route errors. Routes do not need
    // their own try/catch: thrown ErrorResponses are translated, Prisma errors are
    // classified via QueryBuilder.errorHandler, and unexpected 5xx are masked in
    // production. All responses carry the machine-readable `key` (+ `data`) contract.
    fastify.setErrorHandler((error, request, reply) => {
        const language = request.language || 'en_US';

        if (error instanceof ErrorResponse) {
            return reply.code(error.status_code).send(error.toJSON(language));
        }

        if (error instanceof ErrorBasicResponse) {
            return reply.code(error.status_code).send(error.toJSON());
        }

        // Fastify-generated 4xx (validation, body parsing, ...) carry client-safe
        // messages and their own status codes — pass them through
        const fastifyStatus = (error as any).statusCode;
        if (fastifyStatus && fastifyStatus < 500) {
            Logger.error(error);
            return reply.code(fastifyStatus).send({ status_code: fastifyStatus, message: (error as Error).message });
        }

        // Everything else (Prisma errors, TypeErrors, ...): classify, translate,
        // and mask in production. request.body feeds P2002 duplicate-value extraction.
        const response = QueryBuilder.errorHandler(error, (request.body as Record<string, unknown>) || {}, language);
        return reply.code(response.status_code).send(response);
    });
};

export default fp(responsePlugin, { name: 'rapidd-response' });
