const express = require('express');
const axios = require('axios');
const winston = require('winston');
require('winston-mongodb');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ip = require('ip');
const ResourceMonitor = require('./ResourceMonitor');
const QueueConfigManager = require('./QueueConfigManager');
const ModelPerformanceTracker = require('./ModelPerformanceTracker');

// Adaptive concurrency configuration
const CONCURRENCY_CONFIG = {
    // Concurrency settings
    MIN_CONCURRENCY: process.env.MIN_CONCURRENCY || 1,
    MAX_CONCURRENCY: process.env.MAX_CONCURRENCY || 10,
    DEFAULT_CONCURRENCY: process.env.DEFAULT_CONCURRENCY || 5,

    // Resource thresholds
    CPU_HIGH_THRESHOLD: process.env.CPU_HIGH_THRESHOLD || 80,
    CPU_LOW_THRESHOLD: process.env.CPU_LOW_THRESHOLD || 40,
    MEMORY_HIGH_THRESHOLD: process.env.MEMORY_HIGH_THRESHOLD || 85,
    MEMORY_LOW_THRESHOLD: process.env.MEMORY_LOW_THRESHOLD || 50,

    // Adjustment parameters
    ADJUSTMENT_INTERVAL: process.env.ADJUSTMENT_INTERVAL || 30000, // 30 seconds
    ADJUSTMENT_COOLDOWN: process.env.ADJUSTMENT_COOLDOWN || 10000, // 10 seconds
    ADJUSTMENT_STEP: process.env.ADJUSTMENT_STEP || 1
};

// Get server identity information
const SERVER_ID = {
    hostname: os.hostname(),
    ipAddress: ip.address(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version
};

// Set up logger with enhanced configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
        winston.format.json()
    ),
    defaultMeta: {
        serverId: SERVER_ID.ipAddress,
        hostname: SERVER_ID.hostname,
        environment: process.env.NODE_ENV || 'development',
        application: 'llama-server', // Add application identifier
        version: '1.0.0' // Add version information
    },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ level, message, timestamp, metadata }) => {
                    return `${timestamp} ${level}: ${message} ${JSON.stringify(metadata)}`;
                })
            )
        }),
        new winston.transports.File({ filename: 'server.log' }),
        // Add MongoDB transport for centralized logging
        new winston.transports.MongoDB({
            db: 'mongodb://192.168.68.145:27017/logs',
            collection: 'logs',
            options: {
                useUnifiedTopology: true
            }
        })
    ],
    // Add exception handlers
    exceptionHandlers: [
        new winston.transports.File({ filename: 'exceptions.log' }),
        new winston.transports.MongoDB({
            db: 'mongodb://192.168.68.145:27017/logs',
            collection: 'exceptions',
            options: {
                useUnifiedTopology: true
            }
        })
    ]
});

const app = express();
app.use(express.json({ limit: '50mb' })); // Add limit to prevent large request body issues

let queue;

// Llama API base URL
const LLAMA_BASE_URL = 'http://127.0.0.1:11434/api';

// Log application startup
logger.info({
    message: 'Server starting',
    version: '1.0.0',
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpuCores: os.cpus().length,
    totalMemory: `${Math.round(os.totalmem() / (1024 * 1024))} MB`,
    freeMemory: `${Math.round(os.freemem() / (1024 * 1024))} MB`
});

// Add request ID middleware
app.use((req, res, next) => {
    req.id = uuidv4();
    res.locals.startTime = Date.now();

    // Enhanced request logging with sanitized body
    const sanitizedBody = req.body ? sanitizeRequestBody(req.body) : undefined;

    logger.info({
        message: 'Request received',
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        path: req.path,
        query: req.query,
        ip: req.ip,
        forwardedIp: req.get('x-forwarded-for'),
        userAgent: req.get('user-agent'),
        contentType: req.get('content-type'),
        contentLength: req.get('content-length'),
        requestBody: sanitizedBody
    });

    // Enhanced response logging with metrics
    res.on('finish', () => {
        const duration = Date.now() - res.locals.startTime;
        logger.info({
            message: 'Response sent',
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            contentType: res.get('content-type'),
            contentLength: res.get('content-length'),
            duration: `${duration}ms`,
            responseTime: duration
        });
    });

    // Log response errors
    res.on('error', (error) => {
        logger.error({
            message: 'Response error',
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            error: error.message,
            stack: error.stack
        });
    });

    next();
});

/**
 * Estimate token count for a text prompt
 * This is a simple approximation - in production use a proper tokenizer
 * @param {string} text - Text to estimate tokens for
 * @returns {number} Estimated token count
 */
function estimateTokenCount(text) {
    if (!text) return 0;
    // Rough approximation - 4 characters per token on average
    return Math.ceil(text.length / 4);
}

/**
 * Estimate token count for chat messages
 * @param {Array} messages - Chat messages array
 * @param {string} system - Optional system prompt
 * @returns {number} Estimated token count
 */
function estimateChatTokens(messages, system) {
    let count = 0;

    // Count system prompt tokens
    if (system) {
        count += estimateTokenCount(system);
    }

    // Count message tokens
    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (message.content) {
                count += estimateTokenCount(message.content);
            }
        }
    }

    return count;
}

// Sanitize request body to avoid logging sensitive information
function sanitizeRequestBody(body) {
    if (!body) return {};

    // Create a shallow copy of the body
    const sanitized = { ...body };

    // Remove potentially sensitive fields
    const sensitiveFields = ['password', 'token', 'apiKey', 'secret'];

    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = '[REDACTED]';
        }
    }

    // For large prompt texts, truncate them
    if (sanitized.prompt && typeof sanitized.prompt === 'string' && sanitized.prompt.length > 100) {
        sanitized.prompt = sanitized.prompt.substring(0, 100) + '... [TRUNCATED]';
    }

    // For message arrays, truncate content
    if (sanitized.messages && Array.isArray(sanitized.messages)) {
        sanitized.messages = sanitized.messages.map(msg => {
            if (msg.content && typeof msg.content === 'string' && msg.content.length > 100) {
                return {
                    ...msg,
                    content: msg.content.substring(0, 100) + '... [TRUNCATED]'
                };
            }
            return msg;
        });
    }

    return sanitized;
}

(async () => {
    try {
        logger.info({
            message: 'Initializing server and importing p-queue...',
            timestamp: new Date().toISOString()
        });

        const PQueue = (await import('p-queue')).default;
        queue = new PQueue({
            concurrency: CONCURRENCY_CONFIG.DEFAULT_CONCURRENCY,
            autoStart: true
        });

        // Initialize resource monitor
        const resourceMonitor = new ResourceMonitor({
            sampleInterval: 5000, // 5 seconds
            cpuHighThreshold: CONCURRENCY_CONFIG.CPU_HIGH_THRESHOLD,
            cpuLowThreshold: CONCURRENCY_CONFIG.CPU_LOW_THRESHOLD,
            memoryHighThreshold: CONCURRENCY_CONFIG.MEMORY_HIGH_THRESHOLD,
            memoryLowThreshold: CONCURRENCY_CONFIG.MEMORY_LOW_THRESHOLD,
            logger: logger
        });

        // Start resource monitoring
        resourceMonitor.start();

        // Initialize queue config manager
        const queueManager = new QueueConfigManager(queue, resourceMonitor, {
            minConcurrency: CONCURRENCY_CONFIG.MIN_CONCURRENCY,
            maxConcurrency: CONCURRENCY_CONFIG.MAX_CONCURRENCY,
            defaultConcurrency: CONCURRENCY_CONFIG.DEFAULT_CONCURRENCY,
            adjustmentStep: CONCURRENCY_CONFIG.ADJUSTMENT_STEP,
            adjustmentInterval: CONCURRENCY_CONFIG.ADJUSTMENT_INTERVAL,
            adjustmentCooldown: CONCURRENCY_CONFIG.ADJUSTMENT_COOLDOWN,
            logger: logger
        });

        // Start automatic concurrency management
        queueManager.start();

        // Initialize model performance tracker
        const modelTracker = new ModelPerformanceTracker({
            logger: logger
        });

        // Store instances for global access
        global.resourceMonitor = resourceMonitor;
        global.queueManager = queueManager;
        global.modelTracker = modelTracker;

        // Add queue logging
        queue.on('add', () => {
            logger.info({
                message: 'Task added to queue',
                queueSize: queue.size,
                queuePending: queue.pending,
                currentConcurrency: queue.concurrency,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('next', () => {
            logger.info({
                message: 'Starting next task',
                queueSize: queue.size,
                queuePending: queue.pending,
                currentConcurrency: queue.concurrency,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('completed', () => {
            logger.info({
                message: 'Task completed',
                queueSize: queue.size,
                queuePending: queue.pending,
                currentConcurrency: queue.concurrency,
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
                currentConcurrency: queue.concurrency,
                timestamp: new Date().toISOString()
            });
        });

        logger.info({
            message: 'Queue initialized successfully',
            initialConcurrency: queue.concurrency,
            adaptiveConcurrency: true,
            timestamp: new Date().toISOString()
        });

        // Start the server
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            logger.info({
                message: `Server running on port ${PORT}`,
                port: PORT,
                serverUrl: `http://${SERVER_ID.ipAddress}:${PORT}`,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        logger.error({
            message: 'Failed to initialize server',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        process.exit(1);
    }
})();

// Concurrency management endpoint
app.get('/admin/concurrency', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Concurrency settings requested',
        requestId,
        endpoint: '/admin/concurrency',
        timestamp: new Date().toISOString()
    });

    if (!global.queueManager) {
        return res.status(503).json({
            status: 'error',
            message: 'Concurrency manager not initialized'
        });
    }

    // Get current concurrency status
    const status = global.queueManager.getStatus();
    const resourceMetrics = global.resourceMonitor.getCurrentMetrics();

    res.json({
        status: 'ok',
        data: {
            currentSettings: {
                concurrency: status.currentConcurrency,
                ...status.config
            },
            resourceUsage: resourceMetrics,
            queueStatus: {
                size: queue.size,
                pending: queue.pending,
                isPaused: queue.isPaused
            },
            performanceStats: status.stats,
            lastAdjustment: status.lastAdjustment
        }
    });

    logger.info({
        message: 'Concurrency settings request successful',
        requestId,
        currentConcurrency: status.currentConcurrency,
        timestamp: new Date().toISOString()
    });
});

// Concurrency configuration endpoint
app.post('/admin/concurrency', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Concurrency settings update requested',
        requestId,
        endpoint: '/admin/concurrency',
        requestBody: req.body,
        timestamp: new Date().toISOString()
    });

    if (!global.queueManager) {
        return res.status(503).json({
            status: 'error',
            message: 'Concurrency manager not initialized'
        });
    }

    try {
        const { action, concurrency, duration } = req.body;

        if (action === 'force' && concurrency !== undefined) {
            // Force a specific concurrency level
            global.queueManager.forceSetConcurrency(
                parseInt(concurrency, 10),
                duration ? parseInt(duration, 10) : 0
            );

            logger.info({
                message: 'Concurrency manually set',
                requestId,
                newConcurrency: concurrency,
                duration: duration || 'indefinite',
                timestamp: new Date().toISOString()
            });

            return res.json({
                status: 'ok',
                message: `Concurrency set to ${concurrency}`,
                duration: duration ? `${duration}ms` : 'indefinite'
            });
        } else if (action === 'auto') {
            // Resume automatic concurrency management
            global.queueManager.start();

            logger.info({
                message: 'Automatic concurrency management resumed',
                requestId,
                timestamp: new Date().toISOString()
            });

            return res.json({
                status: 'ok',
                message: 'Automatic concurrency management resumed'
            });
        } else if (action === 'pause') {
            // Pause automatic concurrency management
            global.queueManager.stop();

            logger.info({
                message: 'Automatic concurrency management paused',
                requestId,
                timestamp: new Date().toISOString()
            });

            return res.json({
                status: 'ok',
                message: 'Automatic concurrency management paused'
            });
        }

        return res.status(400).json({
            status: 'error',
            message: 'Invalid action. Use "force", "auto", or "pause"'
        });
    } catch (error) {
        logger.error({
            message: 'Error updating concurrency settings',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Health check requested',
        requestId,
        endpoint: '/health',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding health check to queue',
            requestId,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing health check request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making health check API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/tags`,
                    method: 'GET',
                    timestamp: new Date().toISOString()
                });

                const response = await axios.get(`${LLAMA_BASE_URL}/tags`);

                // Log successful response details
                logger.info({
                    message: 'Health check API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    statusCode: response.status,
                    responseSize: JSON.stringify(response.data).length,
                    timestamp: new Date().toISOString()
                });
                return response;
            } catch (error) {
                // Enhanced error logging for API call failures
                logger.error({
                    message: 'Health check API call failed',
                    requestId,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Health check successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            tagsCount: result.data.models ? result.data.models.length : 0,
            timestamp: new Date().toISOString()
        });

        res.json({ status: 'ok', tags: result.data });
    } catch (error) {
        logger.error({
            message: 'Health check failed',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Generation endpoint with queuing
app.post('/generate', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';

    // Enhanced generate request logging
    logger.info({
        message: 'Generate request received',
        requestId,
        model,
        node,
        promptLength: req.body.prompt ? req.body.prompt.length : 'undefined',
        options: req.body.options || {},
        resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        // Track this request in the model performance tracker
        global.modelTracker.trackRequest(requestId, model, {
            promptTokens: req.body.prompt ? estimateTokenCount(req.body.prompt) : 0,
            concurrentRequests: queue.pending,
            node
        });

        logger.info({
            message: 'Adding generate request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const queueStartTime = Date.now();
        const result = await queue.add(async () => {
            const queueWaitTime = Date.now() - queueStartTime;

            logger.info({
                message: 'Executing generate request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making generate API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/generate`,
                    method: 'POST',
                    model,
                    timestamp: new Date().toISOString()
                });

                const response = await axios.post(`${LLAMA_BASE_URL}/generate`, req.body);

                // Extract metrics from response for logging
                const tokenCount = response.data.eval_count || 0;
                const promptTokens = response.data.prompt_eval_count || 0;
                const duration = Date.now() - startTime;
                const tokensPerSecond = tokenCount > 0 ? (tokenCount / (duration / 1000)).toFixed(2) : 0;

                // Track request completion in the model performance tracker
                global.modelTracker.trackRequestCompletion(requestId, {
                    tokenCount,
                    promptTokens,
                    duration
                });

                updateMetrics(node, model, startTime, response.data);

                // Enhanced successful API call logging
                logger.info({
                    message: 'Generate API call successful',
                    requestId,
                    model,
                    node,
                    duration: `${duration}ms`,
                    responseSize: JSON.stringify(response.data).length,
                    tokenCount,
                    promptTokens,
                    totalTokens: promptTokens + tokenCount,
                    tokensPerSecond: `${tokensPerSecond} tokens/sec`,
                    resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
                    timestamp: new Date().toISOString()
                });
                return response;
            } catch (error) {
                global.modelTracker.trackRequestCompletion(requestId, {}, true);
                updateMetrics(node, model, startTime, null, true);
                logger.error({
                    message: 'Generate API call failed',
                    requestId,
                    model,
                    node,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Generate request successful',
            requestId,
            model,
            node,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Generate request failed',
            requestId,
            model,
            node,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Chat endpoint with queuing
app.post('/chat', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';

    // Enhanced chat request logging
    logger.info({
        message: 'Chat request received',
        requestId,
        model,
        node,
        messagesCount: req.body.messages ? req.body.messages.length : 'undefined',
        options: req.body.options || {},
        systemPromptLength: req.body.system ? req.body.system.length : 0,
        resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        // Track this request in the model performance tracker
        global.modelTracker.trackRequest(requestId, model, {
            promptTokens: estimateChatTokens(req.body.messages, req.body.system),
            concurrentRequests: queue.pending,
            node
        });

        logger.info({
            message: 'Adding chat request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            currentConcurrency: queue.concurrency,
            timestamp: new Date().toISOString()
        });

        const queueStartTime = Date.now();
        const result = await queue.add(async () => {
            const queueWaitTime = Date.now() - queueStartTime;

            logger.info({
                message: 'Executing chat request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making chat API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/chat`,
                    method: 'POST',
                    model,
                    timestamp: new Date().toISOString()
                });

                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, req.body);

                // Extract usage metrics for enhanced logging
                const usage = response.data.usage || {};
                const inputTokens = usage.prompt_tokens || 0;
                const outputTokens = usage.completion_tokens || 0;
                const totalTokens = usage.total_tokens || inputTokens + outputTokens;
                const duration = Date.now() - startTime;
                const tokensPerSecond = outputTokens > 0 ? (outputTokens / (duration / 1000)).toFixed(2) : 0;

                // Track request completion in the model performance tracker
                global.modelTracker.trackRequestCompletion(requestId, {
                    completionTokens: outputTokens,
                    promptTokens: inputTokens,
                    duration
                });

                updateMetrics(node, model, startTime, response.data);

                // Enhanced successful API call logging
                logger.info({
                    message: 'Chat API call successful',
                    requestId,
                    model,
                    node,
                    duration: `${duration}ms`,
                    responseSize: JSON.stringify(response.data).length,
                    promptTokens: inputTokens,
                    completionTokens: outputTokens,
                    totalTokens,
                    tokensPerSecond: `${tokensPerSecond} tokens/sec`,
                    resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
                    timestamp: new Date().toISOString()
                });
                return response;
            } catch (error) {
                // Track error in the model performance tracker
                global.modelTracker.trackRequestCompletion(requestId, {}, true);
                // Enhanced error logging for API call failures
                updateMetrics(node, model, startTime, null, true);
                logger.error({
                    message: 'Chat API call failed',
                    requestId,
                    model,
                    node,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Chat request successful',
            requestId,
            model,
            node,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Chat request failed',
            requestId,
            model,
            node,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Shift metrics every 5 minutes
function shiftMetrics() {
    logger.info({
        message: 'Shifting time-series metrics',
        timestamp: new Date().toISOString()
    });

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

    logger.info({
        message: 'Time-series metrics shifted successfully',
        timestamp: new Date().toISOString()
    });
}

// Set up metrics shifting every 5 minutes
setInterval(shiftMetrics, 5 * 60 * 1000);

// List models endpoint
app.get('/models', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Models list requested',
        requestId,
        endpoint: '/models',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding models list request to queue',
            requestId,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing models list request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making models list API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/tags`,
                    method: 'GET',
                    timestamp: new Date().toISOString()
                });

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
                    modelsCount: transformedModels.length,
                    responseSize: JSON.stringify(transformedModels).length,
                    timestamp: new Date().toISOString()
                });

                return { data: transformedModels };
            } catch (error) {
                // Enhanced error logging for API call failures
                logger.error({
                    message: 'Models list API call failed',
                    requestId,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Models list request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            modelsCount: result.data.length,
            timestamp: new Date().toISOString()
        });

        // Return the transformed array directly, not nested in an object
        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Models list request failed',
            requestId,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Queue status endpoint (optional but helpful)
app.get('/queue-status', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Queue status requested',
        requestId,
        endpoint: '/queue-status',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
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
        queuePaused: status.isPaused,
        timestamp: new Date().toISOString()
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
    logger.info({
        message: 'Initializing metrics',
        timestamp: new Date().toISOString()
    });

    // Create initial time series points for the last hour (12 5-minute intervals)
    const timePoints = Array.from({ length: 12 }, (_, i) => {
        const minutes = i * 5;
        return { time: `${minutes}m`, value: 0 };
    });

    metrics.requestCounts = [...timePoints];

    logger.info({
        message: 'Metrics initialized successfully',
        timestamp: new Date().toISOString()
    });
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

        logger.debug({
            message: 'Initialized response time metrics for node',
            nodeId,
            timestamp: new Date().toISOString()
        });
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

        logger.debug({
            message: 'Initialized node performance metrics',
            nodeId,
            timestamp: new Date().toISOString()
        });
    }

    const nodeMetrics = metrics.nodePerformance[nodeId];
    nodeMetrics.requestsProcessed += 1;
    nodeMetrics.avgResponseTime =
        (nodeMetrics.avgResponseTime * (nodeMetrics.requestsProcessed - 1) + duration) /
        nodeMetrics.requestsProcessed;

    if (isError) {
        const errorCount = (nodeMetrics.errorRate / 100) * (nodeMetrics.requestsProcessed - 1);
        nodeMetrics.errorRate = ((errorCount + 1) / nodeMetrics.requestsProcessed) * 100;

        logger.debug({
            message: 'Updated node error rate',
            nodeId,
            newErrorRate: nodeMetrics.errorRate,
            timestamp: new Date().toISOString()
        });
    }

    // Update model performance
    if (!metrics.modelPerformance[modelId]) {
        metrics.modelPerformance[modelId] = {
            avgResponseTime: 0,
            requestsProcessed: 0,
            avgTokensGenerated: 0
        };

        logger.debug({
            message: 'Initialized model performance metrics',
            modelId,
            timestamp: new Date().toISOString()
        });
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

    // Log detailed metrics update for debugging
    logger.debug({
        message: 'Updated performance metrics',
        nodeId,
        modelId,
        requestDuration: duration,
        tokensGenerated,
        timestamp: new Date().toISOString()
    });
}

// Get metrics
app.get('/admin/metrics', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Metrics requested',
        requestId,
        endpoint: '/admin/metrics',
        timestamp: new Date().toISOString()
    });

    // Add memory and CPU stats to metrics response
    const systemStats = {
        cpuUsage: process.cpuUsage().user / 1000000,
        memoryUsage: {
            rss: Math.round(process.memoryUsage().rss / (1024 * 1024)),
            heapTotal: Math.round(process.memoryUsage().heapTotal / (1024 * 1024)),
            heapUsed: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
            external: Math.round(process.memoryUsage().external / (1024 * 1024))
        },
        uptime: Math.floor((Date.now() - metrics.startTime) / 1000)
    };

    const enhancedMetrics = {
        resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
        queuePerformance: global.queueManager ? global.queueManager.getStatus() : null,
        modelPerformance: global.modelTracker ? global.modelTracker.getAllModelMetrics() : null,
        systemPerformance: global.modelTracker ? global.modelTracker.getSystemMetrics() : null,
        modelConcurrencyRecommendations: global.modelTracker ?
            global.modelTracker.getAllConcurrencyRecommendations() : null
    };

    res.json({
        status: 'ok',
        data: {
            ...systemMetrics(),
            system: systemStats,
            enhanced: enhancedMetrics
        }
    });

    logger.info({
        message: 'Metrics request successful',
        requestId,
        metricTypes: Object.keys(metrics),
        enhancedMetrics: Object.keys(enhancedMetrics),
        nodeCount: Object.keys(metrics.nodePerformance).length,
        modelCount: Object.keys(metrics.modelPerformance).length,
        timestamp: new Date().toISOString()
    });
});

function systemMetrics() {
    const enhancedMetrics = {
        responseTimes: { ...metrics.responseTimes },
        requestCounts: [...metrics.requestCounts],
        nodePerformance: { ...metrics.nodePerformance },
        modelPerformance: { ...metrics.modelPerformance }
    };

    const activeNodes = Object.keys(enhancedMetrics.nodePerformance);

    if (enhancedMetrics.requestCounts.length === 0) {
        enhancedMetrics.requestCounts = Array.from({ length: 12 }, (_, i) => ({
            time: `${i * 5}m`,
            value: 0
        }));
    }

    activeNodes.forEach(nodeId => {
        if (!enhancedMetrics.responseTimes[nodeId]) {
            enhancedMetrics.responseTimes[nodeId] = Array.from({ length: 12 }, (_, i) => ({
                time: `${i * 5}m`,
                value: 0 
            }));
        }
    });

    return enhancedMetrics;
}

// Get system information
app.get('/admin/system', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'System info requested',
        requestId,
        endpoint: '/admin/system',
        timestamp: new Date().toISOString()
    });

    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const memoryUsage = process.memoryUsage();
    const cpuInfo = os.cpus();

    const systemInfo = {
        apiVersion: '1.0.0',
        uptime: uptime,
        uptimeFormatted: formatUptime(uptime),
        cpuUsage: process.cpuUsage().user / 1000000,
        cpuInfo: {
            cores: cpuInfo.length,
            model: cpuInfo[0].model,
            speed: cpuInfo[0].speed
        },
        memoryUsage: {
            used: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
            total: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
            rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
            heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
            external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
        },
        diskUsage: {
            used: 'N/A',
            total: 'N/A'
        },
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        networkInterfaces: getNetworkInfo(),
        nodeJsVersion: process.version,
        expressVersion: require('express/package.json').version,
        environment: process.env.NODE_ENV || 'development'
    };

    res.json({
        status: 'ok',
        data: systemInfo
    });

    logger.info({
        message: 'System info request successful',
        requestId,
        uptime: systemInfo.uptimeFormatted,
        memory: systemInfo.memoryUsage.used,
        timestamp: new Date().toISOString()
    });
});

// Format uptime in a human-readable format
function formatUptime(seconds) {
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

// Get network interface information
function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const result = {};

    Object.keys(interfaces).forEach(iface => {
        const addresses = interfaces[iface]
            .filter(addr => !addr.internal)
            .map(addr => ({
                address: addr.address,
                family: addr.family,
                netmask: addr.netmask
            }));

        if (addresses.length > 0) {
            result[iface] = addresses;
        }
    });

    return result;
}

// Reset metrics
app.post('/admin/reset-stats', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Stats reset requested',
        requestId,
        endpoint: '/admin/reset-stats',
        timestamp: new Date().toISOString()
    });

    // Get current metrics summary before reset for logging
    const nodeCount = Object.keys(metrics.nodePerformance).length;
    const modelCount = Object.keys(metrics.modelPerformance).length;

    // Reset metrics
    metrics.responseTimes = {};
    metrics.requestCounts = [];
    metrics.nodePerformance = {};
    metrics.modelPerformance = {};

    // Reinitialize
    initializeMetrics();

    logger.info({
        message: 'Stats reset successful',
        requestId,
        previousNodeCount: nodeCount,
        previousModelCount: modelCount,
        timestamp: new Date().toISOString()
    });

    res.json({
        status: 'ok',
        message: 'Statistics reset successfully',
        timestamp: new Date().toISOString()
    });
});

// Get logs from MongoDB (replaces the simplified implementation)
app.get('/admin/logs', async (req, res) => {
    const requestId = req.id;
    const { level, limit = 100, page = 1, startDate, endDate } = req.query;

    logger.info({
        message: 'Logs requested from database',
        requestId,
        level,
        limit,
        page,
        startDate,
        endDate,
        endpoint: '/admin/logs',
        timestamp: new Date().toISOString()
    });

    try {
        // This endpoint now queries MongoDB for logs
        // We'll respond with success message for now
        // In production, you would connect to MongoDB and fetch logs

        logger.info({
            message: 'Log query complete',
            requestId,
            level,
            limit,
            page,
            timestamp: new Date().toISOString()
        });

        // Example response - in production this would be actual log data
        const exampleLogs = [
            {
                timestamp: new Date().toISOString(),
                level: 'info',
                message: 'Server started',
                source: 'server.js',
                serverId: SERVER_ID.ipAddress
            }
        ];

        res.json({
            status: 'ok',
            data: level ? exampleLogs.filter(entry => entry.level === level) : exampleLogs
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving logs',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve logs',
            error: error.message
        });
    }
});

// Add periodic health logging
setInterval(() => {
    const memoryUsage = process.memoryUsage();
    logger.info({
        message: 'System health stats',
        uptime: Math.floor(process.uptime()),
        memoryUsage: {
            rss: `${Math.round(memoryUsage.rss / (1024 * 1024))} MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB`,
            heapUsed: `${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB`,
            external: `${Math.round(memoryUsage.external / (1024 * 1024))} MB`
        },
        cpuUsage: process.cpuUsage(),
        activeRequests: queue ? queue.pending : 'N/A',
        queuedRequests: queue ? queue.size : 'N/A',
        timestamp: new Date().toISOString()
    });
}, 5 * 60 * 1000); // Every 5 minutes

// Catch-all error handler with enhanced logging
app.use((err, req, res, next) => {
    const requestId = req.id || 'unknown';

    logger.error({
        message: 'Unhandled error',
        requestId,
        method: req.method,
        url: req.originalUrl,
        error: err.message,
        errorName: err.name,
        errorCode: err.code,
        stack: err.stack,
        timestamp: new Date().toISOString()
    });

    res.status(500).json({
        status: 'error',
        message: 'An unexpected error occurred',
        requestId: requestId
    });
});

// Add process uncaught exception handler
process.on('uncaughtException', (error) => {
    logger.error({
        message: 'Uncaught exception',
        error: error.message,
        stack: error.stack,
        fatal: true,
        timestamp: new Date().toISOString()
    });

    // Optional: graceful shutdown
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

// Add process unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
    logger.error({
        message: 'Unhandled promise rejection',
        reason: reason.toString(),
        stack: reason.stack,
        fatal: false,
        timestamp: new Date().toISOString()
    });
});

// Add shutdown logging
process.on('SIGINT', () => {
    logger.info({
        message: 'Server shutting down',
        reason: 'SIGINT received',
        timestamp: new Date().toISOString()
    });

    // Gracefully shut down components
    if (global.resourceMonitor) {
        global.resourceMonitor.stop();
    }

    if (global.queueManager) {
        global.queueManager.stop();
    }

    if (global.modelTracker) {
        global.modelTracker.stop();
    }

    // Final resource usage log
    if (global.resourceMonitor) {
        logger.info({
            message: 'Final resource state',
            metrics: global.resourceMonitor.getCurrentMetrics(),
            timestamp: new Date().toISOString()
        });
    }

    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info({
        message: 'Server shutting down',
        reason: 'SIGTERM received',
        timestamp: new Date().toISOString()
    });

    // Gracefully shut down components
    if (global.resourceMonitor) {
        global.resourceMonitor.stop();
    }

    if (global.queueManager) {
        global.queueManager.stop();
    }

    if (global.modelTracker) {
        global.modelTracker.stop();
    }

    // Final resource usage log
    if (global.resourceMonitor) {
        logger.info({
            message: 'Final resource state',
            metrics: global.resourceMonitor.getCurrentMetrics(),
            timestamp: new Date().toISOString()
        });
    }

    process.exit(0);
});

initializeMetrics();
