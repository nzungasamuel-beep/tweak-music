const redis = require('redis');
const logger = require('../utils/logger');

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: 0,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxRetriesPerRequest: null,
  lazyConnect: true,
  keepAlive: 30000,
  connectTimeout: 10000,
  commandTimeout: 5000,
  retryDelayOnClusterDown: 300
};

const client = redis.createClient(redisConfig);

// Event handlers
client.on('connect', () => {
  logger.info('✅ Redis connection established');
});

client.on('ready', () => {
  logger.info('🚀 Redis client ready');
});

client.on('error', (error) => {
  logger.error('❌ Redis connection error:', error);
});

client.on('end', () => {
  logger.warn('🔌 Redis connection closed');
});

client.on('reconnecting', () => {
  logger.info('🔄 Redis reconnecting...');
});

// Connect to Redis
client.connect().catch((error) => {
  logger.error('Failed to connect to Redis:', error);
});

// Cache helper functions
const cache = {
  async get(key) {
    try {
      const value = await client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error('Cache get error:', error);
      return null;
    }
  },

  async set(key, value, ttl = 3600) {
    try {
      await client.setEx(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error('Cache set error:', error);
      return false;
    }
  },

  async del(key) {
    try {
      await client.del(key);
      return true;
    } catch (error) {
      logger.error('Cache delete error:', error);
      return false;
    }
  },

  async exists(key) {
    try {
      const result = await client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Cache exists error:', error);
      return false;
    }
  },

  async incr(key) {
    try {
      return await client.incr(key);
    } catch (error) {
      logger.error('Cache increment error:', error);
      return 0;
    }
  },

  async expire(key, ttl) {
    try {
      await client.expire(key, ttl);
      return true;
    } catch (error) {
      logger.error('Cache expire error:', error);
      return false;
    }
  }
};

module.exports = { client, cache };
