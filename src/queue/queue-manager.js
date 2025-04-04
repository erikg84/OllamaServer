// src/queue/queue-manager.js
const logger = require('../logging/logger');

async function initQueueManager() {
    try {
        logger.info({
            message: 'Initializing queue manager',
            timestamp: new Date().toISOString()
        });

        const PQueue = (await import('p-queue')).default;
        const queue = new PQueue({
            concurrency: 5,
            autoStart: true
        });

        // Add queue logging
        queue.on('add', () => {
            logger.info({
                message: 'Task added to queue',
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('next', () => {
            logger.info({
                message: 'Starting next task',
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('completed', () => {
            logger.info({
                message: 'Task completed',
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('error', (error) => {
            logger.error({
                message: 'Queue task error',
                error: error.message,
                stack: error.stack,
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        logger.info({
            message: 'Queue initialized successfully',
            concurrency: 5,
            timestamp: new Date().toISOString()
        });

        return {
            add: (task) => queue.add(task),
            pause: () => queue.pause(),
            resume: () => queue.resume(),
            clear: () => queue.clear(),
            size: () => queue.size,
            pending: () => queue.pending,
            isPaused: () => queue.isPaused
        };
    } catch (error) {
        logger.error({
            message: 'Failed to initialize queue manager',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        throw error;
    }
}

module.exports = { initQueueManager };