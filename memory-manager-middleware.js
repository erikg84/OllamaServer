/**
 * Memory Manager Middleware for Express
 *
 * This middleware checks memory availability before processing requests
 * and applies memory-based constraints when needed.
 */

/**
 * Create memory middleware with provided logger
 * @param {Object} logger - Winston logger instance
 * @returns {Function} Express middleware function
 */
function createMemoryMiddleware(logger) {
    return function memoryMiddleware(req, res, next) {
        // Skip memory check for health and admin endpoints
        if (req.path.startsWith('/health') ||
            req.path.startsWith('/admin') ||
            req.path === '/queue-status' ||
            req.path === '/models') {
            return next();
        }

// Check if memory manager is initialized
        if (!global.memoryManager) {
            logger.warn({
                message: 'Memory manager not initialized',
                requestId: req.id,
                path: req.path,
                timestamp: new Date().toISOString()
            });
            return next();
        }

// Get model ID from request
        const modelId = req.body.model || 'default';

// Check if memory is available for this request
        const memoryCheck = global.memoryManager.canProcessRequest(modelId, req.body);

        if (!memoryCheck.allowed) {
// Request rejected due to memory constraints
            logger.warn({
                message: 'Request rejected due to memory constraints',
                requestId: req.id,
                model: modelId,
                reason: memoryCheck.reason,
                memoryNeeded: `${memoryCheck.memoryNeeded} MB`,
                memoryAvailable: `${memoryCheck.memoryAvailable} MB`,
                memoryState: memoryCheck.memoryState,
                path: req.path,
                timestamp: new Date().toISOString()
            });

// Increment rejected counter
            global.memoryManager.rejectedRequests++;

// Return error response
            return res.status(503).json({
                status: 'error',
                message: `Request rejected: ${memoryCheck.reason}`,
                details: {
                    memoryState: memoryCheck.memoryState,
                    memoryNeeded: `${memoryCheck.memoryNeeded} MB`,
                    memoryAvailable: `${memoryCheck.memoryAvailable} MB`
                }
            });
        }

// Apply memory constraints to request if needed
        if (memoryCheck.memoryState === 'warning' || memoryCheck.memoryState === 'critical') {
            req.body = global.memoryManager.applyMemoryConstraints(req.body, modelId);
        }

// Start tracking request memory
        req.memoryTracking = global.memoryManager.trackRequestMemory(req.id, modelId, req.body);

// Pass control to next middleware
        next();
    };
}

module.exports = createMemoryMiddleware;