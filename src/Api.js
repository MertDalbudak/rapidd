const path = require('path');
const Redis = require('ioredis');

const configPath = "./config/rate-limit.json";
const redisMaxTimout = 1000 * 10; // 10 seconds
const redisMaxRetries = 60;

// BigInt serialization
BigInt.prototype.toJSON = function () {
    const num = Number(this);
    if (!Number.isSafeInteger(num)) {
        throw new Error("BigInt value is too large to convert safely");
    }
    return num;
};


class Api {
    /**
     * @param {Object[]} data
     * @param {{take: number, skip: number, total: number}} meta
     * @returns {{data: Object[], meta: {count: number, limit: number, offset: number, total?: number}}}
     */
    static getListResponseBody = (data, meta) => {
        return {
            data: data,
            meta: {
                ...(!isNaN(meta.total) ? { total: meta.total } : {}),
                count: data.length,
                limit: meta.take,
                offset: meta.skip,
                ...(!isNaN(meta.total) ? { hasMore: meta.skip + meta.take < meta.total } : {}),
            },
        };
    };

    /**
     * @param {number} status_code
     * @param {number} code
     * @param {string} error_message
     * @returns {{'status_code': number, 'error': number, 'message': string}}
     */
    static errorResponseBody = (status_code, code, error_message) => {
        return {
            status_code: status_code,
            ...(code != null ? { error_code: code } : {}),
            message: error_message?.message || error_message,
        };
    };

    /**
     *
     * @param {Object} user
     * @param {string[]} required_roles
     */
    static checkPermission = (user, required_roles) => {
        if(user.role == "application" || required_roles.includes(user.role)){
            return true;
        }
        throw new ErrorResponse("Insufficient permissions", 403);
        
    };

    /**
     * Wraps an async route handler to catch promise rejections and pass errors to Express error-handling middleware.
     * @param {Function} fn - The async route handler function to wrap.
     * @returns {Function} An Express middleware function that handles promise rejections.
     */
    static asyncHandler = (fn) => (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

class RateLimiter {
    /**
     * @param {object} redisConfig - Redis configuration options
     */
    constructor(redisConfig = {}) {
        this.useRedis = process.env.REDIS_HOST || redisConfig.host;
        this.defaultWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
        this.defaultMaxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

        // Load config
        try {
            const fullPath = path.resolve(configPath);
            this.rateLimits = require(fullPath);
        } catch (e) {
            console.warn("Rate limit config could not be loaded. Using defaults.");
            this.rateLimits = {};
        }

        if (this.useRedis) {
            this.redis = new Redis({
                host: process.env.REDIS_HOST || "localhost",
                port: Number(process.env.REDIS_PORT || 6379),
                db: Number(process.env.REDIS_DB_RATE_LIMIT || 0),
                lazyConnect: true,
                connectTimeout: 1000,
                retryStrategy: (times) => {
                    if(times <= redisMaxRetries){
                        return Math.min(times * 1000, redisMaxTimout);
                    }
                    this.redis.quit();
                    this.fallbackToMemory();
                },
                maxRetriesPerRequest: 3,
                ...redisConfig,
            });
            this.redis.on("connect", async () => {
                console.warn("Redis connected!");
                this.useRedis = true;
            });
            
            this.redis.connect().catch(async (err) => {
                console.warn("Redis connection failed:", err.message);
                this.fallbackToMemory();
            });

            this.redis.on("error", async (err) => {
                console.warn("Redis runtime error:", err.message);
                this.fallbackToMemory();
            });
        } else {
            this.fallbackToMemory();
        }
    }

    getPathConfig(reqPath) {
        return this.rateLimits[reqPath] || {
            maxRequests: this.defaultMaxRequests,
            windowMs: this.defaultWindowMs,
            ignoreSuccessfulRequests: false
        };
    }

    /**
     * Switches to in-memory fallback mode.
     */
    fallbackToMemory() {
        this.useRedis = false;
        if (!this.requests) this.requests = new Map();
    }

    /**
     * Checks if Redis is connected and available.
     * @returns {boolean}
     */
    isRedisAvailable() {
        return this.useRedis && this.redis && this.redis.status === "ready";
    }

    /**
     * Sets rate limit headers in the response.
     * @param {object} res - Express response object
     * @param {number} max - Max allowed requests
     * @param {number} count - Current request count
     * @param {number} reset - Reset timestamp in ms
     */
    setRateLimitHeaders(res, max, count, reset) {
        res.set({
            "X-RateLimit-Limit": max,
            "X-RateLimit-Remaining": Math.max(0, max - count),
            "X-RateLimit-Reset": reset,
        });
    }

    /**
     * Creates a rate limiter middleware (fixed window).
     * @param {number} [windowMs]
     * @param {number} [maxRequests]
     * @returns {Function} Express middleware
     */
    createLimiter(windowMs = this.defaultWindowMs, maxRequests = this.defaultMaxRequests) {
        return async (req, res, next) => {
            const req_path = req.originalUrl.split('?')[0];
            const pathConfig = this.getPathConfig(req_path);
            console.log(pathConfig);
            
            const key = `${req.ip || req.connection.remoteAddress} - ${req_path}`;
            const now = Date.now();

            try {
                let result;
                if (this.isRedisAvailable()) {
                    result = await this.checkRateLimitRedis(
                        key,
                        pathConfig?.windowMs || windowMs,
                        pathConfig?.maxRequests || maxRequests,
                        now
                    );
                } else {
                    result = this.checkRateLimitMemory(
                        key,
                        pathConfig?.windowMs || windowMs,
                        pathConfig?.maxRequests || maxRequests,
                        now
                    );
                }

                this.setRateLimitHeaders(res, pathConfig.maxRequests || maxRequests, result.count, result.resetTime);

                if (!result.allowed) {
                    throw new ErrorResponse("Rate limit exceeded", 429);
                }

                next();
            } catch (err) {
                if (this.isRedisAvailable() && err.name === "ReplyError") {
                    console.warn("Redis error, falling back to memory:", err.message);
                    this.fallbackToMemory();

                    const fallbackResult = this.checkRateLimitMemory(
                        key,
                        windowMs,
                        effectiveMaxRequests,
                        Date.now(),
                    );
                    this.setRateLimitHeaders(res, effectiveMaxRequests, fallbackResult.count, fallbackResult.resetTime);

                    if (!fallbackResult.allowed) {
                        throw new ErrorResponse("Rate limit exceeded", 429);
                    }

                    return next();
                }

                throw err;
            }
        };
    }

    /**
     * Performs rate limiting logic using Redis sorted sets.
     * @private
     * @param {string} key - Unique identifier
     * @param {number} windowMs
     * @param {number} maxRequests
     * @param {number} now - Current timestamp
     * @returns {Promise<{allowed: boolean, count: number, resetTime: number}>}
     */
    async checkRateLimitRedis(key, windowMs, maxRequests, now) {
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

        const result = await this.redis.eval(luaScript, 1, redisKey, windowStart, maxRequests, now, windowMs);
        console.log(result);
        
        return {
            allowed: result[0] === 1,
            count: result[1],
            resetTime: result[2],
        };
    }

    /**
     * Performs rate limiting logic in memory (for fallback).
     * @private
     * @param {string} key
     * @param {number} windowMs
     * @param {number} maxRequests
     * @param {number} now
     * @returns {{allowed: boolean, count: number, resetTime: number}}
     */
    checkRateLimitMemory(key, windowMs, maxRequests, now) {
        this.cleanup(now);

        const userData = this.requests.get(key);

        if (!userData) {
            this.requests.set(key, { count: 1, resetTime: now + windowMs });
            return { allowed: true, count: 1, resetTime: now + windowMs };
        }

        if (now > userData.resetTime) {
            userData.count = 1;
            userData.resetTime = now + windowMs;
            return { allowed: true, count: 1, resetTime: userData.resetTime };
        }

        if (userData.count >= maxRequests) {
            return {
                allowed: false,
                count: userData.count,
                resetTime: userData.resetTime,
            };
        }

        userData.count++;
        return {
            allowed: true,
            count: userData.count,
            resetTime: userData.resetTime,
        };
    }

    /**
     * Cleans up expired memory entries.
     * @param {number} now
     */
    cleanup(now) {
        if (!this.requests) return;

        for (const [key, value] of this.requests.entries()) {
            if (now > value.resetTime) {
                this.requests.delete(key);
            }
        }
    }

    /**
     * Creates a sliding window rate limiter middleware (Redis only).
     * @param {number} [windowMs]
     * @param {number} [maxRequests]
     * @returns {Function} Express middleware
     */
    createSlidingWindowLimiter(windowMs = this.defaultWindowMs, maxRequests = this.defaultMaxRequests) {
        return async (req, res, next) => {
            if (!this.isRedisAvailable()) {
                return this.createLimiter(windowMs, maxRequests)(req, res, next);
            }

            const key = `${req.ip || req.connection.remoteAddress} - ${req.url}`;
            const redisKey = `sliding_rate_limit:${key}`;
            const now = Date.now();
            const windowStart = now - windowMs;

            try {
                const luaScript = `
                    local key = KEYS[1]
                    local window_start = tonumber(ARGV[1])
                    local max_requests = tonumber(ARGV[2])
                    local now = tonumber(ARGV[3])
                    local window_ms = tonumber(ARGV[4])

                    redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
                    local current_count = redis.call('ZCARD', key)

                    if current_count >= max_requests then
                        return {0, current_count, now + window_ms}
                    else
                        redis.call('ZADD', key, now, tostring(now) .. ":" .. redis.call('INCR', key .. ":seq"))
                        redis.call('EXPIRE', key, math.ceil(window_ms / 1000))
                        return {1, current_count + 1, now + window_ms}
                    end
                `;

                const result = await this.redis.eval(luaScript, 1, redisKey, windowStart, maxRequests, now, windowMs);
                const allowed = result[0] === 1;
                const count = result[1];
                const resetTime = result[2];

                this.setRateLimitHeaders(res, maxRequests, count, resetTime);

                if (!allowed) {
                    throw new ErrorResponse("Rate limit exceeded", 429);
                }

                next();
            } catch (err) {
                console.error("Sliding window error, fallback to fixed:", err.message);
                return this.createLimiter(windowMs, maxRequests)(req, res, next);
            }
        };
    }

    /**
     * Gracefully closes the Redis connection if it exists.
     * @returns {Promise<void>}
     */
    async close() {
        if (this.redis) {
            await this.redis.quit();
        }
    }
}

class ErrorResponse extends Error {
    /**
     * @param {string} message
     * @param {number} status_code
     */
    constructor(message, status_code = 500) {
        super(message);
        this.status_code = status_code;
    }
    toJSON() {
        return {
            status_code: this.status_code,
            message: this.message,
        };
    }
}

module.exports = { Api, RateLimiter, ErrorResponse };