// src/middleware/error.middleware.js
const logger = require('../logging/logger');

/**
 * Error middleware factory
 * Creates middleware for centralized error handling
 * @returns {Function} Error middleware
 */
function errorMiddleware() {
    /**
     * Error handling middleware
     * @param {Error} err - Error object
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     */
    return (err, req, res, next) => {
        const requestId = req.id || 'unknown';
        const startTime = req.startTime || Date.now();
        const duration = Date.now() - startTime;

        // Determine error status code
        const statusCode = determineStatusCode(err);

        // Determine error type
        const errorType = determineErrorType(err);

        // Create error response
        const errorResponse = {
            status: 'error',
            message: err.message || 'An unexpected error occurred',
            code: err.code || errorType,
            requestId
        };

        // Add validation errors if available
        if (err.validationErrors) {
            errorResponse.validationErrors = err.validationErrors;
        }

        // Log detailed error information
        logger.error({
            message: 'Request error',
            requestId,
            method: req.method,
            url: req.originalUrl,
            error: err.message,
            errorName: err.name,
            errorType,
            errorCode: err.code,
            statusCode,
            stack: err.stack,
            duration: `${duration}ms`,
            timestamp: new Date().toISOString()
        });

        // Send error response to client
        res.status(statusCode).json(errorResponse);
    };
}

/**
 * Determine appropriate HTTP status code for an error
 * @param {Error} err - Error object
 * @returns {number} HTTP status code
 */
function determineStatusCode(err) {
    // Check for existing status code
    if (err.statusCode) {
        return err.statusCode;
    }

    // Check for HTTP error status codes
    if (err.status && err.status >= 400 && err.status < 600) {
        return err.status;
    }

    // Determine status code based on error type
    switch (err.name) {
        case 'ValidationError':
            return 400; // Bad Request
        case 'UnauthorizedError':
            return 401; // Unauthorized
        case 'ForbiddenError':
            return 403; // Forbidden
        case 'NotFoundError':
            return 404; // Not Found
        case 'ConflictError':
            return 409; // Conflict
        case 'TimeoutError':
            return 408; // Request Timeout
        case 'RateLimitError':
            return 429; // Too Many Requests
        case 'PayloadTooLargeError':
            return 413; // Payload Too Large
        default:
            // Axios error mappings
            if (err.response) {
                return err.response.status;
            }

            // Default to 500 Internal Server Error
            return 500;
    }
}

/**
 * Determine error type based on error properties
 * @param {Error} err - Error object
 * @returns {string} Error type
 */
function determineErrorType(err) {
    // Check for specific error types
    if (err.name) {
        // Return camelCase version of the error name without 'Error' suffix
        const name = err.name.replace(/Error$/, '');
        return name.charAt(0).toLowerCase() + name.slice(1);
    }

    // Axios error types
    if (err.isAxiosError) {
        if (err.code === 'ECONNABORTED') {
            return 'timeout';
        }
        if (err.code === 'ECONNREFUSED') {
            return 'connectionRefused';
        }
        if (err.response) {
            return 'externalApi';
        }
        return 'network';
    }

    // Default error type
    return 'internal';
}

/**
 * Create a custom error with status code
 * @param {string} message - Error message
 * @param {number} statusCode - HTTP status code
 * @returns {Error} Custom error
 */
function createError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

/**
 * Create a not found error
 * @param {string} resource - Resource that was not found
 * @returns {Error} Not found error
 */
function notFoundError(resource) {
    const error = new Error(`${resource || 'Resource'} not found`);
    error.statusCode = 404;
    error.name = 'NotFoundError';
    return error;
}

/**
 * Create a validation error
 * @param {string} message - Error message
 * @param {Array} validationErrors - Validation errors
 * @returns {Error} Validation error
 */
function validationError(message, validationErrors) {
    const error = new Error(message || 'Validation failed');
    error.statusCode = 400;
    error.name = 'ValidationError';
    error.validationErrors = validationErrors;
    return error;
}

/**
 * Create an unauthorized error
 * @param {string} message - Error message
 * @returns {Error} Unauthorized error
 */
function unauthorizedError(message) {
    const error = new Error(message || 'Unauthorized');
    error.statusCode = 401;
    error.name = 'UnauthorizedError';
    return error;
}

/**
 * Create a forbidden error
 * @param {string} message - Error message
 * @returns {Error} Forbidden error
 */
function forbiddenError(message) {
    const error = new Error(message || 'Forbidden');
    error.statusCode = 403;
    error.name = 'ForbiddenError';
    return error;
}

module.exports = {
    errorMiddleware,
    createError,
    notFoundError,
    validationError,
    unauthorizedError,
    forbiddenError
};