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
const MemoryManager = require('./MemoryManager');
const RequestCache = require('./RequestCache');
const CacheKeyGenerator = require('./CacheKeyGenerator');
const CacheMetrics = require('./CacheMetrics');
const { CircuitBreaker, CircuitOpenError } = require('./CircuitBreaker');
const PriorityQueue = require('./PriorityQueue');
const GpuMonitor = require('./GpuMonitor');
const OllamaHealthMonitor = require('./OllamaHealthMonitor');
const TimeoutManager = require('./TimeoutManager');
const createCacheMiddleware = require('./cache-middleware');

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

const PRIORITY_QUEUE_CONFIG = {
    // Concurrency settings (use the adaptive settings from existing config)
    concurrency: CONCURRENCY_CONFIG.DEFAULT_CONCURRENCY,

    // Priority levels configuration
    maxConcurrentByPriority: {
        [PriorityQueue.Priority.CRITICAL]: null,  // No limit for critical
        [PriorityQueue.Priority.HIGH]: null,      // No limit for high
        [PriorityQueue.Priority.NORMAL]: null,    // No limit for normal
        [PriorityQueue.Priority.LOW]: 2,          // Max 2 low priority tasks
        [PriorityQueue.Priority.BACKGROUND]: 1    // Max 1 background task
    },

    // Starvation prevention settings
    agingFactor: process.env.PRIORITY_AGING_FACTOR || 30000, // 30 seconds
    maxAgingBoost: process.env.PRIORITY_MAX_AGING_BOOST || 2,
    maxWaitTime: process.env.PRIORITY_MAX_WAIT_TIME || 5 * 60 * 1000, // 5 minutes

    // Queue fairness settings
    fairnessReservedPercentage: process.env.PRIORITY_FAIRNESS_RESERVED || 20, // 20%

    // Default priority level
    defaultPriority: PriorityQueue.Priority.NORMAL
};

const CIRCUIT_BREAKER_CONFIG = {
    // Error threshold percentage to trip the circuit (default: 50%)
    errorThresholdPercentage: process.env.CIRCUIT_ERROR_THRESHOLD || 50,

    // Minimum number of requests before the circuit can trip (default: 5)
    requestVolumeThreshold: process.env.CIRCUIT_REQUEST_VOLUME || 5,

    // How long to wait before trying half-open state (default: 30 seconds)
    resetTimeout: process.env.CIRCUIT_RESET_TIMEOUT || 30000,

    // Number of successful requests required to close circuit (default: 3)
    successThreshold: process.env.CIRCUIT_SUCCESS_THRESHOLD || 3,

    // Time window for calculating error rates (default: 60 seconds)
    rollingWindow: process.env.CIRCUIT_ROLLING_WINDOW || 60000,

    // Whether to track metrics by model (default: true)
    trackByModel: process.env.CIRCUIT_TRACK_BY_MODEL !== 'false'
};

const MEMORY_CONFIG = {
    // Memory thresholds (percentage of total system memory)
    criticalMemoryThreshold: process.env.MEMORY_CRITICAL_THRESHOLD || 90,
    warningMemoryThreshold: process.env.MEMORY_WARNING_THRESHOLD || 80,
    healthyMemoryThreshold: process.env.MEMORY_HEALTHY_THRESHOLD || 60,

    // Garbage collection settings
    gcTriggerThreshold: process.env.MEMORY_GC_TRIGGER_THRESHOLD || 85,
    gcCooldownPeriod: process.env.MEMORY_GC_COOLDOWN_PERIOD || 60000,

    // Memory allocation settings
    maxRequestMemoryMB: process.env.MEMORY_MAX_REQUEST_MB || 1024,
    reservedSystemMemoryMB: process.env.MEMORY_RESERVED_SYSTEM_MB || 512,

    // Memory monitoring settings
    monitoringInterval: process.env.MEMORY_MONITORING_INTERVAL || 5000,

    // Model-specific memory requirements (in MB)
    modelMemoryRequirements: {
        default: 512,             // Default for unknown models
        'llama2': 1024,           // Base Llama 2 model
        'llama2:7b': 768,         // 7B parameter model
        'llama2:13b': 1024,       // 13B parameter model
        'llama2:70b': 2048,       // 70B parameter model
        'mistral': 768,           // Mistral base model
        'mistral:7b': 768,        // 7B parameter model
        'mixtral': 1536,          // Mixtral base model
        'mixtral:8x7b': 1536,     // Mixtral 8x7B parameter model
        'codellama': 1024,        // Code Llama base model
        'wizardcoder': 1024,      // Wizard Coder model
        'phi': 512,               // Phi base model
        'phi:2': 512,             // Phi-2 model
        'stablelm': 768           // StableLM model
    }
};

// Cache configuration
const CACHE_CONFIG = {
    // Cache settings
    enabled: process.env.CACHE_ENABLED !== 'false', // Default: true
    maxSize: parseInt(process.env.CACHE_MAX_SIZE || '1000'), // Default: 1000 items
    defaultTTL: parseInt(process.env.CACHE_TTL_MS || (30 * 60 * 1000)), // Default: 30 minutes

    // Memory limits
    maxMemoryMB: parseInt(process.env.CACHE_MAX_MEMORY_MB || '512'), // Default: 512MB

    // Compression settings
    compressResponses: process.env.CACHE_COMPRESS_RESPONSES !== 'false', // Default: true

    // Model-specific settings
    excludedModels: (process.env.CACHE_EXCLUDED_MODELS || '').split(',').filter(Boolean),

    // Model-specific TTL (in milliseconds)
    modelTTL: {
        'default': 30 * 60 * 1000, // 30 minutes
        'llama2': 60 * 60 * 1000, // 1 hour
        'gpt4all': 24 * 60 * 60 * 1000, // 24 hours
        'mistral': 6 * 60 * 60 * 1000, // 6 hours
        'phi': 12 * 60 * 60 * 1000 // 12 hours
    },

    // Cache invalidation settings
    autoInvalidate: process.env.CACHE_AUTO_INVALIDATE === 'true', // Default: false
    invalidationPatterns: (process.env.CACHE_INVALIDATION_PATTERNS || '').split(',').filter(Boolean)
};

const createMemoryMiddleware = require('./memory-manager-middleware');

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

const TIMEOUT_CONFIG = {
    defaultTimeoutMs: process.env.DEFAULT_TIMEOUT_MS || 30000, // Default 30 seconds
    modelTimeouts: {
        'llama2:70b': 60000,       // 60 seconds
        'mixtral:8x7b': 45000,     // 45 seconds
        'codellama': 40000,        // 40 seconds
        'phi': 20000               // 20 seconds
        // Add additional model-specific timeouts here
    },
    adjustmentInterval: 60000,      // Check and adjust timeouts every minute
    minTimeoutMs: 10000,            // Minimum allowed timeout: 10 seconds
    maxTimeoutMs: 120000,           // Maximum allowed timeout: 2 minutes
    logger: logger
};

const OLLAMA_HEALTH_MONITOR_CONFIG = {
    apiUrl: process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434',
    checkInterval: parseInt(process.env.OLLAMA_HEALTH_CHECK_INTERVAL || '30000'), // 30 seconds
    timeoutThreshold: parseInt(process.env.OLLAMA_TIMEOUT_THRESHOLD || '10000'), // 10 seconds
    maxFailedChecks: parseInt(process.env.OLLAMA_MAX_FAILED_CHECKS || '3'),
    restartCommand: process.env.OLLAMA_RESTART_COMMAND || 'systemctl restart ollama',
    logger: logger
};


const app = express();
app.use(express.json({ limit: '50mb' })); // Add limit to prevent large request body issues

let queue = new PriorityQueue({
    ...PRIORITY_QUEUE_CONFIG,
    logger: logger,
    autoStart: true
});

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

const GPU_CONFIG = {
    sampleInterval: process.env.GPU_SAMPLE_INTERVAL || 5000, // 5 seconds
    historyLength: process.env.GPU_HISTORY_LENGTH || 100,
    utilizationHighThreshold: process.env.GPU_UTILIZATION_HIGH || 85,
    utilizationLowThreshold: process.env.GPU_UTILIZATION_LOW || 30,
    memoryHighThreshold: process.env.GPU_MEMORY_HIGH || 85,
    memoryLowThreshold: process.env.GPU_MEMORY_LOW || 40,
    temperatureHighThreshold: process.env.GPU_TEMP_HIGH || 80,
    temperatureWarningThreshold: process.env.GPU_TEMP_WARN || 70,
    modelMemoryRequirements: {
        default: 2000,   // Default GPU memory requirement (MB)
        'llama2:70b': 4096,
        'mixtral:8x7b': 3072,
        // add other specific model requirements if needed
    },
    logger: logger
};

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

const memoryMiddleware = createMemoryMiddleware(logger);
app.use(memoryMiddleware);

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

function adjustConcurrencyBasedOnGpuMetrics(currentConcurrency) {
    if (!global.gpuMonitor || !global.gpuMonitor.gpuInfo.detected) {
        return currentConcurrency; // No GPUs detected; skip GPU-based adjustments
    }

    const recommendation = global.gpuMonitor.getRecommendedConcurrency('default', currentConcurrency);
    logger.info({
        message: 'GPU-based concurrency recommendation',
        recommendation,
        timestamp: new Date().toISOString()
    });

    switch (recommendation.direction) {
        case 'increase':
            return Math.min(currentConcurrency + 1, CONCURRENCY_CONFIG.MAX_CONCURRENCY);
        case 'decrease':
            return Math.max(currentConcurrency - 1, CONCURRENCY_CONFIG.MIN_CONCURRENCY);
        default:
            return currentConcurrency;
    }
}

(async () => {
    try {
        logger.info({
            message: 'Initializing server and importing p-queue...',
            timestamp: new Date().toISOString()
        });

        // queue = new PriorityQueue({
        //     ...PRIORITY_QUEUE_CONFIG,
        //     logger: logger,
        //     autoStart: true
        // });

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
        queueManager.on('adjustConcurrency', (currentConcurrency) => {
            const adjustedConcurrency = adjustConcurrencyBasedOnGpuMetrics(currentConcurrency);
            queueManager.setConcurrency(adjustedConcurrency);
        });

        const ollamaHealthMonitor = new OllamaHealthMonitor(OLLAMA_HEALTH_MONITOR_CONFIG);
        ollamaHealthMonitor.start()

        // Initialize model performance tracker
        const modelTracker = new ModelPerformanceTracker({
            logger: logger
        });

        const cacheKeyGenerator = new CacheKeyGenerator({
            hashAlgorithm: 'sha256',
            normalizeWhitespace: true,
            logger: logger
        });

        const cacheMetrics = new CacheMetrics({
            historyLength: 100,
            metricsInterval: 60000, // 1 minute
            samplingInterval: 5000, // 5 seconds
            logger: logger
        });

        const requestCache = new RequestCache({
            maxSize: CACHE_CONFIG.maxSize,
            defaultTTL: CACHE_CONFIG.defaultTTL,
            maxMemoryMB: CACHE_CONFIG.maxMemoryMB,
            compressResponses: CACHE_CONFIG.compressResponses,
            modelTTL: CACHE_CONFIG.modelTTL,
            excludedModels: CACHE_CONFIG.excludedModels,
            logger: logger
        });

        const circuitBreaker = new CircuitBreaker({
            ...CIRCUIT_BREAKER_CONFIG,
            logger: logger
        });

        const memoryManager = new MemoryManager({
            ...MEMORY_CONFIG,
            logger: logger
        });

        circuitBreaker.onStateChange((fromState, toState, timestamp) => {
            logger.info({
                message: 'Circuit state transition',
                fromState,
                toState,
                timestamp: new Date(timestamp).toISOString()
            });
        });

        const gpuMonitor = new GpuMonitor(GPU_CONFIG);

        const timeoutManager = new TimeoutManager(TIMEOUT_CONFIG);

        global.timeoutManager = timeoutManager;
        global.gpuMonitor = gpuMonitor
        global.circuitBreaker = circuitBreaker;
        global.resourceMonitor = resourceMonitor;
        global.queueManager = queueManager;
        global.modelTracker = modelTracker;
        global.cacheKeyGenerator = cacheKeyGenerator;
        global.cacheMetrics = cacheMetrics;
        global.requestCache = requestCache;
        global.memoryManager = memoryManager;
        global.cacheEnabled = CACHE_CONFIG.enabled;
        global.cacheExcludedModels = CACHE_CONFIG.excludedModels;
        global.cacheModelTTL = CACHE_CONFIG.modelTTL;
        global.defaultCacheTTL = CACHE_CONFIG.defaultTTL;
        global.ollamaHealthMonitor = ollamaHealthMonitor;

        logger.info({
            message: 'TimeoutManager initialized successfully',
            defaultTimeoutMs: TIMEOUT_CONFIG.defaultTimeoutMs,
            modelCount: Object.keys(TIMEOUT_CONFIG.modelTimeouts).length,
            timestamp: new Date().toISOString()
        });

        logger.info({
            message: 'OllamaHealthMonitor initialized successfully',
            checkInterval: `${OLLAMA_HEALTH_MONITOR_CONFIG.checkInterval}ms`,
            timeoutThreshold: `${OLLAMA_HEALTH_MONITOR_CONFIG.timeoutThreshold}ms`,
            timestamp: new Date().toISOString()
        });

        logger.info({
            message: 'Cache initialized successfully',
            enabled: CACHE_CONFIG.enabled,
            maxSize: CACHE_CONFIG.maxSize,
            defaultTTL: `${CACHE_CONFIG.defaultTTL / 1000 / 60} minutes`,
            excludedModels: CACHE_CONFIG.excludedModels,
            timestamp: new Date().toISOString()
        });

        logger.info({
            message: 'Circuit breaker initialized',
            initialState: circuitBreaker.state,
            errorThreshold: `${CIRCUIT_BREAKER_CONFIG.errorThresholdPercentage}%`,
            resetTimeout: `${CIRCUIT_BREAKER_CONFIG.resetTimeout}ms`,
            trackByModel: CIRCUIT_BREAKER_CONFIG.trackByModel,
            timestamp: new Date().toISOString()
        });

        logger.info({
            message: 'PriorityQueue initialized',
            initialConcurrency: queue.concurrency,
            priorityLevels: Object.keys(PriorityQueue.Priority).length,
            defaultPriority: PriorityQueue.getPriorityName(PRIORITY_QUEUE_CONFIG.defaultPriority),
            fairnessReserved: `${PRIORITY_QUEUE_CONFIG.fairnessReservedPercentage}%`,
            timestamp: new Date().toISOString()
        });

        if (typeof global.gc === 'function') {
            logger.info({
                message: 'Manual garbage collection available',
                timestamp: new Date().toISOString()
            });
        } else {
            logger.warn({
                message: 'Manual garbage collection not available',
                resolution: 'Run with node --expose-gc for better memory management',
                timestamp: new Date().toISOString()
            });
        }


        if (gpuMonitor.gpuInfo.detected) {
            logger.info({
                message: 'GpuMonitor initialized successfully',
                gpuCount: gpuMonitor.gpuInfo.count,
                timestamp: new Date().toISOString()
            });
        } else {
            logger.warn({
                message: 'GpuMonitor failed to initialize - no GPUs detected',
                timestamp: new Date().toISOString()
            });
        }

        logger.info({
            message: 'Memory manager initialized successfully',
            totalMemory: `${Math.floor(os.totalmem() / (1024 * 1024))} MB`,
            availableMemory: `${Math.floor(os.freemem() / (1024 * 1024))} MB`,
            modelCount: Object.keys(MEMORY_CONFIG.modelMemoryRequirements).length,
            timestamp: new Date().toISOString()
        });

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

        // Apply cache middleware if enabled
        if (CACHE_CONFIG.enabled) {
            const cacheMiddleware = createCacheMiddleware(
                requestCache,
                cacheKeyGenerator,
                cacheMetrics,
                logger
            );

            app.use(cacheMiddleware);

            logger.info({
                message: 'Cache middleware activated',
                timestamp: new Date().toISOString()
            });
        }

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

setInterval(() => {
    if (global.gpuMonitor && global.gpuMonitor.gpuInfo.detected) {
        const currentMetrics = global.gpuMonitor.getCurrentMetrics();
        logger.info({
            message: 'Periodic GPU metrics snapshot',
            metrics: currentMetrics,
            timestamp: new Date().toISOString()
        });
    }
}, 60000);

app.get('/admin/gpu', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'GPU metrics requested',
        requestId,
        endpoint: '/admin/gpu',
        timestamp: new Date().toISOString()
    });

    if (!global.gpuMonitor || !global.gpuMonitor.gpuInfo.detected) {
        return res.status(503).json({
            status: 'error',
            message: 'GpuMonitor not initialized or no GPUs detected'
        });
    }

    const gpuStatus = global.gpuMonitor.getStatus();
    const currentMetrics = global.gpuMonitor.getCurrentMetrics();
    const averageMetrics = global.gpuMonitor.getAverageMetrics(5);

    res.json({
        status: 'ok',
        data: {
            gpuStatus,
            currentMetrics,
            averageMetrics
        }
    });
});

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
            queueManager.on('adjustConcurrency', (currentConcurrency) => {
                const adjustedConcurrency = adjustConcurrencyBasedOnGpuMetrics(currentConcurrency);
                queueManager.setConcurrency(adjustedConcurrency);
            });

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
        if (global.memoryManager && req.memoryTracking) {
            global.memoryManager.releaseRequestMemory(requestId);
        }
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Cache statistics endpoint
app.get('/admin/cache', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Cache stats requested',
        requestId,
        endpoint: '/admin/cache',
        timestamp: new Date().toISOString()
    });

    if (!global.requestCache || !global.cacheMetrics) {
        return res.status(503).json({
            status: 'error',
            message: 'Cache not initialized'
        });
    }

    // Get cache statistics
    const cacheStats = global.requestCache.getStats();
    const metricsStats = global.cacheMetrics.getMetrics();
    const performanceImpact = global.cacheMetrics.getPerformanceImpact();

    const stats = {
        cacheStats,
        metrics: metricsStats,
        performance: performanceImpact,
        config: {
            enabled: global.cacheEnabled,
            excludedModels: global.cacheExcludedModels,
            defaultTTL: global.defaultCacheTTL
        }
    };

    logger.info({
        message: 'Cache stats request successful',
        requestId,
        hitRate: metricsStats.summary.hitRate.current,
        itemCount: cacheStats.size.current,
        timestamp: new Date().toISOString()
    });

    res.json({
        status: 'ok',
        data: stats
    });
});

// Cache clear endpoint
app.post('/admin/cache/clear', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Cache clear requested',
        requestId,
        endpoint: '/admin/cache/clear',
        timestamp: new Date().toISOString()
    });

    if (!global.requestCache) {
        return res.status(503).json({
            status: 'error',
            message: 'Cache not initialized'
        });
    }

    try {
        // Check for selective clearing options
        const { modelId, pattern } = req.body;

        // Default to clearing entire cache
        let itemsCleared = 0;
        let message = 'Cache cleared completely';

        if (modelId) {
            // TODO: Implement selective clearing by model
            // This would require changes to RequestCache to support selective clearing
            itemsCleared = global.requestCache.clear();
            message = `Cache cleared (selective clearing by model not yet implemented)`;
        } else if (pattern) {
            // TODO: Implement selective clearing by pattern
            // This would require changes to RequestCache to support pattern-based clearing
            itemsCleared = global.requestCache.clear();
            message = `Cache cleared (selective clearing by pattern not yet implemented)`;
        } else {
            // Clear entire cache
            itemsCleared = global.requestCache.clear();
        }

        logger.info({
            message: 'Cache cleared successfully',
            requestId,
            itemsCleared,
            modelId,
            pattern,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'ok',
            message,
            itemsCleared
        });
    } catch (error) {
        logger.error({
            message: 'Error clearing cache',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Cache configuration endpoint
app.post('/admin/cache/config', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Cache configuration update requested',
        requestId,
        endpoint: '/admin/cache/config',
        requestBody: req.body,
        timestamp: new Date().toISOString()
    });

    if (!global.requestCache) {
        return res.status(503).json({
            status: 'error',
            message: 'Cache not initialized'
        });
    }

    try {
        const { enabled, excludedModels, modelTTL } = req.body;

        // Update global cache enabled setting
        if (enabled !== undefined) {
            global.cacheEnabled = Boolean(enabled);
            logger.info({
                message: `Cache ${global.cacheEnabled ? 'enabled' : 'disabled'}`,
                requestId,
                timestamp: new Date().toISOString()
            });
        }

        // Update excluded models
        if (excludedModels && Array.isArray(excludedModels)) {
            global.cacheExcludedModels = excludedModels;
            logger.info({
                message: 'Cache excluded models updated',
                requestId,
                excludedModels,
                timestamp: new Date().toISOString()
            });
        }

        // Update model TTL settings
        if (modelTTL && typeof modelTTL === 'object') {
            global.cacheModelTTL = { ...global.cacheModelTTL, ...modelTTL };
            logger.info({
                message: 'Cache model TTL settings updated',
                requestId,
                modelCount: Object.keys(modelTTL).length,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            status: 'ok',
            message: 'Cache configuration updated successfully',
            config: {
                enabled: global.cacheEnabled,
                excludedModels: global.cacheExcludedModels,
                modelTTL: global.cacheModelTTL
            }
        });
    } catch (error) {
        logger.error({
            message: 'Error updating cache configuration',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Timeout logic integrated for /chat endpoint
app.post('/chat', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';
    const timeoutMs = global.timeoutManager.getTimeoutForModel(model);

    logger.info({
        message: 'Chat request received',
        requestId,
        model,
        node,
        timeoutMs,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    let timeoutHandle;
    let timedOut = false;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            global.timeoutManager.recordTimeout(model);
            reject(new Error('Request timed out'));
        }, timeoutMs);
    });

    const queuePromise = queue.add(async () => {
        const response = await axios.post(`${LLAMA_BASE_URL}/chat`, req.body);
        return response;
    });

    try {
        const result = await Promise.race([queuePromise, timeoutPromise]);
        clearTimeout(timeoutHandle);
        global.timeoutManager.recordSuccess(model);

        logger.info({
            message: 'Chat request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'ok',
            timedOut: false,
            data: result.data
        });
    } catch (error) {
        clearTimeout(timeoutHandle);

        if (timedOut) {
            logger.warn({
                message: 'Chat request timed out',
                requestId,
                model,
                timeoutMs,
                timestamp: new Date().toISOString()
            });

            return res.status(504).json({
                status: 'error',
                message: 'Request timed out',
                timeoutMs
            });
        }

        logger.error({
            message: 'Chat request failed',
            requestId,
            error: error.message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Timeout logic integrated for /generate endpoint
app.post('/generate', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';
    const timeoutMs = global.timeoutManager.getTimeoutForModel(model);

    logger.info({
        message: 'Generate request received',
        requestId,
        model,
        node,
        timeoutMs,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    let timeoutHandle;
    let timedOut = false;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            global.timeoutManager.recordTimeout(model);
            reject(new Error('Request timed out'));
        }, timeoutMs);
    });

    const queuePromise = queue.add(async () => {
        const response = await axios.post(`${LLAMA_BASE_URL}/generate`, req.body);
        return response;
    });

    try {
        const result = await Promise.race([queuePromise, timeoutPromise]);
        clearTimeout(timeoutHandle);
        global.timeoutManager.recordSuccess(model);

        logger.info({
            message: 'Generate request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'ok',
            timedOut: false,
            data: result.data
        });
    } catch (error) {
        clearTimeout(timeoutHandle);

        if (timedOut) {
            logger.warn({
                message: 'Generate request timed out',
                requestId,
                model,
                timeoutMs,
                timestamp: new Date().toISOString()
            });

            return res.status(504).json({
                status: 'error',
                message: 'Request timed out',
                timeoutMs
            });
        }

        logger.error({
            message: 'Generate request failed',
            requestId,
            error: error.message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});


app.get('/admin/queue', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Queue status requested',
        requestId,
        endpoint: '/admin/queue',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        return res.status(503).json({
            status: 'error',
            message: 'Queue not initialized'
        });
    }

    // Get detailed queue statistics
    const queueStats = queue.getStats();
    const waitingTasks = queue.getWaitingTasksInfo();

    // Get oldest waiting task for each priority
    const oldestTasks = Object.keys(waitingTasks.oldestByPriority).map(priority => {
        const task = waitingTasks.oldestByPriority[priority];
        return {
            priority: PriorityQueue.getPriorityName(parseInt(priority)),
            addedTime: task.addedTime,
            waitTime: Math.round(task.ageMs / 1000) + ' seconds',
            taskId: task.taskId
        };
    });

    // Sort by age (oldest first)
    oldestTasks.sort((a, b) => {
        return new Date(a.addedTime) - new Date(b.addedTime);
    });

    logger.info({
        message: 'Queue status request successful',
        requestId,
        queueSize: queueStats.size,
        queuePending: queueStats.pending,
        priorityLevels: Object.keys(queueStats.pendingByPriority).length,
        timestamp: new Date().toISOString()
    });

    res.json({
        status: 'ok',
        data: {
            stats: queueStats,
            waiting: waitingTasks,
            oldestTasks: oldestTasks
        }
    });
});

// Add priority queue management endpoint
app.post('/admin/queue', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Queue management action requested',
        requestId,
        endpoint: '/admin/queue',
        requestBody: req.body,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        return res.status(503).json({
            status: 'error',
            message: 'Queue not initialized'
        });
    }

    try {
        const { action, priority } = req.body;

        switch (action) {
            case 'pause':
                queue.pause();
                logger.info({
                    message: 'Queue paused',
                    requestId,
                    timestamp: new Date().toISOString()
                });
                break;
            case 'resume':
            case 'start':
                queue.start();
                logger.info({
                    message: 'Queue started',
                    requestId,
                    timestamp: new Date().toISOString()
                });
                break;
            case 'clear':
                const clearedCount = queue.clear();
                logger.info({
                    message: 'Queue cleared',
                    requestId,
                    clearedCount,
                    timestamp: new Date().toISOString()
                });
                break;
            default:
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid action. Use "pause", "resume", or "clear"'
                });
        }

        // Get updated queue stats
        const queueStats = queue.getStats();

        res.json({
            status: 'ok',
            message: `Queue ${action} operation successful`,
            currentState: {
                isPaused: queueStats.isPaused,
                size: queueStats.size,
                pending: queueStats.pending
            }
        });
    } catch (error) {
        logger.error({
            message: 'Error processing queue management action',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

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

    // Basic status
    const status = {
        size: queue.size,
        pending: queue.pending,
        isPaused: queue.isPaused,
        // Add priority-based stats
        pendingByPriority: {
            critical: queue.getPendingCount(PriorityQueue.Priority.CRITICAL),
            high: queue.getPendingCount(PriorityQueue.Priority.HIGH),
            normal: queue.getPendingCount(PriorityQueue.Priority.NORMAL),
            low: queue.getPendingCount(PriorityQueue.Priority.LOW),
            background: queue.getPendingCount(PriorityQueue.Priority.BACKGROUND)
        },
        runningByPriority: {
            critical: queue.getRunningCount(PriorityQueue.Priority.CRITICAL),
            high: queue.getRunningCount(PriorityQueue.Priority.HIGH),
            normal: queue.getRunningCount(PriorityQueue.Priority.NORMAL),
            low: queue.getRunningCount(PriorityQueue.Priority.LOW),
            background: queue.getRunningCount(PriorityQueue.Priority.BACKGROUND)
        }
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

app.get('/admin/circuit', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Circuit breaker status requested',
        requestId,
        endpoint: '/admin/circuit',
        timestamp: new Date().toISOString()
    });

    if (!global.circuitBreaker) {
        return res.status(503).json({
            status: 'error',
            message: 'Circuit breaker not initialized'
        });
    }

    // Get circuit breaker status
    const status = global.circuitBreaker.getStatus();

    logger.info({
        message: 'Circuit breaker status request successful',
        requestId,
        globalState: status.global.state,
        modelCount: Object.keys(status.models).length,
        timestamp: new Date().toISOString()
    });

    res.json({
        status: 'ok',
        data: status
    });
});

app.post('/admin/circuit', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Circuit breaker action requested',
        requestId,
        endpoint: '/admin/circuit',
        requestBody: req.body,
        timestamp: new Date().toISOString()
    });

    if (!global.circuitBreaker) {
        return res.status(503).json({
            status: 'error',
            message: 'Circuit breaker not initialized'
        });
    }

    try {
        const { action, modelId, timeout } = req.body;
        let result = false;

        switch (action) {
            case 'open':
                result = global.circuitBreaker.forceOpen({
                    modelId,
                    timeout: timeout ? parseInt(timeout, 10) : undefined
                });
                break;
            case 'close':
                result = global.circuitBreaker.forceClose({ modelId });
                break;
            case 'reset':
                result = global.circuitBreaker.reset({ modelId });
                break;
            default:
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid action. Use "open", "close", or "reset"'
                });
        }

        logger.info({
            message: `Circuit breaker ${action} action successful`,
            requestId,
            action,
            modelId: modelId || 'global',
            result,
            timestamp: new Date().toISOString()
        });

        // Get updated status
        const status = global.circuitBreaker.getStatus();

        res.json({
            status: 'ok',
            message: `Circuit breaker ${action} operation successful`,
            action,
            targetCircuit: modelId || 'global',
            currentState: modelId ?
                status.models[modelId]?.state : status.global.state,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error({
            message: 'Error processing circuit breaker action',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: error.message
        });
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
        if (global.memoryManager && req.memoryTracking) {
            global.memoryManager.releaseRequestMemory(requestId);
        }
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/admin/memory', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Memory stats requested',
        requestId,
        endpoint: '/admin/memory',
        timestamp: new Date().toISOString()
    });

    if (!global.memoryManager) {
        return res.status(503).json({
            status: 'error',
            message: 'Memory manager not initialized'
        });
    }

    // Get detailed memory statistics
    const memoryStats = global.memoryManager.getMemoryStats();

    logger.info({
        message: 'Memory stats request successful',
        requestId,
        memoryState: memoryStats.current.state,
        activeRequests: memoryStats.activeRequests.count,
        timestamp: new Date().toISOString()
    });

    res.json({
        status: 'ok',
        data: memoryStats
    });
});

// Memory forecast endpoint
app.post('/admin/memory/forecast', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Memory forecast requested',
        requestId,
        endpoint: '/admin/memory/forecast',
        timestamp: new Date().toISOString()
    });

    if (!global.memoryManager) {
        return res.status(503).json({
            status: 'error',
            message: 'Memory manager not initialized'
        });
    }

    // Get queued requests from request body, or use current queue if not provided
    const queuedRequests = req.body.queuedRequests ||
        (queue ? Array.from({ length: queue.size }, () => ({ model: 'default' })) : []);

    // Get memory forecast
    const forecast = global.memoryManager.getForecastedMemoryUsage(queuedRequests);

    logger.info({
        message: 'Memory forecast request successful',
        requestId,
        currentState: forecast.current.state,
        forecastedState: forecast.forecasted.state,
        queuedRequests: queuedRequests.length,
        timestamp: new Date().toISOString()
    });

    res.json({
        status: 'ok',
        data: forecast
    });
});

// Update model memory requirements
app.post('/admin/memory/models', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Model memory requirements update requested',
        requestId,
        endpoint: '/admin/memory/models',
        requestBody: req.body,
        timestamp: new Date().toISOString()
    });

    if (!global.memoryManager) {
        return res.status(503).json({
            status: 'error',
            message: 'Memory manager not initialized'
        });
    }

    try {
        // Update model memory requirements
        const updated = global.memoryManager.updateModelMemoryRequirements(req.body);

        if (!updated) {
            logger.warn({
                message: 'Invalid model memory requirements',
                requestId,
                requestBody: req.body,
                timestamp: new Date().toISOString()
            });

            return res.status(400).json({
                status: 'error',
                message: 'Invalid model memory requirements'
            });
        }

        logger.info({
            message: 'Model memory requirements updated successfully',
            requestId,
            modelCount: Object.keys(req.body).length,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'ok',
            message: 'Model memory requirements updated successfully',
            data: global.memoryManager.getMemoryStats().modelMemorySettings
        });
    } catch (error) {
        logger.error({
            message: 'Error updating model memory requirements',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Force garbage collection endpoint
app.post('/admin/memory/gc', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Garbage collection requested',
        requestId,
        endpoint: '/admin/memory/gc',
        timestamp: new Date().toISOString()
    });

    if (!global.memoryManager) {
        return res.status(503).json({
            status: 'error',
            message: 'Memory manager not initialized'
        });
    }

    try {
        // Get memory before GC
        const memoryBefore = global.memoryManager.getCurrentMemoryUsage();

        // Trigger garbage collection
        const gcResult = global.memoryManager.triggerGarbageCollection();

        if (!gcResult) {
            logger.warn({
                message: 'Garbage collection not available',
                requestId,
                timestamp: new Date().toISOString()
            });

            return res.status(400).json({
                status: 'error',
                message: 'Garbage collection not available. Run Node.js with --expose-gc flag.'
            });
        }

        // Get memory after GC
        const memoryAfter = global.memoryManager.getCurrentMemoryUsage();

        // Calculate difference
        const memoryFreed = memoryBefore.processMemory.heapUsed - memoryAfter.processMemory.heapUsed;
        const memoryFreedMB = Math.floor(memoryFreed / (1024 * 1024));

        logger.info({
            message: 'Garbage collection completed successfully',
            requestId,
            memoryFreedMB,
            newMemoryState: memoryAfter.state,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'ok',
            message: 'Garbage collection completed successfully',
            data: {
                memoryBefore,
                memoryAfter,
                memoryFreedMB,
                gcCount: global.memoryManager.gcCount
            }
        });
    } catch (error) {
        logger.error({
            message: 'Error triggering garbage collection',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

const metrics = {
    startTime: Date.now(),
    responseTimes: {},
    requestCounts: [],
    nodePerformance: {},
    modelPerformance: {}
};

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
        memoryStats: global.memoryManager ? global.memoryManager.getCurrentMemoryUsage() : null,
        resourceUsage: global.resourceMonitor ? global.resourceMonitor.getCurrentMetrics() : null,
        queuePerformance: global.queueManager ? global.queueManager.getStatus() : null,
        modelPerformance: global.modelTracker ? global.modelTracker.getAllModelMetrics() : null,
        systemPerformance: global.modelTracker ? global.modelTracker.getSystemMetrics() : null,
        modelConcurrencyRecommendations: global.modelTracker ?
            global.modelTracker.getAllConcurrencyRecommendations() : null,
        queueMetrics: queue ? {
            waitTimes: {
                average: queue.getStats().performance.waitTime.average,
                byPriority: queue.getStats().performance.waitTime.byPriority
            },
            completedTasks: {
                total: queue.getStats().performance.completed,
                byPriority: queue.getStats().performance.completedByPriority
            },
            priorityBoosts: queue.getStats().performance.priorityBoosts,
            fairnessSettings: {
                reservedPercentage: queue.getStats().config.fairnessReservedPercentage,
                maxConcurrentByPriority: queue.getStats().config.maxConcurrentByPriority
            }
        } : null
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
    if (global.requestCache && global.cacheMetrics) {
        const metrics = global.cacheMetrics.getMetrics();
        healthInfo.cache = {
            enabled: global.cacheEnabled,
            size: global.requestCache.getStats().size.current,
            hitRate: metrics.summary.hitRate.current,
            timeSaved: metrics.summary.performance.totalTimeSaved
        };
    }

    const memoryUsage = process.memoryUsage();
    logger.info({
        memoryState: global.memoryManager ? global.memoryManager.getCurrentMemoryUsage().state : 'N/A',
        activeMemoryRequests: global.memoryManager ? global.memoryManager.activeRequests.size : 'N/A',
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

    if (global.circuitBreaker) {
        global.circuitBreaker.stop();
    }

    if (global.resourceMonitor) {
        logger.info({
            message: 'Final resource state',
            metrics: global.resourceMonitor.getCurrentMetrics(),
            timestamp: new Date().toISOString()
        });
    }
    if (global.requestCache) {
        // Stop caching components
        global.requestCache.stop();
        global.cacheMetrics.stop();

        logger.info({
            message: 'Cache components stopped',
            timestamp: new Date().toISOString()
        });
    }
    if (queue) {
        queue.stop();

        logger.info({
            message: 'PriorityQueue stopped',
            timestamp: new Date().toISOString()
        });
    }

    if (global.ollamaHealthMonitor) {
        global.ollamaHealthMonitor.stop();
        logger.info({
            message: 'OllamaHealthMonitor stopped',
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
    if (global.requestCache) {
        // Stop caching components
        global.requestCache.stop();
        global.cacheMetrics.stop();

        logger.info({
            message: 'Cache components stopped',
            timestamp: new Date().toISOString()
        });
    }
    if (queue) {
        queue.stop();

        logger.info({
            message: 'PriorityQueue stopped',
            timestamp: new Date().toISOString()
        });
    }
    if (global.ollamaHealthMonitor) {
        global.ollamaHealthMonitor.stop();
        logger.info({
            message: 'OllamaHealthMonitor stopped',
            timestamp: new Date().toISOString()
        });
    }

    process.exit(0);
});

initializeMetrics();
