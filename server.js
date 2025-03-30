const express = require('express');
const axios = require('axios');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

// Set up logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'server.log' })
    ]
});

const app = express();
app.use(express.json());

let queue;

// Llama API base URL
const LLAMA_BASE_URL = 'http://localhost:11434/api';

// Add request ID middleware
app.use((req, res, next) => {
    req.id = uuidv4();
    res.locals.startTime = Date.now();

    // Log incoming request
    logger.info({
        message: 'Request received',
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.get('user-agent')
    });

    // Log response when finished
    res.on('finish', () => {
        const duration = Date.now() - res.locals.startTime;
        logger.info({
            message: 'Response sent',
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            duration: `${duration}ms`
        });
    });

    next();
});

(async () => {
    try {
        logger.info('Initializing server and importing p-queue...');
        const PQueue = (await import('p-queue')).default;
        queue = new PQueue({
            concurrency: 5,
            autoStart: true
        });

        // Add queue logging
        queue.on('add', () => {
            logger.info({
                message: 'Task added to queue',
                queueSize: queue.size,
                queuePending: queue.pending
            });
        });

        queue.on('next', () => {
            logger.info({
                message: 'Starting next task',
                queueSize: queue.size,
                queuePending: queue.pending
            });
        });

        queue.on('completed', () => {
            logger.info({
                message: 'Task completed',
                queueSize: queue.size,
                queuePending: queue.pending
            });
        });

        queue.on('error', (error) => {
            logger.error({
                message: 'Queue task error',
                error: error.message,
                stack: error.stack,
                queueSize: queue.size,
                queuePending: queue.pending
            });
        });

        logger.info('Queue initialized successfully');

        // Start the server
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } catch (error) {
        logger.error({
            message: 'Failed to initialize server',
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
})();

// Health check endpoint
app.get('/health', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Health check requested',
        requestId
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding health check to queue',
            requestId
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing health check request',
                requestId
            });

            try {
                const response = await axios.get(`${LLAMA_BASE_URL}/tags`);
                logger.info({
                    message: 'Health check API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`
                });
                return response;
            } catch (error) {
                logger.error({
                    message: 'Health check API call failed',
                    requestId,
                    error: error.message,
                    duration: `${Date.now() - startTime}ms`
                });
                throw error;
            }
        });

        logger.info({
            message: 'Health check successful',
            requestId,
            duration: `${Date.now() - startTime}ms`
        });

        res.json({ status: 'ok', tags: result.data });
    } catch (error) {
        logger.error({
            message: 'Health check failed',
            requestId,
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Generation endpoint with queuing
app.post('/generate', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Generate request received',
        requestId,
        model: req.body.model,
        promptLength: req.body.prompt ? req.body.prompt.length : 'undefined'
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding generate request to queue',
            requestId
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing generate request',
                requestId,
                model: req.body.model
            });

            try {
                const response = await axios.post(`${LLAMA_BASE_URL}/generate`, req.body);
                logger.info({
                    message: 'Generate API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    responseSize: JSON.stringify(response.data).length
                });
                return response;
            } catch (error) {
                logger.error({
                    message: 'Generate API call failed',
                    requestId,
                    error: error.message,
                    duration: `${Date.now() - startTime}ms`
                });
                throw error;
            }
        });

        logger.info({
            message: 'Generate request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Generate request failed',
            requestId,
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Chat endpoint with queuing
app.post('/chat', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Chat request received',
        requestId,
        model: req.body.model,
        messagesCount: req.body.messages ? req.body.messages.length : 'undefined'
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding chat request to queue',
            requestId
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing chat request',
                requestId,
                model: req.body.model
            });

            try {
                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, req.body);
                logger.info({
                    message: 'Chat API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    responseSize: JSON.stringify(response.data).length
                });
                return response;
            } catch (error) {
                logger.error({
                    message: 'Chat API call failed',
                    requestId,
                    error: error.message,
                    duration: `${Date.now() - startTime}ms`
                });
                throw error;
            }
        });

        logger.info({
            message: 'Chat request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Chat request failed',
            requestId,
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// List models endpoint
app.get('/models', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Models list requested',
        requestId
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding models list request to queue',
            requestId
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing models list request',
                requestId
            });

            try {
                // Use /tags endpoint instead of /list
                const response = await axios.get(`${LLAMA_BASE_URL}/tags`);
                logger.info({
                    message: 'Models list API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    modelsCount: response.data.models ? response.data.models.length : 'undefined'
                });
                return response;
            } catch (error) {
                logger.error({
                    message: 'Models list API call failed',
                    requestId,
                    error: error.message,
                    duration: `${Date.now() - startTime}ms`
                });
                throw error;
            }
        });

        logger.info({
            message: 'Models list request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Models list request failed',
            requestId,
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Queue status endpoint (optional but helpful)
app.get('/queue-status', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Queue status requested',
        requestId
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    const status = {
        size: queue.size,
        pending: queue.pending,
        isPaused: queue.isPaused
    };

    logger.info({
        message: 'Queue status request successful',
        requestId,
        queueSize: status.size,
        queuePending: status.pending,
        queuePaused: status.isPaused
    });

    res.json(status);
});

// Catch-all error handler
app.use((err, req, res, next) => {
    const requestId = req.id || 'unknown';

    logger.error({
        message: 'Unhandled error',
        requestId,
        error: err.message,
        stack: err.stack
    });

    res.status(500).json({
        status: 'error',
        message: 'An unexpected error occurred'
    });
});
