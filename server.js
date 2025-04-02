const express = require('express');
const axios = require('axios');
const winston = require('winston');
const os = require('os');
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
    const startTime = Date.now();
    const node = req.body.node;
    const model = req.body.model;

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
                updateMetrics(node, model, startTime, response.data);
                logger.info({
                    message: 'Generate API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    responseSize: JSON.stringify(response.data).length
                });
                return response;
            } catch (error) {
                updateMetrics(node, model, startTime, null, true);
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
                updateMetrics(req.body.node, req.body.model, startTime, response.data);
                logger.info({
                    message: 'Chat API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    responseSize: JSON.stringify(response.data).length
                });
                return response;
            } catch (error) {
                updateMetrics(req.body.node, req.body.model, startTime, null, true);
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

// Shift metrics every 5 minutes
function shiftMetrics() {
    // For response times
    Object.keys(metrics.responseTimes).forEach(nodeId => {
        // Remove oldest time point
        metrics.responseTimes[nodeId].shift();

        // Add new time point
        const latestTime = metrics.responseTimes[nodeId][metrics.responseTimes[nodeId].length - 1].time;
        const minutes = parseInt(latestTime) + 5;
        metrics.responseTimes[nodeId].push({ time: `${minutes}m`, value: 0 });
    });

    // For request counts
    metrics.requestCounts.shift();
    const latestTime = metrics.requestCounts[metrics.requestCounts.length - 1].time;
    const minutes = parseInt(latestTime) + 5;
    metrics.requestCounts.push({ time: `${minutes}m`, value: 0 });
}

// Set up metrics shifting every 5 minutes
setInterval(shiftMetrics, 5 * 60 * 1000);

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
                const response = await axios.get(`${LLAMA_BASE_URL}/tags`);

                // Transform the data to match what the Kotlin service expects
                const transformedModels = response.data.models.map(model => ({
                    id: model.model,
                    name: model.name || model.model,
                    type: model.details?.family || "unknown",
                    size: model.size,
                    quantization: model.details?.quantization_level || "unknown"
                }));

                logger.info({
                    message: 'Models list API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    modelsCount: transformedModels.length
                });

                return { data: transformedModels };
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

        // Return the transformed array directly, not nested in an object
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

const metrics = {
    startTime: Date.now(),
    responseTimes: {},
    requestCounts: [],
    nodePerformance: {},
    modelPerformance: {}
};

// Initialize metrics
function initializeMetrics() {
    // Create initial time series points for the last hour (12 5-minute intervals)
    const timePoints = Array.from({ length: 12 }, (_, i) => {
        const minutes = i * 5;
        return { time: `${minutes}m`, value: 0 };
    });

    metrics.requestCounts = [...timePoints];

    // Initialize empty node and model performance objects
    // These will be populated as requests come in
}

// Update metrics after each Ollama API call
function updateMetrics(nodeId, modelId, startTime, responseData, isError = false) {
    const duration = Date.now() - startTime;

    // Update response times
    if (!metrics.responseTimes[nodeId]) {
        metrics.responseTimes[nodeId] = [];

        // Initialize with 12 time points
        for (let i = 0; i < 12; i++) {
            const minutes = i * 5;
            metrics.responseTimes[nodeId].push({ time: `${minutes}m`, value: 0 });
        }
    }

    // Add current response time to the latest time point
    const latestTimePoint = metrics.responseTimes[nodeId].length - 1;
    const currentAvg = metrics.responseTimes[nodeId][latestTimePoint].value || 0;
    const count = metrics.nodePerformance[nodeId]?.requestsProcessed || 0;

    if (count > 0) {
        metrics.responseTimes[nodeId][latestTimePoint].value =
            (currentAvg * count + duration) / (count + 1);
    } else {
        metrics.responseTimes[nodeId][latestTimePoint].value = duration;
    }

    // Update request counts for the latest time point
    metrics.requestCounts[metrics.requestCounts.length - 1].value += 1;

    // Update node performance
    if (!metrics.nodePerformance[nodeId]) {
        metrics.nodePerformance[nodeId] = {
            avgResponseTime: 0,
            requestsProcessed: 0,
            errorRate: 0
        };
    }

    const nodeMetrics = metrics.nodePerformance[nodeId];
    nodeMetrics.requestsProcessed += 1;
    nodeMetrics.avgResponseTime =
        (nodeMetrics.avgResponseTime * (nodeMetrics.requestsProcessed - 1) + duration) /
        nodeMetrics.requestsProcessed;

    if (isError) {
        const errorCount = (nodeMetrics.errorRate / 100) * (nodeMetrics.requestsProcessed - 1);
        nodeMetrics.errorRate = ((errorCount + 1) / nodeMetrics.requestsProcessed) * 100;
    }

    // Update model performance
    if (!metrics.modelPerformance[modelId]) {
        metrics.modelPerformance[modelId] = {
            avgResponseTime: 0,
            requestsProcessed: 0,
            avgTokensGenerated: 0
        };
    }

    const modelMetrics = metrics.modelPerformance[modelId];
    modelMetrics.requestsProcessed += 1;
    modelMetrics.avgResponseTime =
        (modelMetrics.avgResponseTime * (modelMetrics.requestsProcessed - 1) + duration) /
        modelMetrics.requestsProcessed;

    // Extract token count from Ollama response if available
    let tokensGenerated = 0;
    if (responseData) {
        if (responseData.eval_count) {
            // For generate endpoint
            tokensGenerated = responseData.eval_count;
        } else if (responseData.usage && responseData.usage.completion_tokens) {
            // For chat endpoint
            tokensGenerated = responseData.usage.completion_tokens;
        }
    }

    modelMetrics.avgTokensGenerated =
        (modelMetrics.avgTokensGenerated * (modelMetrics.requestsProcessed - 1) + tokensGenerated) /
        modelMetrics.requestsProcessed;
}

// Get metrics
app.get('/admin/metrics', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Metrics requested',
        requestId
    });

    res.json({
        status: 'ok',
        data: metrics
    });
});

// Get system information
app.get('/admin/system', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'System info requested',
        requestId
    });

    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);

    const systemInfo = {
        apiVersion: '1.0.0',
        uptime: uptime,
        cpuUsage: process.cpuUsage().user / 1000000,
        memoryUsage: {
            used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
            total: `${Math.round(os.totalmem() / 1024 / 1024)} MB`
        },
        diskUsage: {
            used: 'N/A',
            total: 'N/A'
        },
        nodeJsVersion: process.version,
        expressVersion: require('express/package.json').version,
        environment: process.env.NODE_ENV || 'development'
    };

    res.json({
        status: 'ok',
        data: systemInfo
    });
});

// Reset metrics
app.post('/admin/reset-stats', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Stats reset requested',
        requestId
    });

    // Reset metrics
    metrics.responseTimes = {};
    metrics.requestCounts = [];
    metrics.nodePerformance = {};
    metrics.modelPerformance = {};

    // Reinitialize
    initializeMetrics();

    res.json({
        status: 'ok',
        message: 'Statistics reset successfully'
    });
});

// Get logs (simplified - returns recent log entries)
app.get('/admin/logs', (req, res) => {
    const requestId = req.id;
    const level = req.query.level;

    logger.info({
        message: 'Logs requested',
        requestId,
        level
    });

    // This is a simplified implementation
    // In a real implementation, you would need to store and retrieve your logs
    const logEntries = [
        {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: 'Server started',
            source: 'server.js'
        }
    ];

    if (level) {
        const filteredLogs = logEntries.filter(entry => entry.level === level);
        res.json({
            status: 'ok',
            data: filteredLogs
        });
    } else {
        res.json({
            status: 'ok',
            data: logEntries
        });
    }
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

initializeMetrics();
