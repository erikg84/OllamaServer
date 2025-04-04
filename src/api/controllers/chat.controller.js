// src/api/controllers/chat.controller.js
const logger = require('../../logging/logger');
const { llamaService } = require('../../services/llama.service');

/**
 * Process chat request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function processChat(req, res, next) {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';

    // Enhanced chat request logging
    logger.info({
        message: 'Chat request received',
        requestId,
        model,
        node,
        messagesCount: req.body.messages ? req.body.messages.length : 'undefined',
        options: req.body.options || {},
        systemPromptLength: req.body.system ? req.body.system.length : 0,
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
        if (!validateChatRequest(req.body)) {
            logger.warn({
                message: 'Invalid chat request',
                requestId,
                model,
                node,
                validation: 'Failed',
                timestamp: new Date().toISOString()
            });
            return res.status(400).json({
                status: 'error',
                message: 'Invalid request parameters. Model and messages are required.'
            });
        }

        logger.info({
            message: 'Adding chat request to queue',
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
                message: 'Executing chat request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            // Call Llama service to process chat request
            const response = await llamaService.chat(req.body);

            // Update metrics if metrics manager is available
            if (metricsManager) {
                metricsManager.updateMetrics(node, model, startTime, response.data);
            }

            return response;
        });

        // Extract usage metrics for enhanced logging
        const usage = result.data.usage || {};
        const inputTokens = usage.prompt_tokens || 0;
        const outputTokens = usage.completion_tokens || 0;
        const totalTokens = usage.total_tokens || inputTokens + outputTokens;
        const duration = Date.now() - startTime;
        const tokensPerSecond = outputTokens > 0 ? (outputTokens / (duration / 1000)).toFixed(2) : 0;

        logger.info({
            message: 'Chat request successful',
            requestId,
            model,
            node,
            duration: `${duration}ms`,
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens,
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
            message: 'Chat request failed',
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
 * Validates chat request parameters
 * @param {Object} body - Request body
 * @returns {boolean} - Whether the request is valid
 */
function validateChatRequest(body) {
    // Check for required fields
    if (!body.model) {
        return false;
    }

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return false;
    }

    // Check message format
    for (const message of body.messages) {
        if (!message.role || !message.content) {
            return false;
        }

        // Validate role
        if (!['system', 'user', 'assistant'].includes(message.role)) {
            return false;
        }
    }

    return true;
}

module.exports = {
    processChat
};