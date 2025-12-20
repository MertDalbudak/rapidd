const path = require('path');
const Redis = require('ioredis');
const { LanguageDict } = require('../lib/LanguageDict');

// Initialize LanguageDict once at module load
LanguageDict.initialize(process.env.STRINGS_PATH, "en-US");

const configPath = "./config/rate-limit.json";
const redisMaxTimout = 1000 * 10; // 10 seconds
const redisMaxRetries = 60;

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
     * 
     * @param {number} status_code 
     * @param {string} error_message
     * @returns 
     */
    static errorResponseBody = (status_code, error_message) => {
        return (new ErrorBasicResponse(error_message, status_code)).toJSON();
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
        throw new ErrorResponse(403, "insufficient_permissions");

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
                    throw new ErrorResponse(429, "rate_limit_exceeded");
                }

                next();
            } catch (err) {
                if (this.isRedisAvailable() && err.name === "ReplyError") {
                    console.warn("Redis error, falling back to memory:", err.message);
                    this.fallbackToMemory();

                    const effectiveMaxRequests = pathConfig?.maxRequests || maxRequests;
                    const fallbackResult = this.checkRateLimitMemory(
                        key,
                        pathConfig?.windowMs || windowMs,
                        effectiveMaxRequests,
                        Date.now(),
                    );
                    this.setRateLimitHeaders(res, effectiveMaxRequests, fallbackResult.count, fallbackResult.resetTime);

                    if (!fallbackResult.allowed) {
                        throw new ErrorResponse(429, "rate_limit_exceeded");
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
                    throw new ErrorResponse(429, "rate_limit_exceeded");
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

class ErrorBasicResponse extends Error {
    /**
     * @param {string} message - Error message
     * @param {number} status_code - HTTP status code
     *
     * @example
     * new ErrorBasicResponse("Record not found", 404)
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

class ErrorResponse extends ErrorBasicResponse {
    /**
     * 
     * @param {number} status_code 
     * @param {string} message 
     * @param {object?} data 
     * 
     * @returns {status_code: number, message: string, data: object|null}
     */
    constructor(status_code, message, data = null) {
        super(message, status_code);
        this.data = data;
    }
    toJSON(language = "en-US") {
        return {
            status_code: this.status_code,
            message: LanguageDict.get(this.message, this.data, language)
        };
    }
}

class Response {
    /**
     * @param {number} status_code 
     * @param {string} message 
     * @param {object|null} data 
     */
    constructor(status_code, message, data = null) {
        this.status_code = status_code;
        this.message = message;
        this.data = data;
    }

    /**
     * 
     * @param {string} language 
     * @returns {{status_code: number, message: string, data: object|null}}
     */
    toJSON(language = "en-US") {
        return {
            status_code: this.status_code,
            message: LanguageDict.get(this.message, this.data, language),
            data: this.data
        };
    }
}

/**
 * Middleware to attach Api utilities to req/res objects
 * This eliminates the need to import Api in every route file
 *
 * Usage in main.js:
 *   const { apiMiddleware } = require('./src/Api');
 *   app.use(apiMiddleware());
 *
 * Then in route files:
 *   res.sendList(data, meta);
 *   res.sendError(statusCode, message);
 *   throw new req.ErrorResponse("error_code", 400);
 *
 * @param {Object} options - Configuration options
 * @param {boolean} options.attachToRequest - Attach utilities to req object (default: true)
 * @param {boolean} options.attachToResponse - Attach utilities to res object (default: true)
 * @returns {Function} Express middleware
 */
function apiMiddleware(options = {}) {
    const {
        attachToRequest = true,
        attachToResponse = true
    } = options;

    return (req, res, next) => {
        // Attach to request object for throwing errors easily
        if (attachToRequest) {
            req.Api = Api;
            req.getTranslation = (...args) => LanguageDict.get(args[0], args[1] || null, args[2] || (req.language || "en-US"));
        }

        // Attach to response object for sending formatted responses
        if (attachToResponse) {
            /**
             * Send a response with optional translation support
             * @param {number} status_code - HTTP status code
             * @param {string} message - Message or translation key
             * @param {Object} params - Translation parameters (optional)
             * @returns
             */
            res.sendResponse = (status_code, message, params = null) => {
                const translatedMessage = LanguageDict.get(message, params, req.language || "en-US");
                return res.status(status_code).json({'status_code': status_code, 'message': translatedMessage});
            };
            
            
            res.ErrorResponse = ErrorResponse;
            /**
             * Send a list response with pagination metadata
             * @param {Object[]} data - Array of data items
             * @param {{take: number, skip: number, total: number}} meta - Pagination metadata
             */
            res.sendList = function(data, meta) {
                return res.json(Api.getListResponseBody(data, meta));
            };

            /**
             * Send an error response with translation support
             * @param {number} status_code - HTTP status code
             * @param {string} message - Error message or translation key
             * @param {Object|number} paramsOrCode - Translation parameters or error code
             * @param {number} code - Error code (if paramsOrCode is params object)
             */
            res.sendError = (status_code, message, data = null) => {
                const language = req.language || "en-US";
                const error = new ErrorResponse(status_code, message, data);
                
                console.error(`Error ${status_code}: ${message}`);
                return res.status(status_code).json(error.toJSON(language));
            }
        }
        next();
    };
}

/**
 * Global rate limiter instance (singleton)
 * Initialized lazily on first access
 */
let globalRateLimiter = null;

/**
 * Get or create the global RateLimiter instance
 * @param {Object} redisConfig - Optional Redis configuration
 * @returns {RateLimiter}
 */
function getRateLimiter(redisConfig = {}) {
    if (!globalRateLimiter) {
        globalRateLimiter = new RateLimiter(redisConfig);
    }
    return globalRateLimiter;
}

/**
 * Convenience middleware for applying rate limiting
 * Uses a singleton RateLimiter instance for efficiency
 *
 * Usage:
 *   const { rateLimitMiddleware } = require('./src/Api');
 *   router.use(rateLimitMiddleware()); // Use defaults
 *   router.use(rateLimitMiddleware({ windowMs: 60000, maxRequests: 100 }));
 *
 * @param {Object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.maxRequests - Maximum requests per window
 * @param {Object} options.redisConfig - Redis configuration
 * @returns {Function} Express middleware
 */
function rateLimitMiddleware(options = {}) {
    const { windowMs, maxRequests, redisConfig } = options;
    const limiter = getRateLimiter(redisConfig);
    return limiter.createLimiter(windowMs, maxRequests);
}


function getTranslation(key, data = null, language = "en-US") {
    return LanguageDict.get(key, data, language);
}

module.exports = {
    Api,
    RateLimiter,
    Response,
    ErrorResponse,
    apiMiddleware,
    rateLimitMiddleware,
    getRateLimiter,
    getTranslation
};