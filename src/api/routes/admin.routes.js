// src/api/routes/admin.routes.js
const express = require('express');
const adminController = require('../controllers/admin.controller');

/**
 * Setup admin routes
 * @param {Object} app - Express app
 * @param {Object} dependencies - Dependency container
 */
function setupAdminRoutes(app, dependencies) {
    const router = express.Router();

    // Middleware to ensure admin routes have appropriate dependencies
    router.use((req, res, next) => {
        // Attach dependencies to app.locals if not already there
        if (dependencies.metricsManager) {
            req.app.locals.metricsManager = dependencies.metricsManager;
        }
        if (dependencies.serverId) {
            req.app.locals.serverId = dependencies.serverId;
        }
        if (dependencies.serverConfig) {
            req.app.locals.serverConfig = dependencies.serverConfig;
        }
        next();
    });

    // Get system metrics
    router.get('/metrics', adminController.getMetrics);

    // Get system information
    router.get('/system', adminController.getSystemInfo);

    // Reset stats
    router.post('/reset-stats', adminController.resetStats);

    // Get logs
    router.get('/logs', adminController.getLogs);

    // Mount the router at the /admin prefix
    app.use('/admin', router);

    return router;
}

module.exports = setupAdminRoutes;