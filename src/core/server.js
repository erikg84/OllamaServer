// src/core/server.js
const express = require('express');
const { serverConfig } = require('../config');
const logger = require('../logging/logger');
const { requestIdMiddleware } = require('../middleware/request-id.middleware');
const { loggingMiddleware } = require('../middleware/logging.middleware');
const { errorMiddleware } = require('../middleware/error.middleware');
const { initQueueManager } = require('../queue/queue-manager');
const { initMetricsManager } = require('../metrics/metrics-manager');
const { registerRoutes } = require('../api/routes');
const os = require('os');
const ip = require('ip');

// Get server identity information
const SERVER_ID = {
    hostname: os.hostname(),
    ipAddress: ip.address(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version
};

async function startServer() {
    logger.info({
        message: 'Server starting',
        version: serverConfig.version,
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        cpuCores: os.cpus().length,
        totalMemory: `${Math.round(os.totalmem() / (1024 * 1024))} MB`,
        freeMemory: `${Math.round(os.freemem() / (1024 * 1024))} MB`
    });

    // Initialize the app
    const app = express();

    // Apply middleware
    app.use(express.json({ limit: '50mb' }));
    app.use(requestIdMiddleware());
    app.use(loggingMiddleware());

    // Initialize core services
    const queueManager = await initQueueManager();
    const metricsManager = initMetricsManager();

    // Start periodic tasks
    metricsManager.startPeriodicTasks();

    // Register API routes
    registerRoutes(app, {
        queueManager,
        metricsManager,
        serverId: SERVER_ID
    });

    // Apply error middleware
    app.use(errorMiddleware());

    // Start the server
    const PORT = serverConfig.port;
    return new Promise((resolve, reject) => {
        const server = app.listen(PORT, () => {
            logger.info({
                message: `Server running on port ${PORT}`,
                port: PORT,
                serverUrl: `http://${SERVER_ID.ipAddress}:${PORT}`,
                timestamp: new Date().toISOString()
            });
            resolve(server);
        });

        server.on('error', (error) => {
            reject(error);
        });
    });
}

module.exports = { startServer };