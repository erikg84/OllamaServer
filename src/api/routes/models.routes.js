// src/api/routes/models.routes.js
const express = require('express');
const modelsController = require('../controllers/models.controller');

/**
 * Setup models routes
 * @param {Object} app - Express app
 * @param {Object} dependencies - Dependency container
 */
function setupModelsRoutes(app, dependencies) {
    const router = express.Router();

    // Middleware to ensure models routes have appropriate dependencies
    router.use((req, res, next) => {
        // Attach dependencies to app.locals if not already there
        if (dependencies.queueManager) {
            req.app.locals.queueManager = dependencies.queueManager;
        }
        if (dependencies.metricsManager) {
            req.app.locals.metricsManager = dependencies.metricsManager;
        }
        next();
    });

    // Get list of models
    router.get('/', modelsController.getModels);

    // Get details for a specific model
    router.get('/:id', modelsController.getModelDetails);

    // Add more model-related routes as needed
    // For example:
    // router.get('/capabilities/:capability', modelsController.getModelsByCapability);
    // router.get('/agents/:role', modelsController.getModelsByAgentRole);

    // Mount the router at the /models prefix
    app.use('/models', router);

    return router;
}

module.exports = setupModelsRoutes;