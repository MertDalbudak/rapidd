import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { createRedisClient, isRedisConfigured } from '../core/redis';
import { ErrorResponse } from '../core/errors';
import type { RateLimitPathConfig, RateLimitResult } from '../types';

/** Reconnect backoff cap. Reconnects never stop: a long Redis outage must not leave the
 *  limiter on per-process memory until the next restart. */
const REDIS_MAX_TIMEOUT = 1000 * 10;

/**
 * Bucket used by every path that matches no entry in `config/rate-limit.json`.
 * One bucket per IP — NOT one per path — so a client cannot multiply its budget
 * by spreading requests across endpoints.
 */
const DEFAULT_SCOPE = '*';

/** Per-request refund ticket, consumed by the onResponse hook. */
const REFUND = Symbol('rapidd.rateLimitRefund');

interface RefundTicket {
    key: string;
    token: string;
    store: 'redis' | 'memory';
}

interface RateLimiterOptions {
    windowMs?: number;
    maxRequests?: number;
    /** Inject path configs directly instead of reading `config/rate-limit.json` (tests). */
    rateLimits?: Record<string, RateLimitPathConfig>;
}

class RateLimiter {
    private useRedis: boolean;
    private defaultWindowMs: number;
    private defaultMaxRequests: number;
    private rateLimits: Record<string, RateLimitPathConfig>;
    private scopeKeys: string[];
    private redis: Redis | null = null;
    private requests: Map<string, { count: number; resetTime: number }> | null = null;
    private lastCleanup = 0;

    constructor(options: RateLimiterOptions = {}) {
        this.useRedis = isRedisConfigured();
        this.defaultWindowMs = options.windowMs ?? (Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000);
        this.defaultMaxRequests = options.maxRequests ?? (Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100);

        if (options.rateLimits) {
            this.rateLimits = options.rateLimits;
        } else {
            try {
                const path = require('path');
                this.rateLimits = require(path.join(process.cwd(), 'config', 'rate-limit.json'));
            } catch {
                this.rateLimits = {};
            }
        }

        // Longest first, so /api/v1/upload wins over /api for /api/v1/upload.
        this.scopeKeys = Object.keys(this.rateLimits).sort((a, b) => b.length - a.length);

        // Always present: Redis may be configured but not yet ready, and requests
        // arriving in that window are served from memory.
        this.ensureMemoryStore();

        if (this.useRedis) {
            this.redis = createRedisClient({
                db: Number(process.env.REDIS_DB_RATE_LIMIT || 0),
                lazyConnect: true,
                connectTimeout: 1000,
                retryStrategy: (times: number) => Math.min(times * 1000, REDIS_MAX_TIMEOUT),
                maxRetriesPerRequest: 3,
            });

            // Back to Redis as soon as it is usable again (also after an outage)
            this.redis.on('ready', () => {
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

    /**
     * Resolve a request path to the config that governs it and the bucket ("scope")
     * its requests are counted against.
     *
     * Matching is longest-prefix: a config key covers itself and everything beneath it,
     * so `/api` governs `/api/v1/users`. Counting is keyed on the matched key rather than
     * the request path, which makes a config entry an aggregate cap over its whole subtree —
     * otherwise a client could spend the limit once per endpoint. Paths matching nothing
     * share DEFAULT_SCOPE for the same reason.
     *
     * The `key + '/'` guard keeps `/api` from swallowing a sibling like `/apidocs`.
     */
    private resolveScope(reqPath: string): { config: RateLimitPathConfig; scope: string } {
        for (const key of this.scopeKeys) {
            const prefix = key.endsWith('/') ? key : `${key}/`;
            if (reqPath === key || reqPath.startsWith(prefix)) {
                return { config: this.rateLimits[key], scope: key };
            }
        }
        return {
            config: {
                maxRequests: this.defaultMaxRequests,
                windowMs: this.defaultWindowMs,
                ignoreSuccessfulRequests: false,
            },
            scope: DEFAULT_SCOPE,
        };
    }

    private fallbackToMemory(): void {
        this.useRedis = false;
        this.ensureMemoryStore();
    }

    /**
     * The memory store must exist even while Redis is the intended backend: between
     * `connect()` and `ready` — and on every blip after — `isRedisAvailable()` is false
     * and requests are served from memory. Leaving it null until an error fired meant
     * every request during a perfectly normal Redis connect window hit a TypeError.
     */
    private ensureMemoryStore(): Map<string, { count: number; resetTime: number }> {
        if (!this.requests) this.requests = new Map();
        return this.requests;
    }

    private isRedisAvailable(): boolean {
        return this.useRedis && this.redis !== null && this.redis.status === 'ready';
    }

    private setRateLimitHeaders(reply: FastifyReply, max: number, count: number, reset: number): void {
        reply.header('X-RateLimit-Limit', max);
        reply.header('X-RateLimit-Remaining', Math.max(0, max - count));
        // Epoch *seconds*, per the convention every other rate-limit implementation follows.
        // This previously emitted milliseconds, which a client doing the conventional
        // `new Date(reset * 1000)` would read as a date ~56,000 years out.
        reply.header('X-RateLimit-Reset', Math.ceil(reset / 1000));
    }

    /**
     * The path to match scopes against.
     *
     * Fastify percent-decodes before routing, so `/api/v1/log%69n` reaches the
     * `/api/v1/login` handler. Matching the raw URL would let an attacker encode one
     * character to miss a strict scope and land in a looser one — a real bypass of a
     * login limit. Decoding once mirrors what the router did (a double-encoded
     * `%2569` stays `%69` here and 404s there, so the two views agree).
     */
    private normalizePath(url: string): string {
        const raw = url.split('?')[0];
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw; // malformed encoding — Fastify rejects it anyway
        }
    }

    async checkLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const reqPath = this.normalizePath(request.url);
        const { config: pathConfig, scope } = this.resolveScope(reqPath);
        const key = `${request.ip} - ${scope}`;
        const now = Date.now();

        // ?? not ||: a configured 0 means "allow nothing", not "use the default".
        const windowMs = pathConfig.windowMs ?? this.defaultWindowMs;
        const maxRequests = pathConfig.maxRequests ?? this.defaultMaxRequests;

        let result: RateLimitResult;
        let store: 'redis' | 'memory';

        if (this.isRedisAvailable()) {
            try {
                result = await this.checkRateLimitRedis(key, windowMs, maxRequests);
                store = 'redis';
            } catch {
                // A Redis blip (failover, MISCONF, partition) rejects in-flight EVALs even
                // though status was 'ready' when we checked. Serving the request from memory
                // degrades the limit to per-process; letting the rejection escape would 500
                // an otherwise fine request.
                this.fallbackToMemory();
                result = this.checkRateLimitMemory(key, windowMs, maxRequests, now);
                store = 'memory';
            }
        } else {
            result = this.checkRateLimitMemory(key, windowMs, maxRequests, now);
            store = 'memory';
        }

        this.setRateLimitHeaders(reply, maxRequests, result.count, result.resetTime);

        if (!result.allowed) {
            // Tells the client how long to back off. Delta-seconds (RFC 9110) rather than a
            // date, so it can't be misread across a clock difference. At least 1: a 0 would
            // invite an immediate retry that is certain to be rejected again.
            reply.header('Retry-After', Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
            throw new ErrorResponse(429, 'rate_limit_exceeded');
        }

        // Every request is counted up front — that's what bounds a burst of in-flight
        // requests. Under ignoreSuccessfulRequests the successful ones are handed back
        // in onResponse, once a status code exists to judge them by.
        if (pathConfig.ignoreSuccessfulRequests && result.token) {
            (request as any)[REFUND] = { key, token: result.token, store } satisfies RefundTicket;
        }
    }

    /**
     * Give back the budget a successful request consumed, for paths configured with
     * `ignoreSuccessfulRequests` — leaving only failures counted, which is what makes a
     * login limit measure brute-force attempts rather than legitimate sign-ins.
     *
     * Best-effort by design: a refund that fails must never turn a served response into
     * an error, and worst case the client is charged for a request it should not have been.
     */
    async refundIfSuccessful(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const ticket = (request as any)[REFUND] as RefundTicket | undefined;
        if (!ticket) return;
        delete (request as any)[REFUND];

        if (reply.statusCode >= 400) return; // a failure — it keeps its charge

        try {
            if (ticket.store === 'redis') {
                if (this.isRedisAvailable()) {
                    await this.redis!.zrem(`rate_limit:${ticket.key}`, ticket.token);
                }
                return;
            }
            const entry = this.requests?.get(ticket.key);
            // Window stamp must still match: if it rolled over, this request's charge is
            // already gone and decrementing would steal from the new window.
            if (entry && String(entry.resetTime) === ticket.token && entry.count > 0) {
                entry.count--;
            }
        } catch {
            /* never fail a response over a refund */
        }
    }

    private async checkRateLimitRedis(
        key: string, windowMs: number, maxRequests: number
    ): Promise<RateLimitResult> {
        const redisKey = `rate_limit:${key}`;
        // Member uniqueness comes from the caller, not a Redis counter. The previous
        // INCR-based scheme created a sibling `<key>:seq` that nothing ever expired, so
        // every (ip, scope) ever seen leaked a permanent key. A UUID is unique across
        // processes too, which an INCR per instance would not have been, and it gives
        // the refund path an exact member to ZREM.
        const member = randomUUID();

        const luaScript = `
            local key = KEYS[1]
            local max_requests = tonumber(ARGV[1])
            local window_ms = tonumber(ARGV[2])
            local member = ARGV[3]
            -- The window is measured by Redis's clock, not the caller's. Scores set from
            -- each app instance's local clock made the limit depend on those clocks agreeing:
            -- an instance drifting by a full window would have its entries treated as expired
            -- by every other instance, and its traffic would stop counting at all.
            local t = redis.call('TIME')
            local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
            local window_start = now - window_ms
            redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
            local current_count = redis.call('ZCARD', key)
            if current_count >= max_requests then
                local reset_time = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
                local oldest_time = tonumber(reset_time[2]) or now
                local reset_at = oldest_time + window_ms
                -- reset_at and the delta are both on Redis's clock; the caller must not
                -- derive the delta itself by subtracting its own local time.
                return {0, current_count, reset_at, reset_at - now}
            else
                redis.call('ZADD', key, now, member)
                redis.call('PEXPIRE', key, window_ms)
                return {1, current_count + 1, now + window_ms, window_ms}
            end
        `;

        const result = await this.redis!.eval(
            luaScript, 1, redisKey, maxRequests, windowMs, member
        ) as number[];
        return {
            allowed: result[0] === 1,
            count: result[1],
            resetTime: result[2],
            retryAfterMs: result[3],
            token: member,
        };
    }

    private checkRateLimitMemory(
        key: string, windowMs: number, maxRequests: number, now: number
    ): RateLimitResult {
        // Sweep expired entries at most once per window — per-key expiry is handled
        // lazily below, so the full-map sweep is purely memory reclamation and must
        // not run on every request (it is O(active clients) per call)
        if (now - this.lastCleanup >= this.defaultWindowMs) {
            this.cleanup(now);
            this.lastCleanup = now;
        }
        // A configured 0 closes the path outright. Checked before the fresh-window paths
        // below, which would otherwise wave through the first request of every window
        // (Redis, which compares before inserting, already refuses it).
        if (maxRequests < 1) {
            return { allowed: false, count: 0, resetTime: now + windowMs, retryAfterMs: windowMs };
        }

        const requests = this.ensureMemoryStore();
        const userData = requests.get(key);

        if (!userData) {
            const resetTime = now + windowMs;
            requests.set(key, { count: 1, resetTime });
            return { allowed: true, count: 1, resetTime, retryAfterMs: windowMs, token: String(resetTime) };
        }

        if (now > userData.resetTime) {
            userData.count = 1;
            userData.resetTime = now + windowMs;
            return {
                allowed: true, count: 1, resetTime: userData.resetTime,
                retryAfterMs: windowMs, token: String(userData.resetTime),
            };
        }

        if (userData.count >= maxRequests) {
            return {
                allowed: false, count: userData.count, resetTime: userData.resetTime,
                retryAfterMs: userData.resetTime - now,
            };
        }

        userData.count++;
        return {
            allowed: true, count: userData.count, resetTime: userData.resetTime,
            retryAfterMs: userData.resetTime - now, token: String(userData.resetTime),
        };
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
        const redis = this.redis;
        this.redis = null;
        this.useRedis = false;
        if (redis && redis.status !== 'end') {
            // quit() rejects on an already-closed connection — never fail a shutdown over it
            await redis.quit().catch(() => redis.disconnect());
        }
    }
}

let globalRateLimiter: RateLimiter | null = null;

/**
 * The rate limiter serving the most recently built app, for code outside a request
 * (scripts, jobs). Falls back to constructing one from `config/rate-limit.json` + env
 * if no app has been built in this process.
 */
function getRateLimiter(): RateLimiter {
    if (!globalRateLimiter) {
        globalRateLimiter = new RateLimiter();
    }
    return globalRateLimiter;
}

const rateLimiterPlugin: FastifyPluginAsync<RateLimiterOptions> = async (fastify, options) => {
    // One limiter per registration rather than a process-wide singleton: options passed to
    // register() are honoured (they used to be typed and then silently dropped), and each
    // app owns the instance it closes — sharing one meant closing app A left app B holding
    // a quit Redis connection, silently degrading it to per-process memory.
    const limiter = new RateLimiter(options);
    globalRateLimiter = limiter;

    fastify.addHook('onRequest', async (request, reply) => {
        if (process.env.NODE_ENV !== 'production') return;
        // Routes can opt out: { config: { rateLimit: false } } (health probes, webhooks...)
        if ((request.routeOptions?.config as { rateLimit?: boolean } | undefined)?.rateLimit === false) return;
        await limiter.checkLimit(request, reply);
    });

    // Refunds successful requests on paths configured with `ignoreSuccessfulRequests`.
    // Must be onResponse: the status code doesn't exist yet at onRequest time.
    fastify.addHook('onResponse', async (request, reply) => {
        if (process.env.NODE_ENV !== 'production') return;
        await limiter.refundIfSuccessful(request, reply);
    });

    fastify.addHook('onClose', async () => {
        await limiter.close();
        // Don't leave getRateLimiter() handing out an instance whose Redis is quit.
        if (globalRateLimiter === limiter) globalRateLimiter = null;
    });
};

export default fp(rateLimiterPlugin, { name: 'rapidd-rate-limiter' });
export { RateLimiter, getRateLimiter };
export type { RateLimiterOptions };
