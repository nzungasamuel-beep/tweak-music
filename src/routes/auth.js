const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { cache } = require('../config/redis');
const { generateTokens, verifyToken } = require('../middleware/auth');
const { sendEmail } = require('../utils/emailService');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input data',
        details: errors.array()
      },
      timestamp: new Date().toISOString()
    });
  }
  next();
};

// POST /auth/register
router.post('/register', [
  body('username')
    .isLength({ min: 3, max: 50 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username must be 3-50 characters and contain only letters, numbers, and underscores'),
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, and number'),
  body('full_name')
    .isLength({ min: 1, max: 100 })
    .withMessage('Full name is required'),
  body('date_of_birth')
    .optional()
    .isISO8601()
    .withMessage('Valid date of birth required'),
  body('country')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('Valid country code required')
], handleValidationErrors, async (req, res) => {
  try {
    const { username, email, password, full_name, date_of_birth, country } = req.body;

    // Check if user already exists
    const existingUser = await db('users')
      .where('email', email)
      .orWhere('username', username)
      .first();

    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: {
          code: existingUser.email === email ? 'EMAIL_ALREADY_EXISTS' : 'USERNAME_ALREADY_EXISTS',
          message: existingUser.email === email ? 'Email already registered' : 'Username already taken'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create user
    const [user] = await db('users')
      .insert({
        username,
        email,
        password_hash: passwordHash,
        full_name,
        date_of_birth,
        country,
        account_status: 'active',
        subscription_status: 'free'
      })
      .returning(['id', 'username', 'email', 'full_name', 'account_status', 'subscription_status']);

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);

    // Store refresh token in cache
    await cache.set(`refresh_token:${user.id}`, refreshToken, 7 * 24 * 60 * 60); // 7 days

    // Send verification email
    const verificationToken = uuidv4();
    await db('email_verification_tokens').insert({
      user_id: user.id,
      token: verificationToken,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    });

    await sendEmail({
      to: email,
      subject: 'Verify your Tweak Music account',
      template: 'email-verification',
      data: {
        full_name,
        verification_link: `${process.env.API_BASE_URL}/auth/verify-email?token=${verificationToken}`
      }
    });

    // Log activity
    await db('user_activity_log').insert({
      user_id: user.id,
      action_type: 'user_register',
      metadata: { ip_address: req.ip, user_agent: req.get('User-Agent') }
    });

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          full_name: user.full_name,
          email_verified: false,
          account_status: user.account_status,
          subscription_status: user.subscription_status
        },
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600
      },
      message: 'Account created successfully. Please check your email to verify your account.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// POST /auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  body('remember_me').optional().isBoolean()
], handleValidationErrors, async (req, res) => {
  try {
    const { email, password, remember_me } = req.body;

    // Find user
    const user = await db('users')
      .where({ email, account_status: 'active' })
      .first();

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);

    // Store refresh token
    const expiry = remember_me ? 30 * 24 * 60 * 60 : 7 * 24 * 60 * 60; // 30 days or 7 days
    await cache.set(`refresh_token:${user.id}`, refreshToken, expiry);

    // Update last login
    await db('users')
      .where({ id: user.id })
      .update({ last_login: new Date() });

    // Log activity
    await db('user_activity_log').insert({
      user_id: user.id,
      action_type: 'user_login',
      metadata: { 
        ip_address: req.ip, 
        user_agent: req.get('User-Agent'),
        remember_me 
      }
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          full_name: user.full_name,
          email_verified: user.email_verified,
          account_status: user.account_status,
          subscription_status: user.subscription_status
        },
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600
      },
      message: 'Login successful',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// POST /auth/google
router.post('/google', [
  body('id_token').notEmpty().withMessage('Google ID token is required')
], handleValidationErrors, async (req, res) => {
  try {
    const { id_token } = req.body;

    // Verify Google token (you'd need to implement Google token verification)
    // For now, we'll simulate it
    const googleUser = await verifyGoogleToken(id_token);

    if (!googleUser) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_GOOGLE_TOKEN',
          message: 'Invalid Google token'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Find or create user
    let user = await db('users')
      .where({ google_id: googleUser.sub })
      .first();

    if (!user) {
      // Check if email already exists
      const existingUser = await db('users')
        .where({ email: googleUser.email })
        .first();

      if (existingUser) {
        // Link Google account to existing user
        await db('users')
          .where({ id: existingUser.id })
          .update({ google_id: googleUser.sub });
        user = existingUser;
      } else {
        // Create new user
        [user] = await db('users')
          .insert({
            username: googleUser.email.split('@')[0],
            email: googleUser.email,
            full_name: googleUser.name,
            google_id: googleUser.sub,
            profile_picture_url: googleUser.picture,
            email_verified: true,
            account_status: 'active',
            subscription_status: 'free'
          })
          .returning(['id', 'username', 'email', 'full_name', 'account_status', 'subscription_status']);
      }
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);

    // Store refresh token
    await cache.set(`refresh_token:${user.id}`, refreshToken, 7 * 24 * 60 * 60);

    // Update last login
    await db('users')
      .where({ id: user.id })
      .update({ last_login: new Date() });

    // Log activity
    await db('user_activity_log').insert({
      user_id: user.id,
      action_type: 'user_login_google',
      metadata: { ip_address: req.ip, user_agent: req.get('User-Agent') }
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          full_name: user.full_name,
          email_verified: user.email_verified,
          account_status: user.account_status,
          subscription_status: user.subscription_status
        },
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600
      },
      message: 'Google login successful',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Google login error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// POST /auth/refresh
router.post('/refresh', [
  body('refresh_token').notEmpty().withMessage('Refresh token is required')
], handleValidationErrors, async (req, res) => {
  try {
    const { refresh_token } = req.body;

    // Verify refresh token
    const decoded = await verifyToken(refresh_token, process.env.JWT_REFRESH_SECRET);
    
    // Check if refresh token exists in cache
    const storedToken = await cache.get(`refresh_token:${decoded.id}`);
    if (!storedToken || storedToken !== refresh_token) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Invalid or expired refresh token'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Get user
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

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);

    // Update refresh token
    await cache.set(`refresh_token:${user.id}`, newRefreshToken, 7 * 24 * 60 * 60);

    res.json({
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: newRefreshToken,
        expires_in: 3600
      },
      message: 'Token refreshed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Token refresh error:', error);
    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid or expired refresh token'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// POST /auth/logout
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Access token is required'
        },
        timestamp: new Date().toISOString()
      });
    }

    const token = authHeader.substring(7);
    
    // Blacklist token
    await cache.set(`blacklist:${token}`, 'true', 3600); // 1 hour

    // Remove refresh token if user is authenticated
    try {
      const decoded = await verifyToken(token);
      await cache.del(`refresh_token:${decoded.id}`);
    } catch (error) {
      // Token might be invalid, but that's okay for logout
    }

    res.json({
      success: true,
      message: 'Logout successful',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
], handleValidationErrors, async (req, res) => {
  try {
    const { email } = req.body;

    const user = await db('users')
      .where({ email, account_status: 'active' })
      .first();

    if (!user) {
      // Don't reveal if user exists or not
      return res.json({
        success: true,
        message: 'If an account with that email exists, a password reset link has been sent.',
        timestamp: new Date().toISOString()
      });
    }

    // Generate reset token
    const resetToken = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db('password_reset_tokens').insert({
      user_id: user.id,
      token: resetToken,
      expires_at: expiresAt
    });

    // Send reset email
    await sendEmail({
      to: email,
      subject: 'Reset your Tweak Music password',
      template: 'password-reset',
      data: {
        full_name: user.full_name,
        reset_link: `${process.env.API_BASE_URL}/auth/reset-password?token=${resetToken}`
      }
    });

    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// POST /auth/reset-password
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('new_password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, and number')
], handleValidationErrors, async (req, res) => {
  try {
    const { token, new_password } = req.body;

    // Find valid reset token
    const resetToken = await db('password_reset_tokens')
      .where({ token, used_at: null })
      .andWhere('expires_at', '>', new Date())
      .first();

    if (!resetToken) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_RESET_TOKEN',
          message: 'Invalid or expired reset token'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Get user
    const user = await db('users')
      .where({ id: resetToken.user_id, account_status: 'active' })
      .first();

    if (!user) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    // Update password
    await db('users')
      .where({ id: user.id })
      .update({ password_hash: passwordHash });

    // Mark token as used
    await db('password_reset_tokens')
      .where({ id: resetToken.id })
      .update({ used_at: new Date() });

    // Invalidate all refresh tokens for this user
    await cache.del(`refresh_token:${user.id}`);

    // Log activity
    await db('user_activity_log').insert({
      user_id: user.id,
      action_type: 'password_reset',
      metadata: { ip_address: req.ip, user_agent: req.get('User-Agent') }
    });

    res.json({
      success: true,
      message: 'Password reset successful',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// POST /auth/verify-email
router.post('/verify-email', [
  body('token').notEmpty().withMessage('Verification token is required')
], handleValidationErrors, async (req, res) => {
  try {
    const { token } = req.body;

    // Find verification token
    const verificationToken = await db('email_verification_tokens')
      .where({ token, verified_at: null })
      .andWhere('expires_at', '>', new Date())
      .first();

    if (!verificationToken) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_VERIFICATION_TOKEN',
          message: 'Invalid or expired verification token'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Update user email verification status
    await db('users')
      .where({ id: verificationToken.user_id })
      .update({ email_verified: true });

    // Mark token as verified
    await db('email_verification_tokens')
      .where({ id: verificationToken.id })
      .update({ verified_at: new Date() });

    res.json({
      success: true,
      message: 'Email verified successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Email verification error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Internal server error'
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Helper function to verify Google token (implementation needed)
async function verifyGoogleToken(idToken) {
  // This would involve calling Google's token verification endpoint
  // For now, return a mock user
  return {
    sub: 'google_user_id',
    email: 'user@gmail.com',
    name: 'Google User',
    picture: 'https://lh3.googleusercontent.com/photo.jpg'
  };
}

module.exports = router;
