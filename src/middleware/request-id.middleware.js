// src/middleware/request-id.middleware.js
const { v4: uuidv4 } = require('uuid');

/**
 * Request ID middleware factory
 * Creates middleware that generates and attaches a unique ID to each request
 * @param {Object} options - Middleware options
 * @param {string} options.headerName - Name of the header containing the request ID (default: X-Request-ID)
 * @param {boolean} options.setHeader - Whether to set the request ID header in the response (default: true)
 * @param {boolean} options.attributeName - Name of the request attribute to set (default: id)
 * @returns {Function} Request ID middleware
 */
function requestIdMiddleware(options = {}) {
    const headerName = options.headerName || 'X-Request-ID';
    const setHeader = options.setHeader !== false; // default: true
    const attributeName = options.attributeName || 'id';

    /**
     * Request ID middleware
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     */
    return (req, res, next) => {
        // Try to get the request ID from the header, or generate a new one
        const requestId = req.get(headerName) || uuidv4();

        // Attach the request ID to the request object
        req[attributeName] = requestId;

        // Set the request ID header in the response if enabled
        if (setHeader) {
            res.set(headerName, requestId);
        }

        // Continue with the next middleware
        next();
    };
}

module.exports = {
    requestIdMiddleware
};