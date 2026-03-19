const express = require('express');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const db = require('../config/database');
const { cache } = require('../config/redis');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

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

// GET /users/profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check cache first
    const cacheKey = `user_profile:${userId}`;
    let userProfile = await cache.get(cacheKey);

    if (!userProfile) {
      // Get user profile from database
      const user = await db('users')
        .where({ id: userId, account_status: 'active' })
        .first();

      if (!user) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found'
          },
          timestamp: new Date().toISOString()
        });
      }

      // Get listening statistics
      const listeningStats = await db('listening_history')
        .where({ user_id: userId })
        .select(
          db.raw('COUNT(*) as songs_played'),
          db.raw('SUM(duration_played_seconds) as total_playtime_minutes'),
          db.raw('MAX(played_at) as last_played')
        )
        .first();

      // Get favorite genres
      const favoriteGenres = await db('songs as s')
        .join('listening_history as lh', 's.id', 'lh.song_id')
        .where('lh.user_id', userId)
        .select('s.genre')
        .count('* as count')
        .groupBy('s.genre')
        .orderBy('count', 'desc')
        .limit(5);

      // Get library stats
      const libraryStats = await db('user_library')
        .where({ user_id: userId })
        .count('* as liked_songs')
        .first();

      userProfile = {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        profile_picture_url: user.profile_picture_url,
        subscription_status: user.subscription_status,
        email_verified: user.email_verified,
        created_at: user.created_at,
        last_login: user.last_login,
        preferences: user.preferences || {},
        listening_stats: {
          total_playtime_minutes: parseInt(listeningStats.total_playtime_minutes) / 60 || 0,
          songs_played: parseInt(listeningStats.songs_played) || 0,
          last_played: listeningStats.last_played,
          favorite_genres: favoriteGenres.map(g => g.genre).filter(Boolean)
        },
        library_stats: {
          liked_songs: parseInt(libraryStats.liked_songs) || 0
        }
      };

      // Cache for 5 minutes
      await cache.set(cacheKey, userProfile, 300);
    }

    res.json({
      success: true,
      data: userProfile,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get profile error:', error);
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

// PUT /users/profile
router.put('/profile', authenticate, [
  body('full_name')
    .optional()
    .isLength({ min: 1, max: 100 })
    .withMessage('Full name must be 1-100 characters'),
  body('username')
    .optional()
    .isLength({ min: 3, max: 50 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username must be 3-50 characters and contain only letters, numbers, and underscores'),
  body('date_of_birth')
    .optional()
    .isISO8601()
    .withMessage('Valid date of birth required'),
  body('country')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('Valid country code required'),
  body('preferences')
    .optional()
    .isObject()
    .withMessage('Preferences must be an object')
], handleValidationErrors, async (req, res) => {
  try {
    const userId = req.user.id;
    const { full_name, username, date_of_birth, country, preferences } = req.body;

    // Check if username is already taken (if being updated)
    if (username) {
      const existingUser = await db('users')
        .where({ username })
        .whereNot({ id: userId })
        .first();

      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'USERNAME_ALREADY_EXISTS',
            message: 'Username already taken'
          },
          timestamp: new Date().toISOString()
        });
      }
    }

    // Update user profile
    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (username !== undefined) updateData.username = username;
    if (date_of_birth !== undefined) updateData.date_of_birth = date_of_birth;
    if (country !== undefined) updateData.country = country;
    if (preferences !== undefined) updateData.preferences = JSON.stringify(preferences);

    await db('users')
      .where({ id: userId })
      .update(updateData);

    // Clear cache
    await cache.del(`user_profile:${userId}`);

    // Log activity
    await db('user_activity_log').insert({
      user_id: userId,
      action_type: 'profile_update',
      metadata: { updated_fields: Object.keys(updateData) }
    });

    // Get updated profile
    const updatedProfile = await db('users')
      .where({ id: userId })
      .first();

    res.json({
      success: true,
      data: {
        id: updatedProfile.id,
        username: updatedProfile.username,
        email: updatedProfile.email,
        full_name: updatedProfile.full_name,
        profile_picture_url: updatedProfile.profile_picture_url,
        subscription_status: updatedProfile.subscription_status,
        email_verified: updatedProfile.email_verified,
        created_at: updatedProfile.created_at,
        last_login: updatedProfile.last_login,
        preferences: updatedProfile.preferences || {}
      },
      message: 'Profile updated successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Update profile error:', error);
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

// POST /users/profile/upload-picture
router.post('/profile/upload-picture', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NO_FILE',
          message: 'No file uploaded'
        },
        timestamp: new Date().toISOString()
      });
    }

    const userId = req.user.id;
    const uploadsDir = path.join(__dirname, '../../uploads/profiles');

    // Ensure uploads directory exists
    await fs.mkdir(uploadsDir, { recursive: true });

    // Generate unique filename
    const filename = `${userId}_${Date.now()}.jpg`;
    const filePath = path.join(uploadsDir, filename);

    // Process image with Sharp
    await sharp(req.file.buffer)
      .resize(300, 300, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 80 })
      .toFile(filePath);

    // Update user profile picture URL
    const profilePictureUrl = `/uploads/profiles/${filename}`;
    await db('users')
      .where({ id: userId })
      .update({ profile_picture_url: profilePictureUrl });

    // Clear cache
    await cache.del(`user_profile:${userId}`);

    // Log activity
    await db('user_activity_log').insert({
      user_id: userId,
      action_type: 'profile_picture_upload',
      metadata: { file_path: profilePictureUrl }
    });

    res.json({
      success: true,
      data: {
        profile_picture_url: profilePictureUrl
      },
      message: 'Profile picture uploaded successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Upload profile picture error:', error);
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: 'File size exceeds 5MB limit'
        },
        timestamp: new Date().toISOString()
      });
    }

    if (error.message.includes('Invalid file type')) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FILE_TYPE',
          message: error.message
        },
        timestamp: new Date().toISOString()
      });
    }

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

// DELETE /users/account
router.delete('/account', authenticate, [
  body('password').notEmpty().withMessage('Password is required'),
  body('confirmation').equals('DELETE_MY_ACCOUNT').withMessage('Confirmation text must be exactly "DELETE_MY_ACCOUNT"')
], handleValidationErrors, async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    // Get user with password
    const user = await db('users')
      .where({ id: userId })
      .first();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Verify password
    const bcrypt = require('bcryptjs');
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_PASSWORD',
          message: 'Invalid password'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Start transaction
    await db.transaction(async (trx) => {
      // Soft delete user account
      await trx('users')
        .where({ id: userId })
        .update({
          account_status: 'deleted',
          deleted_at: new Date(),
          email: `deleted_${userId}@deleted.com`,
          username: `deleted_user_${userId}`,
          full_name: 'Deleted User'
        });

      // Anonymize user data
      await trx('user_library')
        .where({ user_id: userId })
        .del();

      await trx('user_downloads')
        .where({ user_id: userId })
        .del();

      await trx('playlists')
        .where({ user_id: userId })
        .del();

      // Revoke all tokens
      await cache.del(`refresh_token:${userId}`);

      // Log activity
      await trx('user_activity_log').insert({
        user_id: userId,
        action_type: 'account_delete',
        metadata: { ip_address: req.ip, user_agent: req.get('User-Agent') }
      });
    });

    res.json({
      success: true,
      message: 'Account deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete account error:', error);
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

// GET /users/activity
router.get('/activity', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type } = req.query;

    let query = db('user_activity_log')
      .where({ user_id: userId })
      .orderBy('timestamp', 'desc');

    if (type) {
      query = query.where('action_type', type);
    }

    const activities = await query
      .limit(limit)
      .offset((page - 1) * limit)
      .select('*');

    const total = await db('user_activity_log')
      .where({ user_id: userId })
      .count('* as count')
      .first();

    res.json({
      success: true,
      data: {
        activities,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(total.count),
          total_pages: Math.ceil(total.count / limit)
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get user activity error:', error);
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

// GET /users/stats
router.get('/stats', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const cacheKey = `user_stats:${userId}`;
    
    // Check cache first
    let stats = await cache.get(cacheKey);
    
    if (!stats) {
      // Get comprehensive user statistics
      const [
        listeningStats,
        libraryStats,
        playlistStats,
        favoriteArtists,
        recentActivity
      ] = await Promise.all([
        // Listening statistics
        db('listening_history')
          .where({ user_id: userId })
          .select(
            db.raw('COUNT(*) as total_plays'),
            db.raw('SUM(duration_played_seconds) as total_seconds'),
            db.raw('MAX(played_at) as last_played'),
            db.raw('COUNT(DISTINCT song_id) as unique_songs')
          )
          .first(),
        
        // Library statistics
        db('user_library')
          .where({ user_id: userId })
          .count('* as liked_songs')
          .first(),
        
        // Playlist statistics
        db('playlists')
          .where({ user_id: userId })
          .count('* as playlists')
          .first(),
        
        // Favorite artists
        db('songs as s')
          .join('listening_history as lh', 's.id', 'lh.song_id')
          .where('lh.user_id', userId)
          .select('s.artist_id', db.raw('COUNT(*) as play_count'))
          .groupBy('s.artist_id')
          .orderBy('play_count', 'desc')
          .limit(10),
        
        // Recent activity
        db('user_activity_log')
          .where({ user_id: userId })
          .orderBy('timestamp', 'desc')
          .limit(5)
          .select('*')
      ]);

      stats = {
        listening: {
          total_plays: parseInt(listeningStats.total_plays) || 0,
          total_minutes: Math.floor((parseInt(listeningStats.total_seconds) || 0) / 60),
          unique_songs: parseInt(listeningStats.unique_songs) || 0,
          last_played: listeningStats.last_played
        },
        library: {
          liked_songs: parseInt(libraryStats.liked_songs) || 0,
          playlists: parseInt(playlistStats.playlists) || 0
        },
        favorite_artists: favoriteArtists,
        recent_activity: recentActivity
      };

      // Cache for 10 minutes
      await cache.set(cacheKey, stats, 600);
    }

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get user stats error:', error);
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

module.exports = router;
