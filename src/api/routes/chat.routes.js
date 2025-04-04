// src/api/routes/chat.routes.js
const express = require('express');
const chatController = require('../controllers/chat.controller');

/**
 * Setup chat routes
 * @param {Object} app - Express app
 * @param {Object} dependencies - Dependency container
 */
function setupChatRoutes(app, dependencies) {
    const router = express.Router();

    // Middleware to ensure chat routes have appropriate dependencies
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

    // Process chat request
    router.post('/', chatController.processChat);

    // Add more chat-related routes as needed
    // For example:
    // router.post('/stream', chatController.streamChat); // For streaming responses
    // router.post('/agent', chatController.agentChat); // For agent-based chat

    // Mount the router at the /chat prefix
    app.use('/chat', router);

    return router;
}

module.exports = setupChatRoutes;