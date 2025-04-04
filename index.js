// index.js
const { startServer } = require('./src/core/server');
const logger = require('./src/logging/logger');

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error({
        message: 'Uncaught exception',
        error: error.message,
        stack: error.stack,
        fatal: true,
        timestamp: new Date().toISOString()
    });

    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error({
        message: 'Unhandled promise rejection',
        reason: reason.toString(),
        stack: reason.stack,
        fatal: false,
        timestamp: new Date().toISOString()
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info({
        message: 'Server shutting down',
        reason: 'SIGINT received',
        timestamp: new Date().toISOString()
    });
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info({
        message: 'Server shutting down',
        reason: 'SIGTERM received',
        timestamp: new Date().toISOString()
    });
    process.exit(0);
});

// Start the server
startServer().catch(err => {
    logger.error({
        message: 'Failed to start server',
        error: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString()
    });
    process.exit(1);
});