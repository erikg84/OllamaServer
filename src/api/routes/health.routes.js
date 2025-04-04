// src/api/routes/health.routes.js
const express = require('express');
const healthController = require('../controllers/health.controller');

/**
 * Setup health check routes
 * @param {Object} app - Express app
 * @param {Object} dependencies - Dependency container
 */
function setupHealthRoutes(app, dependencies) {
    const router = express.Router();

    // Middleware to ensure health routes have appropriate dependencies
    router.use((req, res, next) => {
        // Attach dependencies to app.locals if not already there
        if (dependencies.queueManager) {
            req.app.locals.queueManager = dependencies.queueManager;
        }
        if (dependencies.metricsManager) {
            req.app.locals.metricsManager = dependencies.metricsManager;
        }
        if (dependencies.serverId) {
            req.app.locals.serverId = dependencies.serverId;
        }
        next();
    });

    // Basic health check
    router.get('/', healthController.getHealth);

    // Detailed health check
    router.get('/detailed', healthController.getDetailedHealth);

    // Mount the router at the /health prefix
    app.use('/health', router);

    return router;
}

module.exports = setupHealthRoutes;