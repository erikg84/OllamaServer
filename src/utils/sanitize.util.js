// src/utils/sanitize.util.js
const logger = require('../logging/logger');
const loggingConfig = require('../config/logging.config');

/**
 * Utility for sanitizing sensitive data
 * Provides methods to sanitize request/response data for logging
 */

/**
 * Sanitize request body to prevent logging sensitive information
 * @param {Object} body - Request body
 * @param {Object} options - Sanitization options
 * @returns {Object} Sanitized body
 */
function sanitizeRequestBody(body, options = {}) {
    if (!body) return {};

    // Get sanitization options from config or use provided options
    const config = {
        sensitiveFields: options.sensitiveFields || loggingConfig.sanitize.sensitiveFields,
        maxFieldLength: options.maxFieldLength || loggingConfig.sanitize.maxFieldLength,
        redactionText: options.redactionText || loggingConfig.sanitize.redactionText,
        truncationSuffix: options.truncationSuffix || loggingConfig.sanitize.truncationSuffix,
    };

    // Make a shallow copy of the body
    const sanitized = { ...body };

    try {
        // Process sensitive fields
        sanitizeFields(sanitized, config.sensitiveFields, config.redactionText);

        // Handle special fields that need truncation
        truncateSpecialFields(sanitized, config);

        return sanitized;
    } catch (error) {
        logger.warn({
            message: 'Error sanitizing request body',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        // If sanitization fails, return a safe minimum
        return { sanitized: 'error', sanitizationError: error.message };
    }
}

/**
 * Sanitize response body to prevent logging sensitive information
 * @param {Object|string} body - Response body
 * @param {Object} options - Sanitization options
 * @returns {Object|string} Sanitized body
 */
function sanitizeResponseBody(body, options = {}) {
    if (!body) return body;

    // Get sanitization options from config or use provided options
    const config = {
        sensitiveFields: options.sensitiveFields || loggingConfig.sanitize.sensitiveFields,
        maxFieldLength: options.maxFieldLength || loggingConfig.sanitize.maxFieldLength,
        redactionText: options.redactionText || loggingConfig.sanitize.redactionText,
        truncationSuffix: options.truncationSuffix || loggingConfig.sanitize.truncationSuffix,
        maxResponseSize: options.maxResponseSize || 1000, // Default to 1000 characters
    };

    try {
        // Handle string bodies
        if (typeof body === 'string') {
            // Truncate long strings
            if (body.length > config.maxResponseSize) {
                return body.substring(0, config.maxResponseSize) + config.truncationSuffix;
            }
            return body;
        }

        // Try to parse JSON strings
        if (typeof body === 'string' && body.startsWith('{')) {
            try {
                body = JSON.parse(body);
            } catch (e) {
                // Not valid JSON, continue with string handling
            }
        }

        // Handle object bodies
        if (typeof body === 'object' && body !== null) {
            // Make a shallow copy
            const sanitized = { ...body };

            // Process sensitive fields
            sanitizeFields(sanitized, config.sensitiveFields, config.redactionText);

            // Handle special fields that need truncation
            truncateSpecialFields(sanitized, config);

            return sanitized;
        }

        // Default case - return as is
        return body;
    } catch (error) {
        logger.warn({
            message: 'Error sanitizing response body',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        // If sanitization fails, return a safe minimum
        if (typeof body === 'string') {
            return '[Error sanitizing response]';
        }
        return { sanitized: 'error', sanitizationError: error.message };
    }
}

/**
 * Sanitize HTTP headers to hide sensitive information
 * @param {Object} headers - HTTP headers
 * @returns {Object} Sanitized headers
 */
function sanitizeHeaders(headers) {
    if (!headers) return {};

    const sanitized = { ...headers };
    const sensitiveHeaders = [
        'authorization',
        'x-api-key',
        'api-key',
        'x-auth-token',
        'cookie',
        'set-cookie',
        'proxy-authorization'
    ];

    sensitiveHeaders.forEach(header => {
        const headerKey = Object.keys(sanitized).find(
            key => key.toLowerCase() === header.toLowerCase()
        );

        if (headerKey && sanitized[headerKey]) {
            sanitized[headerKey] = '[REDACTED]';
        }
    });

    return sanitized;
}

/**
 * Sanitize sensitive fields in an object
 * @param {Object} obj - Object to sanitize
 * @param {Array} sensitiveFields - List of sensitive field names
 * @param {string} redactionText - Text to replace sensitive values with
 */
function sanitizeFields(obj, sensitiveFields, redactionText) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return;
    }

    for (const key in obj) {
        // Check if this is a sensitive field
        if (sensitiveFields.some(field => key.toLowerCase() === field.toLowerCase())) {
            obj[key] = redactionText;
            continue;
        }

        // Recursively sanitize objects
        if (obj[key] && typeof obj[key] === 'object') {
            if (Array.isArray(obj[key])) {
                // Handle arrays of objects
                obj[key].forEach(item => {
                    if (item && typeof item === 'object') {
                        sanitizeFields(item, sensitiveFields, redactionText);
                    }
                });
            } else {
                // Handle nested objects
                sanitizeFields(obj[key], sensitiveFields, redactionText);
            }
        }
    }
}

/**
 * Truncate special fields that may contain large content
 * @param {Object} obj - Object to process
 * @param {Object} config - Sanitization configuration
 */
function truncateSpecialFields(obj, config) {
    // Special handling for known fields that often contain large content
    if (obj.prompt && typeof obj.prompt === 'string' && obj.prompt.length > config.maxFieldLength) {
        obj.prompt = obj.prompt.substring(0, config.maxFieldLength) + config.truncationSuffix;
    }

    // Handle message arrays for chat endpoints
    if (obj.messages && Array.isArray(obj.messages)) {
        obj.messages = obj.messages.map(msg => {
            if (msg && typeof msg === 'object') {
                const messageCopy = { ...msg };

                if (messageCopy.content && typeof messageCopy.content === 'string' &&
                    messageCopy.content.length > config.maxFieldLength) {
                    messageCopy.content = messageCopy.content.substring(0, config.maxFieldLength) +
                        config.truncationSuffix;
                }

                return messageCopy;
            }
            return msg;
        });
    }

    // Handle responses for generation endpoints
    if (obj.response && typeof obj.response === 'string' && obj.response.length > config.maxFieldLength) {
        obj.response = obj.response.substring(0, config.maxFieldLength) + config.truncationSuffix;
    }

    // Handle generated text
    if (obj.text && typeof obj.text === 'string' && obj.text.length > config.maxFieldLength) {
        obj.text = obj.text.substring(0, config.maxFieldLength) + config.truncationSuffix;
    }

    // Handle system prompts
    if (obj.system && typeof obj.system === 'string' && obj.system.length > config.maxFieldLength) {
        obj.system = obj.system.substring(0, config.maxFieldLength) + config.truncationSuffix;
    }
}

/**
 * Sanitize error object for logging
 * @param {Error} error - Error object
 * @returns {Object} Sanitized error object
 */
function sanitizeError(error) {
    if (!error) return { message: 'Unknown error' };

    return {
        message: error.message || 'Unknown error',
        name: error.name,
        code: error.code,
        statusCode: error.statusCode || error.status,
        stack: error.stack
    };
}

module.exports = {
    sanitizeRequestBody,
    sanitizeResponseBody,
    sanitizeHeaders,
    sanitizeError
};