const express = require('express');
const { query, param, validationResult } = require('express-validator');
const db = require('../config/database');
const { cache } = require('../config/redis');
const { authenticate, optionalAuth, userRateLimit } = require('../middleware/auth');
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

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

// GET /songs
router.get('/', optionalAuth, userRateLimit, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
  query('genre').optional().isString().withMessage('Genre must be a string'),
  query('sort').optional().isIn(['popularity', 'release_date', 'title', 'play_count']).withMessage('Invalid sort option'),
  query('order').optional().isIn(['asc', 'desc']).withMessage('Order must be asc or desc')
], handleValidationErrors, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const { genre, sort = 'popularity', order = 'desc' } = req.query;
    const userId = req.user?.id;

    // Build cache key
    const cacheKey = `songs:${JSON.stringify({ page, limit, genre, sort, order, userId })}`;
    
    // Check cache first
    let result = await cache.get(cacheKey);
    
    if (!result) {
      // Build query
      let query = db('songs as s')
        .join('artists as a', 's.artist_id', 'a.id')
        .leftJoin('albums as al', 's.album_id', 'al.id')
        .select(
          's.id',
          's.title',
          's.duration_seconds',
          's.preview_url',
          's.explicit',
          's.popularity_score',
          's.play_count',
          's.cover_image_url',
          'a.id as artist_id',
          'a.name as artist_name',
          'al.id as album_id',
          'al.title as album_title',
          'al.cover_image_url as album_cover'
        );

      // Apply filters
      if (genre) {
        query = query.where('s.genre', genre);
      }

      // Apply sorting
      const sortColumn = sort === 'popularity' ? 's.popularity_score' :
                        sort === 'release_date' ? 'al.release_date' :
                        sort === 'title' ? 's.title' : 's.play_count';
      
      query = query.orderBy(sortColumn, order);

      // Get total count
      const countQuery = db('songs as s')
        .join('artists as a', 's.artist_id', 'a.id');
      
      if (genre) {
        countQuery = countQuery.where('s.genre', genre);
      }
      
      const totalResult = await countQuery.count('* as total').first();
      const total = parseInt(totalResult.total);

      // Get paginated results
      const songs = await query.limit(limit).offset(offset);

      // Format response
      const formattedSongs = songs.map(song => ({
        id: song.id,
        title: song.title,
        artists: [{
          id: song.artist_id,
          name: song.artist_name
        }],
        album: song.album_id ? {
          id: song.album_id,
          title: song.album_title,
          cover_image_url: song.album_cover
        } : null,
        duration_seconds: song.duration_seconds,
        preview_url: song.preview_url,
        explicit: song.explicit,
        popularity_score: song.popularity_score,
        cover_image_url: song.cover_image_url
      }));

      result = {
        songs: formattedSongs,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      };

      // Cache for 5 minutes
      await cache.set(cacheKey, result, 300);
    }

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get songs error:', error);
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

// GET /songs/:id
router.get('/:id', optionalAuth, [
  param('id').isUUID().withMessage('Invalid song ID')
], handleValidationErrors, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.user?.id;

    // Check cache first
    const cacheKey = `song:${songId}:${userId || 'anonymous'}`;
    let song = await cache.get(cacheKey);

    if (!song) {
      // Get song details
      const songData = await db('songs as s')
        .join('artists as a', 's.artist_id', 'a.id')
        .leftJoin('albums as al', 's.album_id', 'al.id')
        .leftJoin('song_artists as sa', 's.id', 'sa.song_id')
        .leftJoin('artists as sa_artists', 'sa.artist_id', 'sa_artists.id')
        .where('s.id', songId)
        .select(
          's.id',
          's.title',
          's.duration_seconds',
          's.file_url',
          's.cover_image_url',
          's.genre',
          's.explicit',
          's.popularity_score',
          's.play_count',
          's.preview_url',
          'a.id as primary_artist_id',
          'a.name as primary_artist_name',
          'al.id as album_id',
          'al.title as album_title',
          'al.cover_image_url as album_cover',
          'al.release_date'
        )
        .first();

      if (!songData) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'SONG_NOT_FOUND',
            message: 'Song not found'
          },
          timestamp: new Date().toISOString()
        });
      }

      // Get all artists (primary + featured)
      const artists = await db('song_artists as sa')
        .join('artists as a', 'sa.artist_id', 'a.id')
        .where('sa.song_id', songId)
        .select('a.id', 'a.name', 'sa.role');

      // Check if user likes this song
      let isLiked = false;
      if (userId) {
        const likeCheck = await db('user_library')
          .where({ user_id: userId, song_id: songId })
          .first();
        isLiked = !!likeCheck;
      }

      // Check if lyrics are available
      const lyricsCheck = await db('lyrics')
        .where({ song_id: songId })
        .first();

      song = {
        id: songData.id,
        title: songData.title,
        artists: artists.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role
        })),
        album: songData.album_id ? {
          id: songData.album_id,
          title: songData.album_title,
          cover_image_url: songData.album_cover,
          release_date: songData.release_date
        } : null,
        duration_seconds: songData.duration_seconds,
        file_url: songData.file_url,
        cover_image_url: songData.cover_image_url,
        genre: songData.genre,
        explicit: songData.explicit,
        popularity_score: songData.popularity_score,
        play_count: songData.play_count,
        preview_url: songData.preview_url,
        lyrics_available: !!lyricsCheck,
        is_liked: isLiked
      };

      // Cache for 10 minutes
      await cache.set(cacheKey, song, 600);
    }

    res.json({
      success: true,
      data: song,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get song details error:', error);
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

// GET /songs/:id/stream
router.get('/:id/stream', authenticate, [
  param('id').isUUID().withMessage('Invalid song ID'),
  query('quality').optional().isIn(['low', 'standard', 'high', 'lossless']).withMessage('Invalid quality'),
  query('format').optional().isIn(['mp3', 'flac', 'aac']).withMessage('Invalid format')
], handleValidationErrors, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.user.id;
    const { quality = 'standard', format = 'mp3' } = req.query;

    // Check if user has access to this quality
    if (quality === 'lossless' && req.user.subscription_status !== 'premium') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'PREMIUM_REQUIRED',
          message: 'Premium subscription required for lossless quality'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Get song details
    const song = await db('songs')
      .where({ id: songId })
      .first();

    if (!song) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SONG_NOT_FOUND',
          message: 'Song not found'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Generate streaming token
    const streamToken = crypto.randomBytes(32).toString('hex');
    const streamUrl = `${process.env.CDN_BASE_URL}/stream/${songId}/${quality}/${format}?token=${streamToken}`;
    
    // Cache stream token with expiry
    await cache.set(`stream_token:${streamToken}`, {
      user_id: userId,
      song_id: songId,
      quality,
      format,
      expires_at: new Date(Date.now() + 3600000) // 1 hour
    }, 3600);

    // Log streaming request
    await db('user_activity_log').insert({
      user_id: userId,
      action_type: 'song_stream_request',
      song_id: songId,
      metadata: { quality, format, ip_address: req.ip }
    });

    res.json({
      success: true,
      data: {
        stream_url: streamUrl,
        expires_in: 3600,
        quality: quality,
        format: format,
        duration_seconds: song.duration_seconds
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get stream URL error:', error);
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

// POST /songs/:id/play
router.post('/:id/play', authenticate, [
  param('id').isUUID().withMessage('Invalid song ID'),
], handleValidationErrors, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.user.id;
    const { duration_played_seconds = 0, completed = false, device_type = 'web', source = 'unknown' } = req.body;

    // Validate song exists
    const song = await db('songs')
      .where({ id: songId })
      .first();

    if (!song) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SONG_NOT_FOUND',
          message: 'Song not found'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Record listening history
    await db('listening_history').insert({
      user_id: userId,
      song_id: songId,
      played_at: new Date(),
      duration_played_seconds,
      completed,
      device_type,
      ip_address: req.ip
    });

    // Update song play count
    await db('songs')
      .where({ id: songId })
      .increment('play_count', 1);

    // Log activity
    await db('user_activity_log').insert({
      user_id: userId,
      action_type: 'song_play',
      song_id: songId,
      metadata: { 
        duration_played_seconds, 
        completed, 
        device_type, 
        source,
        ip_address: req.ip 
      }
    });

    // Clear relevant caches
    await cache.del(`song:${songId}:${userId}`);
    await cache.del(`user_stats:${userId}`);

    res.json({
      success: true,
      message: 'Play event recorded',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Record play error:', error);
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

// POST /songs/:id/like
router.post('/:id/like', authenticate, [
  param('id').isUUID().withMessage('Invalid song ID')
], handleValidationErrors, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.user.id;

    // Check if song exists
    const song = await db('songs')
      .where({ id: songId })
      .first();

    if (!song) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SONG_NOT_FOUND',
          message: 'Song not found'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Check if already liked
    const existingLike = await db('user_library')
      .where({ user_id: userId, song_id: songId })
      .first();

    if (existingLike) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_LIKED',
          message: 'Song already liked'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Add to library
    await db('user_library').insert({
      user_id: userId,
      song_id: songId
    });

    // Update song like count
    await db('songs')
      .where({ id: songId })
      .increment('like_count', 1);

    // Log activity
    await db('user_activity_log').insert({
      user_id: userId,
      action_type: 'song_like',
      song_id: songId,
      metadata: { ip_address: req.ip }
    });

    // Clear caches
    await cache.del(`song:${songId}:${userId}`);
    await cache.del(`user_stats:${userId}`);

    res.json({
      success: true,
      message: 'Song liked successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Like song error:', error);
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

// DELETE /songs/:id/like
router.delete('/:id/like', authenticate, [
  param('id').isUUID().withMessage('Invalid song ID')
], handleValidationErrors, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.user.id;

    // Remove from library
    const deleted = await db('user_library')
      .where({ user_id: userId, song_id: songId })
      .del();

    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_LIKED',
          message: 'Song not found in library'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Update song like count
    await db('songs')
      .where({ id: songId })
      .decrement('like_count', 1);

    // Log activity
    await db('user_activity_log').insert({
      user_id: userId,
      action_type: 'song_unlike',
      song_id: songId,
      metadata: { ip_address: req.ip }
    });

    // Clear caches
    await cache.del(`song:${songId}:${userId}`);
    await cache.del(`user_stats:${userId}`);

    res.json({
      success: true,
      message: 'Song unliked successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Unlike song error:', error);
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

// GET /songs/:id/lyrics
router.get('/:id/lyrics', authenticate, [
  param('id').isUUID().withMessage('Invalid song ID')
], handleValidationErrors, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.user.id;

    // Check cache first
    const cacheKey = `lyrics:${songId}`;
    let lyrics = await cache.get(cacheKey);

    if (!lyrics) {
      // Get lyrics from database
      const lyricsData = await db('lyrics')
        .where({ song_id: songId })
        .first();

      if (!lyricsData) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'LYRICS_NOT_FOUND',
            message: 'Lyrics not found for this song'
          },
          timestamp: new Date().toISOString()
        });
      }

      lyrics = {
        lyrics_text: lyricsData.lyrics_text,
        synced_lyrics: lyricsData.synced_lyrics,
        language: lyricsData.language
      };

      // Cache for 1 hour
      await cache.set(cacheKey, lyrics, 3600);
    }

    // Log lyrics view
    await db('user_activity_log').insert({
      user_id: userId,
      action_type: 'lyrics_view',
      song_id: songId,
      metadata: { ip_address: req.ip }
    });

    res.json({
      success: true,
      data: lyrics,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get lyrics error:', error);
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

// GET /songs/trending
router.get('/trending', optionalAuth, [
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
  query('genre').optional().isString().withMessage('Genre must be a string'),
  query('time_range').optional().isIn(['day', 'week', 'month']).withMessage('Invalid time range')
], handleValidationErrors, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const { genre, time_range = 'week' } = req.query;
    const userId = req.user?.id;

    // Calculate date range
    const now = new Date();
    const startDate = time_range === 'day' ? new Date(now.getTime() - 24 * 60 * 60 * 1000) :
                     time_range === 'week' ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) :
                     new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Build cache key
    const cacheKey = `trending_songs:${JSON.stringify({ limit, genre, time_range, userId })}`;
    
    // Check cache first
    let result = await cache.get(cacheKey);
    
    if (!result) {
      // Get trending songs based on recent plays
      let query = db('songs as s')
        .join('artists as a', 's.artist_id', 'a.id')
        .leftJoin('albums as al', 's.album_id', 'al.id')
        .join('listening_history as lh', 's.id', 'lh.song_id')
        .where('lh.played_at', '>=', startDate)
        .select(
          's.id',
          's.title',
          's.duration_seconds',
          's.cover_image_url',
          's.popularity_score',
          'a.id as artist_id',
          'a.name as artist_name',
          'al.id as album_id',
          'al.title as album_title',
          db.raw('COUNT(lh.id) as recent_plays')
        )
        .groupBy('s.id', 'a.id', 'al.id')
        .orderBy('recent_plays', 'desc')
        .limit(limit);

      if (genre) {
        query = query.where('s.genre', genre);
      }

      const trendingSongs = await query;

      // Format response
      result = trendingSongs.map(song => ({
        id: song.id,
        title: song.title,
        artists: [{
          id: song.artist_id,
          name: song.artist_name
        }],
        album: song.album_id ? {
          id: song.album_id,
          title: song.album_title
        } : null,
        duration_seconds: song.duration_seconds,
        cover_image_url: song.cover_image_url,
        recent_plays: parseInt(song.recent_plays)
      }));

      // Cache for 15 minutes
      await cache.set(cacheKey, result, 900);
    }

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get trending songs error:', error);
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
