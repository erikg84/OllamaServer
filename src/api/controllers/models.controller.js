// src/api/controllers/models.controller.js
const logger = require('../../logging/logger');
const { llamaService } = require('../../services/llama.service');

/**
 * Get list of available models
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function getModels(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Models list requested',
        requestId,
        endpoint: '/models',
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
            message: 'Adding models list request to queue',
            requestId,
            queueSize: queueManager.size(),
            queuePending: queueManager.pending(),
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queueManager.add(async () => {
            logger.info({
                message: 'Executing models list request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            // Call Llama service to get list of models
            const response = await llamaService.getTags();

            // Transform the data to match what the client expects
            const transformedModels = response.data.models.map(model => ({
                id: model.model,
                name: model.name || model.model,
                type: model.details?.family || "unknown",
                size: model.size,
                quantization: model.details?.quantization_level || "unknown",
                // Add additional fields for agent-based orchestration
                capabilities: extractModelCapabilities(model),
                agentRoles: determineAgentRoles(model),
                contextLength: model.details?.context_length || 4096
            }));

            return { data: transformedModels };
        });

        logger.info({
            message: 'Models list request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            modelsCount: result.data.length,
            timestamp: new Date().toISOString()
        });

        // Return the transformed array directly, not nested in an object
        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Models list request failed',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
}

/**
 * Get details for a specific model
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function getModelDetails(req, res, next) {
    const requestId = req.id;
    const modelId = req.params.id;

    logger.info({
        message: 'Model details requested',
        requestId,
        modelId,
        endpoint: `/models/${modelId}`,
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
            message: 'Adding model details request to queue',
            requestId,
            modelId,
            queueSize: queueManager.size(),
            queuePending: queueManager.pending(),
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queueManager.add(async () => {
            logger.info({
                message: 'Executing model details request',
                requestId,
                modelId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            // Call Llama service to get list of models
            const response = await llamaService.getTags();

            // Find the requested model
            const modelData = response.data.models.find(model => model.model === modelId);

            if (!modelData) {
                throw new Error(`Model "${modelId}" not found`);
            }

            // Transform the data to include more details
            const detailedModel = {
                id: modelData.model,
                name: modelData.name || modelData.model,
                type: modelData.details?.family || "unknown",
                size: modelData.size,
                quantization: modelData.details?.quantization_level || "unknown",
                capabilities: extractModelCapabilities(modelData),
                agentRoles: determineAgentRoles(modelData),
                contextLength: modelData.details?.context_length || 4096,
                parameters: modelData.details?.parameter_count || "unknown",
                architecture: modelData.details?.architecture || "unknown",
                // Add additional fields for MAESTRO system
                description: `${modelData.name || modelData.model} is a ${modelData.details?.family || "language"} model`,
                metrics: {
                    tokensPerSecond: 0, // This would be populated from metrics service
                    avgResponseTime: 0,  // This would be populated from metrics service
                    errorRate: 0         // This would be populated from metrics service
                }
            };

            return { data: detailedModel };
        });

        logger.info({
            message: 'Model details request successful',
            requestId,
            modelId,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        // Return the detailed model data
        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Model details request failed',
            requestId,
            modelId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        // Set appropriate status code for "not found" errors
        const statusCode = error.message.includes('not found') ? 404 : 500;

        res.status(statusCode).json({
            status: 'error',
            message: error.message
        });
    }
}

/**
 * Extract capabilities from model metadata
 * @param {Object} model - Model data
 * @returns {Array} - List of capabilities
 */
/**
 * Extract capabilities from model metadata
 * @param {Object} model - Model data
 * @returns {Array} - List of capabilities
 */
function extractModelCapabilities(model) {
    const capabilities = [];

    // Basic capabilities all LLMs have
    capabilities.push('text-generation');
    capabilities.push('chat');

    // Inference from model family, size, etc.
    const family = model.details?.family?.toLowerCase() || '';
    const modelName = model.model.toLowerCase();

    // Check for specific model types or sizes to infer capabilities
    if (modelName.includes('code') || family.includes('code')) {
        capabilities.push('code-generation');
        capabilities.push('code-understanding');
    }

    if (modelName.includes('instruct') || modelName.includes('chat')) {
        capabilities.push('instruction-following');
    }

    if (modelName.includes('vision') || modelName.includes('multimodal')) {
        capabilities.push('image-understanding');
    }

    // Size-based capability inference
    const parameterCount = model.details?.parameter_count || 0;
    if (typeof parameterCount === 'number' && parameterCount > 10000000000) { // 10B+
        capabilities.push('complex-reasoning');
        capabilities.push('creative-writing');
        capabilities.push('detailed-analysis');
    }

    return capabilities;
}

/**
 * Determine appropriate agent roles for a model based on its characteristics
 * @param {Object} model - Model data
 * @returns {Array} - List of agent roles this model can fulfill
 */
function determineAgentRoles(model) {
    const roles = [];
    const capabilities = extractModelCapabilities(model);
    const modelName = model.model.toLowerCase();

    // Base role that most models can fulfill
    roles.push('assistant');

    // Specialized roles based on capabilities
    if (capabilities.includes('code-generation') && capabilities.includes('code-understanding')) {
        roles.push('code-agent');
    }

    if (capabilities.includes('complex-reasoning')) {
        roles.push('reasoning-agent');
    }

    if (capabilities.includes('creative-writing')) {
        roles.push('creative-agent');
    }

    // Coordinator role for larger models
    const parameterCount = model.details?.parameter_count || 0;
    if (typeof parameterCount === 'number' && parameterCount > 30000000000) { // 30B+
        roles.push('coordinator');
    }

    // Critic role for highly instruct-tuned models
    if (modelName.includes('instruct') || modelName.includes('chat')) {
        roles.push('critic');
    }

    // Research agent for large context models
    const contextLength = model.details?.context_length || 4096;
    if (contextLength > 8192) {
        roles.push('research-agent');
    }

    return roles;
}

module.exports = {
    getModels,
    getModelDetails
};