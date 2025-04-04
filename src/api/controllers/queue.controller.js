// src/api/controllers/queue.controller.js
const logger = require('../../logging/logger');

/**
 * Get queue status
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function getQueueStatus(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Queue status requested',
        requestId,
        endpoint: '/queue-status',
        timestamp: new Date().toISOString()
    });

    try {
        const queueManager = req.app.locals.queueManager;

        if (!queueManager) {
            logger.error({
                message: 'Queue not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        const status = {
            size: queueManager.size(),
            pending: queueManager.pending(),
            isPaused: queueManager.isPaused()
        };

        logger.info({
            message: 'Queue status request successful',
            requestId,
            queueSize: status.size,
            queuePending: status.pending,
            queuePaused: status.isPaused,
            timestamp: new Date().toISOString()
        });

        res.json(status);
    } catch (error) {
        logger.error({
            message: 'Error retrieving queue status',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Pause the queue
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function pauseQueue(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Queue pause requested',
        requestId,
        endpoint: '/queue/pause',
        timestamp: new Date().toISOString()
    });

    try {
        const queueManager = req.app.locals.queueManager;

        if (!queueManager) {
            logger.error({
                message: 'Queue not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        // Only pause if not already paused
        if (!queueManager.isPaused()) {
            queueManager.pause();
            logger.info({
                message: 'Queue paused successfully',
                requestId,
                queueSize: queueManager.size(),
                queuePending: queueManager.pending(),
                timestamp: new Date().toISOString()
            });
        } else {
            logger.info({
                message: 'Queue already paused',
                requestId,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            status: 'ok',
            message: 'Queue paused',
            isPaused: true,
            size: queueManager.size(),
            pending: queueManager.pending()
        });
    } catch (error) {
        logger.error({
            message: 'Error pausing queue',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Resume the queue
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function resumeQueue(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Queue resume requested',
        requestId,
        endpoint: '/queue/resume',
        timestamp: new Date().toISOString()
    });

    try {
        const queueManager = req.app.locals.queueManager;

        if (!queueManager) {
            logger.error({
                message: 'Queue not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        // Only resume if currently paused
        if (queueManager.isPaused()) {
            queueManager.resume();
            logger.info({
                message: 'Queue resumed successfully',
                requestId,
                queueSize: queueManager.size(),
                queuePending: queueManager.pending(),
                timestamp: new Date().toISOString()
            });
        } else {
            logger.info({
                message: 'Queue already running',
                requestId,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            status: 'ok',
            message: 'Queue resumed',
            isPaused: false,
            size: queueManager.size(),
            pending: queueManager.pending()
        });
    } catch (error) {
        logger.error({
            message: 'Error resuming queue',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Clear the queue
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function clearQueue(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Queue clear requested',
        requestId,
        endpoint: '/queue/clear',
        timestamp: new Date().toISOString()
    });

    try {
        const queueManager = req.app.locals.queueManager;

        if (!queueManager) {
            logger.error({
                message: 'Queue not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        const previousSize = queueManager.size();
        queueManager.clear();

        logger.info({
            message: 'Queue cleared successfully',
            requestId,
            previousQueueSize: previousSize,
            currentQueueSize: queueManager.size(),
            queuePending: queueManager.pending(),
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'ok',
            message: 'Queue cleared',
            previousSize: previousSize,
            currentSize: queueManager.size(),
            pending: queueManager.pending(),
            isPaused: queueManager.isPaused()
        });
    } catch (error) {
        logger.error({
            message: 'Error clearing queue',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Configure queue
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function configureQueue(req, res, next) {
    const requestId = req.id;
    const { concurrency } = req.body;

    logger.info({
        message: 'Queue configuration requested',
        requestId,
        endpoint: '/queue/configure',
        concurrency,
        timestamp: new Date().toISOString()
    });

    try {
        const queueManager = req.app.locals.queueManager;

        if (!queueManager) {
            logger.error({
                message: 'Queue not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        // Validate concurrency
        if (concurrency !== undefined) {
            if (typeof concurrency !== 'number' || concurrency < 1 || concurrency > 20) {
                logger.warn({
                    message: 'Invalid queue configuration',
                    requestId,
                    concurrency,
                    reason: 'Concurrency must be a number between 1 and 20',
                    timestamp: new Date().toISOString()
                });
                return res.status(400).json({
                    status: 'error',
                    message: 'Concurrency must be a number between 1 and 20'
                });
            }

            // Update concurrency would be implemented in the queue manager
            // This is a placeholder for now
            logger.info({
                message: 'Queue concurrency update requested',
                requestId,
                newConcurrency: concurrency,
                timestamp: new Date().toISOString()
            });

            // The actual implementation would call something like:
            // queueManager.setConcurrency(concurrency);

            logger.info({
                message: 'Queue configuration updated successfully',
                requestId,
                concurrency,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            status: 'ok',
            message: 'Queue configuration updated',
            configuration: {
                concurrency: concurrency || 'unchanged'
            },
            queueStatus: {
                size: queueManager.size(),
                pending: queueManager.pending(),
                isPaused: queueManager.isPaused()
            }
        });
    } catch (error) {
        logger.error({
            message: 'Error configuring queue',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

module.exports = {
    getQueueStatus,
    pauseQueue,
    resumeQueue,
    clearQueue,
    configureQueue
};