// src/middleware/logging.middleware.js
const logger = require('../logging/logger');
const loggingConfig = require('../config/logging.config');

/**
 * Logging middleware factory
 * Creates middleware for request/response logging
 * @returns {Function} Logging middleware
 */
function loggingMiddleware() {
    /**
     * Request/response logging middleware
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     */
    return (req, res, next) => {
        // Store request start time
        req.startTime = Date.now();

        // Enhanced request logging with sanitized body
        const sanitizedBody = req.body ? sanitizeRequestBody(req.body) : undefined;

        // Log the incoming request
        logger.info({
            message: 'Request received',
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            path: req.path,
            query: req.query,
            ip: req.ip,
            forwardedIp: req.get('x-forwarded-for'),
            userAgent: req.get('user-agent'),
            contentType: req.get('content-type'),
            contentLength: req.get('content-length'),
            requestBody: sanitizedBody,
            timestamp: new Date().toISOString()
        });

        // Capture the original end method
        const originalEnd = res.end;

        // Override the write method to capture the response body for small responses
        // This is disabled by default to avoid performance issues with large responses
        if (process.env.LOG_RESPONSE_BODY === 'true') {
            const originalWrite = res.write;
            const chunks = [];

            res.write = function(chunk) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                return originalWrite.apply(res, arguments);
            };

            // Override the end method to capture final chunks
            res.end = function(chunk, encoding) {
                if (chunk) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }

                // Get the complete response body
                let responseBody;
                try {
                    const buffer = Buffer.concat(chunks);
                    responseBody = buffer.toString(encoding || 'utf8');

                    // Try to parse JSON responses for better logging
                    if (res.getHeader('content-type')?.includes('application/json')) {
                        responseBody = JSON.parse(responseBody);
                    }

                    // Truncate large responses
                    if (typeof responseBody === 'string' && responseBody.length > 1000) {
                        responseBody = responseBody.substring(0, 1000) + '... [TRUNCATED]';
                    }
                } catch (err) {
                    responseBody = '[UNABLE TO CAPTURE RESPONSE BODY]';
                }

                // Calculate request duration
                const duration = Date.now() - req.startTime;

                // Log the response
                logger.info({
                    message: 'Response sent',
                    requestId: req.id,
                    method: req.method,
                    url: req.originalUrl,
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                    contentType: res.getHeader('content-type'),
                    contentLength: res.getHeader('content-length'),
                    responseBody,
                    duration: `${duration}ms`,
                    responseTime: duration,
                    timestamp: new Date().toISOString()
                });

                // Call the original end method
                return originalEnd.apply(res, arguments);
            };
        }

        // Log response errors
        res.on('error', (error) => {
            logger.error({
                message: 'Response error',
                requestId: req.id,
                method: req.method,
                url: req.originalUrl,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
        });

        next();
    };
}

/**
 * Sanitize request body to avoid logging sensitive information
 * @param {Object} body - Request body
 * @returns {Object} Sanitized body
 */
function sanitizeRequestBody(body) {
    if (!body) return {};

    // Create a shallow copy of the body
    const sanitized = { ...body };
    const { sensitiveFields, maxFieldLength, redactionText, truncationSuffix } = loggingConfig.sanitize;

    // Remove potentially sensitive fields
    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = redactionText;
        }
    }

    // For large prompt texts, truncate them
    if (sanitized.prompt && typeof sanitized.prompt === 'string' && sanitized.prompt.length > maxFieldLength) {
        sanitized.prompt = sanitized.prompt.substring(0, maxFieldLength) + truncationSuffix;
    }

    // For message arrays, truncate content
    if (sanitized.messages && Array.isArray(sanitized.messages)) {
        sanitized.messages = sanitized.messages.map(msg => {
            if (msg.content && typeof msg.content === 'string' && msg.content.length > maxFieldLength) {
                return {
                    ...msg,
                    content: msg.content.substring(0, maxFieldLength) + truncationSuffix
                };
            }
            return msg;
        });
    }

    return sanitized;
}

module.exports = {
    loggingMiddleware
};