const logger = require('../utils/logger');

// Custom error classes
class AppError extends Error {
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

class DatabaseError extends AppError {
  constructor(message = 'Database operation failed') {
    super(message, 500, 'DATABASE_ERROR');
  }
}

// Error handling middleware
const errorHandler = (error, req, res, next) => {
  let err = { ...error };
  err.message = error.message;

  // Log error
  logger.error('Error occurred:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.user?.id
  });

  // Mongoose validation error
  if (error.name === 'ValidationError') {
    const message = 'Validation Error';
    const details = Object.values(error.errors).map(val => ({
      field: val.path,
      message: val.message
    }));
    err = new ValidationError(message, details);
  }

  // Mongoose duplicate key error
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    const message = `${field} already exists`;
    err = new ConflictError(message);
  }

  // Mongoose cast error
  if (error.name === 'CastError') {
    const message = 'Resource not found';
    err = new NotFoundError();
  }

  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    err = new UnauthorizedError(message);
  }

  if (error.name === 'TokenExpiredError') {
    const message = 'Token expired';
    err = new UnauthorizedError(message);
  }

  // Multer errors
  if (error.code === 'LIMIT_FILE_SIZE') {
    const message = 'File size too large';
    err = new ValidationError(message);
  }

  if (error.code === 'LIMIT_FILE_COUNT') {
    const message = 'Too many files';
    err = new ValidationError(message);
  }

  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    const message = 'Unexpected file field';
    err = new ValidationError(message);
  }

  // Database connection errors
  if (error.code === 'ECONNREFUSED') {
    const message = 'Database connection failed';
    err = new DatabaseError(message);
  }

  // Default to 500 if no status code
  if (!err.statusCode) {
    err.statusCode = 500;
    err.code = 'SERVER_ERROR';
  }

  // Don't expose stack trace in production
  const response = {
    success: false,
    error: {
      code: err.code || 'SERVER_ERROR',
      message: err.message || 'Internal server error'
    },
    timestamp: new Date().toISOString()
  };

  // Add validation details if available
  if (err.details) {
    response.error.details = err.details;
  }

  // Add stack trace in development
  if (process.env.NODE_ENV === 'development') {
    response.error.stack = error.stack;
  }

  res.status(err.statusCode).json(response);
};

// Async error wrapper
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// 404 handler
const notFoundHandler = (req, res, next) => {
  const error = new NotFoundError('API endpoint');
  next(error);
};

module.exports = {
  errorHandler,
  asyncHandler,
  notFoundHandler,
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  DatabaseError
};
