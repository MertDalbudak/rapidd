import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { ErrorResponse } from '../core/errors';
import type { RateLimitPathConfig, RateLimitResult } from '../types';

const REDIS_MAX_TIMEOUT = 1000 * 10;
const REDIS_MAX_RETRIES = 60;

interface RateLimiterOptions {
    windowMs?: number;
    maxRequests?: number;
    configPath?: string;
}

class RateLimiter {
    private useRedis: boolean;
    private defaultWindowMs: number;
    private defaultMaxRequests: number;
    private rateLimits: Record<string, RateLimitPathConfig>;
    private redis: Redis | null = null;
    private requests: Map<string, { count: number; resetTime: number }> | null = null;

    constructor() {
        this.useRedis = !!process.env.REDIS_HOST;
        this.defaultWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
        this.defaultMaxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

        try {
            const configPath = './config/rate-limit.json';
            const path = require('path');
            this.rateLimits = require(path.resolve(configPath));
        } catch {
            this.rateLimits = {};
        }

        if (this.useRedis) {
            this.redis = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: Number(process.env.REDIS_PORT || 6379),
                db: Number(process.env.REDIS_DB_RATE_LIMIT || 0),
                lazyConnect: true,
                connectTimeout: 1000,
                retryStrategy: (times: number) => {
                    if (times <= REDIS_MAX_RETRIES) {
                        return Math.min(times * 1000, REDIS_MAX_TIMEOUT);
                    }
                    this.redis?.quit();
                    this.fallbackToMemory();
                    return null;
                },
                maxRetriesPerRequest: 3,
            });

            this.redis.on('connect', () => {
                this.useRedis = true;
            });

            this.redis.connect().catch(() => {
                this.fallbackToMemory();
            });

            this.redis.on('error', () => {
                this.fallbackToMemory();
            });
        } else {
            this.fallbackToMemory();
        }
    }

    private getPathConfig(reqPath: string): RateLimitPathConfig {
        return this.rateLimits[reqPath] || {
            maxRequests: this.defaultMaxRequests,
            windowMs: this.defaultWindowMs,
            ignoreSuccessfulRequests: false,
        };
    }

    private fallbackToMemory(): void {
        this.useRedis = false;
        if (!this.requests) this.requests = new Map();
    }

    private isRedisAvailable(): boolean {
        return this.useRedis && this.redis !== null && this.redis.status === 'ready';
    }

    private setRateLimitHeaders(reply: FastifyReply, max: number, count: number, reset: number): void {
        reply.header('X-RateLimit-Limit', max);
        reply.header('X-RateLimit-Remaining', Math.max(0, max - count));
        reply.header('X-RateLimit-Reset', reset);
    }

    async checkLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const reqPath = request.url.split('?')[0];
        const pathConfig = this.getPathConfig(reqPath);
        const key = `${request.ip} - ${reqPath}`;
        const now = Date.now();

        const windowMs = pathConfig.windowMs || this.defaultWindowMs;
        const maxRequests = pathConfig.maxRequests || this.defaultMaxRequests;

        let result: RateLimitResult;

        if (this.isRedisAvailable()) {
            result = await this.checkRateLimitRedis(key, windowMs, maxRequests, now);
        } else {
            result = this.checkRateLimitMemory(key, windowMs, maxRequests, now);
        }

        this.setRateLimitHeaders(reply, maxRequests, result.count, result.resetTime);

        if (!result.allowed) {
            throw new ErrorResponse(429, 'rate_limit_exceeded');
        }
    }

    private async checkRateLimitRedis(
        key: string, windowMs: number, maxRequests: number, now: number
    ): Promise<RateLimitResult> {
        const redisKey = `rate_limit:${key}`;
        const windowStart = now - windowMs;

        const luaScript = `
            local key = KEYS[1]
            local window_start = tonumber(ARGV[1])
            local max_requests = tonumber(ARGV[2])
            local now = tonumber(ARGV[3])
            local window_ms = tonumber(ARGV[4])
            redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
            local current_count = redis.call('ZCARD', key)
            if current_count >= max_requests then
                local reset_time = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
                local oldest_time = tonumber(reset_time[2]) or now
                return {0, current_count, oldest_time + window_ms}
            else
                redis.call('ZADD', key, now, tostring(now) .. ":" .. redis.call('INCR', key .. ":seq"))
                redis.call('EXPIRE', key, math.ceil(window_ms / 1000))
                return {1, current_count + 1, now + window_ms}
            end
        `;

        const result = await this.redis!.eval(luaScript, 1, redisKey, windowStart, maxRequests, now, windowMs) as number[];
        return { allowed: result[0] === 1, count: result[1], resetTime: result[2] };
    }

    private checkRateLimitMemory(
        key: string, windowMs: number, maxRequests: number, now: number
    ): RateLimitResult {
        this.cleanup(now);
        const userData = this.requests!.get(key);

        if (!userData) {
            this.requests!.set(key, { count: 1, resetTime: now + windowMs });
            return { allowed: true, count: 1, resetTime: now + windowMs };
        }

        if (now > userData.resetTime) {
            userData.count = 1;
            userData.resetTime = now + windowMs;
            return { allowed: true, count: 1, resetTime: userData.resetTime };
        }

        if (userData.count >= maxRequests) {
            return { allowed: false, count: userData.count, resetTime: userData.resetTime };
        }

        userData.count++;
        return { allowed: true, count: userData.count, resetTime: userData.resetTime };
    }

    private cleanup(now: number): void {
        if (!this.requests) return;
        for (const [key, value] of this.requests.entries()) {
            if (now > value.resetTime) {
                this.requests.delete(key);
            }
        }
    }

    async close(): Promise<void> {
        if (this.redis) {
            await this.redis.quit();
        }
    }
}

let globalRateLimiter: RateLimiter | null = null;

function getRateLimiter(): RateLimiter {
    if (!globalRateLimiter) {
        globalRateLimiter = new RateLimiter();
    }
    return globalRateLimiter;
}

const rateLimiterPlugin: FastifyPluginAsync<RateLimiterOptions> = async (fastify) => {
    const limiter = getRateLimiter();

    fastify.addHook('onRequest', async (request, reply) => {
        if (process.env.NODE_ENV !== 'production') return;
        await limiter.checkLimit(request, reply);
    });

    fastify.addHook('onClose', async () => {
        await limiter.close();
    });
};

export default fp(rateLimiterPlugin, { name: 'rapidd-rate-limiter' });
export { RateLimiter, getRateLimiter };
