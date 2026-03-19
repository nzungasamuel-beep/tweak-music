const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// Generate JWT tokens
const generateTokens = (user) => {
  const payload = {
    id: user.id,
    email: user.email,
    username: user.username,
    subscription_status: user.subscription_status
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h'
  });

  const refreshToken = jwt.sign(
    { id: user.id },
    JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
};

// Verify JWT token
const verifyToken = async (token, secret = JWT_SECRET) => {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
};

// Authentication middleware
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Access token is required'
        },
        timestamp: new Date().toISOString()
      });
    }

    const token = authHeader.substring(7);
    
    // Check if token is blacklisted
    const isBlacklisted = await cache.exists(`blacklist:${token}`);
    if (isBlacklisted) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'TOKEN_BLACKLISTED',
          message: 'Token has been revoked'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Verify token
    const decoded = await verifyToken(token);
    
    // Get user from database
    const user = await db('users')
      .where({ id: decoded.id, account_status: 'active' })
      .first();

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found or account inactive'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Update last login
    await db('users')
      .where({ id: user.id })
      .update({ last_login: new Date() });

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      username: user.username,
      full_name: user.full_name,
      subscription_status: user.subscription_status,
      account_status: user.account_status
    };

    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token'
      },
      timestamp: new Date().toISOString()
    });
  }
};

// Optional authentication (doesn't fail if no token)
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);
    const decoded = await verifyToken(token);
    
    const user = await db('users')
      .where({ id: decoded.id, account_status: 'active' })
      .first();

    if (user) {
      req.user = {
        id: user.id,
        email: user.email,
        username: user.username,
        full_name: user.full_name,
        subscription_status: user.subscription_status,
        account_status: user.account_status
      };
    }

    next();
  } catch (error) {
    // Don't fail the request for optional auth
    next();
  }
};

// Admin authentication middleware
const requireAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required'
      },
      timestamp: new Date().toISOString()
    });
  }

  // Check if user is admin (you might want to add an 'is_admin' field to users table)
  const isAdmin = await cache.exists(`admin:${req.user.id}`);
  
  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'INSUFFICIENT_PERMISSIONS',
        message: 'Admin privileges required'
      },
      timestamp: new Date().toISOString()
    });
  }

  next();
};

// Subscription check middleware
const requireSubscription = (requiredStatus = 'premium') => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required'
        },
        timestamp: new Date().toISOString()
      });
    }

    const userSubscription = req.user.subscription_status;
    
    if (requiredStatus === 'premium' && userSubscription !== 'premium') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'PREMIUM_REQUIRED',
          message: 'Premium subscription required for this feature'
        },
        timestamp: new Date().toISOString()
      });
    }

    next();
  };
};

// Rate limiting middleware for specific user
const userRateLimit = async (req, res, next) => {
  if (!req.user) {
    return next();
  }

  const key = `rate_limit:user:${req.user.id}`;
  const limit = req.user.subscription_status === 'premium' ? 200 : 100;
  const windowMs = 60 * 1000; // 1 minute

  try {
    const current = await cache.incr(key);
    
    if (current === 1) {
      await cache.expire(key, Math.ceil(windowMs / 1000));
    }

    if (current > limit) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'USER_RATE_LIMIT_EXCEEDED',
          message: 'Rate limit exceeded for this user'
        },
        timestamp: new Date().toISOString()
      });
    }

    next();
  } catch (error) {
    logger.error('User rate limiting error:', error);
    next();
  }
};

module.exports = {
  generateTokens,
  verifyToken,
  authenticate,
  optionalAuth,
  requireAdmin,
  requireSubscription,
  userRateLimit
};
