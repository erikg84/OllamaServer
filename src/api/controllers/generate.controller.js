// src/api/controllers/generate.controller.js
const logger = require('../../logging/logger');
const { llamaService } = require('../../services/llama.service');

/**
 * Process text generation request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function processGeneration(req, res, next) {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';

    // Enhanced generate request logging
    logger.info({
        message: 'Generate request received',
        requestId,
        model,
        node,
        promptLength: req.body.prompt ? req.body.prompt.length : 'undefined',
        options: req.body.options || {},
        timestamp: new Date().toISOString()
    });

    try {
        const queueManager = req.app.locals.queueManager;
        const metricsManager = req.app.locals.metricsManager;

        if (!queueManager) {
            logger.error({
                message: 'Queue not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        // Validate request body
        if (!validateGenerationRequest(req.body)) {
            logger.warn({
                message: 'Invalid generation request',
                requestId,
                model,
                node,
                validation: 'Failed',
                timestamp: new Date().toISOString()
            });
            return res.status(400).json({
                status: 'error',
                message: 'Invalid request parameters. Model and prompt are required.'
            });
        }

        logger.info({
            message: 'Adding generate request to queue',
            requestId,
            model,
            queueSize: queueManager.size(),
            queuePending: queueManager.pending(),
            timestamp: new Date().toISOString()
        });

        const queueStartTime = Date.now();
        const result = await queueManager.add(async () => {
            const queueWaitTime = Date.now() - queueStartTime;

            logger.info({
                message: 'Executing generate request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            // Call Llama service to process generation request
            const response = await llamaService.generate(req.body);

            // Update metrics if metrics manager is available
            if (metricsManager) {
                metricsManager.updateMetrics(node, model, startTime, response.data);
            }

            return response;
        });

        // Extract metrics from response for logging
        const tokenCount = result.data.eval_count || 0;
        const promptTokens = result.data.prompt_eval_count || 0;
        const duration = Date.now() - startTime;
        const tokensPerSecond = tokenCount > 0 ? (tokenCount / (duration / 1000)).toFixed(2) : 0;

        logger.info({
            message: 'Generate request successful',
            requestId,
            model,
            node,
            duration: `${duration}ms`,
            tokenCount,
            promptTokens,
            totalTokens: promptTokens + tokenCount,
            tokensPerSecond: `${tokensPerSecond} tokens/sec`,
            timestamp: new Date().toISOString()
        });

        res.json(result.data);
    } catch (error) {
        const duration = Date.now() - startTime;

        // Update metrics for error if metrics manager is available
        const metricsManager = req.app.locals.metricsManager;
        if (metricsManager) {
            metricsManager.updateMetrics(node, model, startTime, null, true);
        }

        logger.error({
            message: 'Generate request failed',
            requestId,
            model,
            node,
            error: error.message,
            stack: error.stack,
            duration: `${duration}ms`,
            timestamp: new Date().toISOString()
        });

        const statusCode = error.response?.status || 500;
        const errorMessage = error.response?.data?.message || error.message;

        res.status(statusCode).json({
            status: 'error',
            message: errorMessage
        });
    }
}

/**
 * Validates generation request parameters
 * @param {Object} body - Request body
 * @returns {boolean} - Whether the request is valid
 */
function validateGenerationRequest(body) {
    // Check for required fields
    if (!body.model) {
        return false;
    }

    if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
        return false;
    }

    return true;
}

module.exports = {
    processGeneration
};