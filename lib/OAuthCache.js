const Redis = require("ioredis");

class OAuthCache {
  constructor(redisConfig = {}) {
    this.memoryCache = new Map();
    this.redisClient = null;
    this.useRedis = false;
    
    this.initRedis(redisConfig);
  }

  initRedis(config) {
    try {
      this.redisClient = new Redis({
        host: process.env.REDIS_HOST || config.host || "localhost",
        port: Number(process.env.REDIS_PORT || config.port || 6379),
        db: Number(process.env.REDIS_DB || config.db || 0),
        lazyConnect: true,
        connectTimeout: 2000,
        retryStrategy: () => null, // No retries, fail fast
        maxRetriesPerRequest: 1,
        ...config
      });

      this.redisClient.on("ready", () => {
        this.useRedis = true;
      });

      this.redisClient.on("error", () => {
        this.useRedis = false;
      });

      // Try to connect
      this.redisClient.connect().catch(() => {
        this.useRedis = false;
      });
    } catch {
      this.useRedis = false;
    }
  }

  async get(key) {
    // Try Redis first
    if (this.useRedis) {
      try {
        const data = await this.redisClient.get(`oauth:${key}`);
        if (data) return JSON.parse(data);
      } catch {
        this.useRedis = false;
      }
    }

    // Fallback to memory
    const cached = this.memoryCache.get(key);
    if (!cached) return null;

    // Check expiration
    if (Date.now() > cached.expires) {
      this.memoryCache.delete(key);
      return null;
    }

    return cached.data;
  }

  async set(key, data, ttlSeconds = 3600) {
    const expires = Date.now() + (ttlSeconds * 1000);
    
    // Try Redis first
    if (this.useRedis) {
      try {
        await this.redisClient.setex(`oauth:${key}`, ttlSeconds, JSON.stringify(data));
        return;
      } catch {
        this.useRedis = false;
      }
    }

    // Fallback to memory
    this.memoryCache.set(key, { data, expires });
  }

  async delete(key) {
    // Try Redis first
    if (this.useRedis) {
      try {
        await this.redisClient.del(`oauth:${key}`);
      } catch {
        this.useRedis = false;
      }
    }

    // Always delete from memory
    this.memoryCache.delete(key);
  }

  async flush() {
    // Try Redis first
    if (this.useRedis) {
      try {
        const keys = await this.redisClient.keys("oauth:*");
        if (keys.length > 0) {
          await this.redisClient.del(keys);
        }
      } catch {
        this.useRedis = false;
      }
    }

    // Always clear memory
    this.memoryCache.clear();
  }

  // Utility method to check status
  getStatus() {
    return {
      redis: this.useRedis,
      memorySize: this.memoryCache.size
    };
  }
}

// Export singleton instance
const cache = new OAuthCache();

module.exports = {
  get: (key) => cache.get(key),
  set: (key, data, ttl) => cache.set(key, data, ttl),
  delete: (key) => cache.delete(key),
  flush: () => cache.flush(),
  status: () => cache.getStatus(),
  
  // For custom configuration
  create: (config) => new OAuthCache(config)
};