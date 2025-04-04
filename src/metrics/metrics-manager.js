// src/metrics/metrics-manager.js
const logger = require('../logging/logger');
const os = require('os');

/**
 * Manages application metrics
 * Tracks response times, request counts, node and model performance
 */
class MetricsManager {
    /**
     * Creates a new MetricsManager instance
     * @param {Object} options - Configuration options
     */
    constructor(options = {}) {
        this.startTime = Date.now();
        this.metrics = {
            responseTimes: {},
            requestCounts: [],
            nodePerformance: {},
            modelPerformance: {}
        };

        // Periodic task intervals (in milliseconds)
        this.intervals = {
            shift: options.shiftInterval || 5 * 60 * 1000, // 5 minutes
            log: options.logInterval || 5 * 60 * 1000, // 5 minutes
        };

        // Time series points to keep (default: 12 points, each representing 5 minutes = 1 hour)
        this.timeSeriesPoints = options.timeSeriesPoints || 12;

        this.intervalHandles = {
            shift: null,
            log: null
        };

        // Initialize metrics
        this.initializeMetrics();

        logger.info({
            message: 'Metrics manager initialized',
            timeSeriesPoints: this.timeSeriesPoints,
            shiftInterval: `${this.intervals.shift / 60000} minutes`,
            logInterval: `${this.intervals.log / 60000} minutes`,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Initialize metrics data structures
     */
    initializeMetrics() {
        logger.info({
            message: 'Initializing metrics',
            timestamp: new Date().toISOString()
        });

        // Create initial time series points
        const timePoints = Array.from({ length: this.timeSeriesPoints }, (_, i) => {
            const minutes = i * (this.intervals.shift / 60000);
            return { time: `${minutes}m`, value: 0 };
        });

        this.metrics.requestCounts = [...timePoints];

        logger.info({
            message: 'Metrics initialized successfully',
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Start periodic tasks
     */
    startPeriodicTasks() {
        // Set up metrics shifting
        this.intervalHandles.shift = setInterval(() => this.shiftMetrics(), this.intervals.shift);

        // Set up periodic health logging
        this.intervalHandles.log = setInterval(() => this.logSystemHealth(), this.intervals.log);

        logger.info({
            message: 'Metrics periodic tasks started',
            shiftInterval: `${this.intervals.shift / 60000} minutes`,
            logInterval: `${this.intervals.log / 60000} minutes`,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Stop periodic tasks
     */
    stopPeriodicTasks() {
        // Clear intervals
        if (this.intervalHandles.shift) {
            clearInterval(this.intervalHandles.shift);
            this.intervalHandles.shift = null;
        }

        if (this.intervalHandles.log) {
            clearInterval(this.intervalHandles.log);
            this.intervalHandles.log = null;
        }

        logger.info({
            message: 'Metrics periodic tasks stopped',
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Shift time-series metrics
     * Removes oldest data point and adds a new one
     */
    shiftMetrics() {
        logger.info({
            message: 'Shifting time-series metrics',
            timestamp: new Date().toISOString()
        });

        // For response times
        Object.keys(this.metrics.responseTimes).forEach(nodeId => {
            // Remove oldest time point
            this.metrics.responseTimes[nodeId].shift();

            // Add new time point
            const latestTime = this.metrics.responseTimes[nodeId][this.metrics.responseTimes[nodeId].length - 1].time;
            const minutes = parseInt(latestTime) + (this.intervals.shift / 60000);
            this.metrics.responseTimes[nodeId].push({ time: `${minutes}m`, value: 0 });
        });

        // For request counts
        this.metrics.requestCounts.shift();
        const latestTime = this.metrics.requestCounts[this.metrics.requestCounts.length - 1].time;
        const minutes = parseInt(latestTime) + (this.intervals.shift / 60000);
        this.metrics.requestCounts.push({ time: `${minutes}m`, value: 0 });

        logger.info({
            message: 'Time-series metrics shifted successfully',
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Log system health periodically
     */
    logSystemHealth() {
        const memoryUsage = process.memoryUsage();
        const queueManager = global.queueManager; // Assumes queueManager is available globally

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
            activeRequests: queueManager ? queueManager.pending() : 'N/A',
            queuedRequests: queueManager ? queueManager.size() : 'N/A',
            models: Object.keys(this.metrics.modelPerformance).length,
            nodes: Object.keys(this.metrics.nodePerformance).length,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Update metrics after each Ollama API call
     * @param {string} nodeId - ID of the node processing the request
     * @param {string} modelId - ID of the model being used
     * @param {number} startTime - Request start timestamp
     * @param {Object} responseData - Response data from the API
     * @param {boolean} isError - Whether the request resulted in an error
     */
    updateMetrics(nodeId, modelId, startTime, responseData, isError = false) {
        const duration = Date.now() - startTime;

        // Update response times
        if (!this.metrics.responseTimes[nodeId]) {
            this.metrics.responseTimes[nodeId] = [];

            // Initialize with time points
            for (let i = 0; i < this.timeSeriesPoints; i++) {
                const minutes = i * (this.intervals.shift / 60000);
                this.metrics.responseTimes[nodeId].push({ time: `${minutes}m`, value: 0 });
            }

            logger.debug({
                message: 'Initialized response time metrics for node',
                nodeId,
                timestamp: new Date().toISOString()
            });
        }

        // Add current response time to the latest time point
        const latestTimePoint = this.metrics.responseTimes[nodeId].length - 1;
        const currentAvg = this.metrics.responseTimes[nodeId][latestTimePoint].value || 0;
        const count = this.metrics.nodePerformance[nodeId]?.requestsProcessed || 0;

        if (count > 0) {
            this.metrics.responseTimes[nodeId][latestTimePoint].value =
                (currentAvg * count + duration) / (count + 1);
        } else {
            this.metrics.responseTimes[nodeId][latestTimePoint].value = duration;
        }

        // Update request counts for the latest time point
        this.metrics.requestCounts[this.metrics.requestCounts.length - 1].value += 1;

        // Update node performance
        if (!this.metrics.nodePerformance[nodeId]) {
            this.metrics.nodePerformance[nodeId] = {
                avgResponseTime: 0,
                requestsProcessed: 0,
                errorRate: 0,
                lastRequest: new Date().toISOString()
            };

            logger.debug({
                message: 'Initialized node performance metrics',
                nodeId,
                timestamp: new Date().toISOString()
            });
        }

        const nodeMetrics = this.metrics.nodePerformance[nodeId];
        nodeMetrics.requestsProcessed += 1;
        nodeMetrics.lastRequest = new Date().toISOString();
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
        if (!this.metrics.modelPerformance[modelId]) {
            this.metrics.modelPerformance[modelId] = {
                avgResponseTime: 0,
                requestsProcessed: 0,
                avgTokensGenerated: 0,
                lastRequest: new Date().toISOString()
            };

            logger.debug({
                message: 'Initialized model performance metrics',
                modelId,
                timestamp: new Date().toISOString()
            });
        }

        const modelMetrics = this.metrics.modelPerformance[modelId];
        modelMetrics.requestsProcessed += 1;
        modelMetrics.lastRequest = new Date().toISOString();
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

        if (tokensGenerated > 0) {
            modelMetrics.avgTokensGenerated =
                (modelMetrics.avgTokensGenerated * (modelMetrics.requestsProcessed - 1) + tokensGenerated) /
                modelMetrics.requestsProcessed;

            // Calculate tokens per second
            modelMetrics.tokensPerSecond = tokensGenerated / (duration / 1000);
        }

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

    /**
     * Get current metrics
     * @returns {Object} Current metrics object
     */
    getMetrics() {
        // Return a copy of the metrics object
        return JSON.parse(JSON.stringify({
            responseTimes: { ...this.metrics.responseTimes },
            requestCounts: [...this.metrics.requestCounts],
            nodePerformance: { ...this.metrics.nodePerformance },
            modelPerformance: { ...this.metrics.modelPerformance },
            system: this.getSystemMetrics()
        }));
    }

    /**
     * Get current system metrics
     * @returns {Object} System metrics
     */
    getSystemMetrics() {
        const memoryUsage = process.memoryUsage();

        return {
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            uptimeFormatted: this.formatUptime(Math.floor((Date.now() - this.startTime) / 1000)),
            memory: {
                total: os.totalmem(),
                free: os.freemem(),
                used: memoryUsage.rss,
                heapTotal: memoryUsage.heapTotal,
                heapUsed: memoryUsage.heapUsed,
                external: memoryUsage.external
            },
            cpu: {
                cores: os.cpus().length,
                usage: process.cpuUsage(),
                loadAvg: os.loadavg()
            }
        };
    }

    /**
     * Reset all metrics
     */
    resetMetrics() {
        // Store old metrics for logging
        const oldMetrics = this.getMetrics();

        // Reset metrics
        this.metrics.responseTimes = {};
        this.metrics.nodePerformance = {};
        this.metrics.modelPerformance = {};

        // Reinitialize request counts
        this.metrics.requestCounts = Array.from({ length: this.timeSeriesPoints }, (_, i) => {
            const minutes = i * (this.intervals.shift / 60000);
            return { time: `${minutes}m`, value: 0 };
        });

        logger.info({
            message: 'Metrics reset',
            previousNodeCount: Object.keys(oldMetrics.nodePerformance).length,
            previousModelCount: Object.keys(oldMetrics.modelPerformance).length,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Get server start time
     * @returns {number} Server start timestamp
     */
    getStartTime() {
        return this.startTime;
    }

    /**
     * Format uptime in a human-readable format
     * @param {number} seconds - Uptime in seconds
     * @returns {string} Formatted uptime string
     */
    formatUptime(seconds) {
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        return `${days}d ${hours}h ${minutes}m ${secs}s`;
    }
}

/**
 * Initialize metrics manager
 * @param {Object} options - Configuration options
 * @returns {MetricsManager} Metrics manager instance
 */
function initMetricsManager(options = {}) {
    const metricsManager = new MetricsManager(options);
    return metricsManager;
}

module.exports = {
    initMetricsManager,
    MetricsManager
};