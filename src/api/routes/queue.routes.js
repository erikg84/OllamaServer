// src/api/routes/queue.routes.js
const express = require('express');
const queueController = require('../controllers/queue.controller');

/**
 * Setup queue management routes
 * @param {Object} app - Express app
 * @param {Object} dependencies - Dependency container
 */
function setupQueueRoutes(app, dependencies) {
    const router = express.Router();

    // Middleware to ensure queue routes have appropriate dependencies
    router.use((req, res, next) => {
        // Attach dependencies to app.locals if not already there
        if (dependencies.queueManager) {
            req.app.locals.queueManager = dependencies.queueManager;
        }
        next();
    });

    // Get queue status
    router.get('/status', queueController.getQueueStatus);

    // Pause queue
    router.post('/pause', queueController.pauseQueue);

    // Resume queue
    router.post('/resume', queueController.resumeQueue);

    // Clear queue
    router.post('/clear', queueController.clearQueue);

    // Configure queue
    router.post('/configure', queueController.configureQueue);

    // Mount the router at the /queue prefix
    app.use('/queue', router);

    return router;
}

module.exports = setupQueueRoutes;