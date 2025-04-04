// src/api/controllers/health.controller.js
const logger = require('../../logging/logger');
const { llamaService } = require('../../services/llama.service');

async function getHealth(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Health check requested',
        requestId,
        endpoint: '/health',
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

        logger.info({
            message: 'Adding health check to queue',
            requestId,
            queueSize: queueManager.size(),
            queuePending: queueManager.pending(),
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queueManager.add(async () => {
            logger.info({
                message: 'Executing health check request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            return await llamaService.getTags();
        });

        logger.info({
            message: 'Health check successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            tagsCount: result.data.models ? result.data.models.length : 0,
            timestamp: new Date().toISOString()
        });

        res.json({ status: 'ok', tags: result.data });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    getHealth
};