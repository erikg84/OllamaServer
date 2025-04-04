// src/models/metrics.model.js

/**
 * Models for metrics data structures
 * Defines standard formats for metrics data
 */

/**
 * Create a new time series point
 * @param {string} time - Time label (e.g., "5m")
 * @param {number} value - Metric value
 * @returns {Object} Time series data point
 */
function createTimeSeriesPoint(time, value = 0) {
    return {
        time,
        value
    };
}

/**
 * Create a new time series array with initial values
 * @param {number} count - Number of time points
 * @param {number} minutesInterval - Minutes between each point
 * @returns {Array} Array of time series points
 */
function createTimeSeries(count, minutesInterval = 5) {
    return Array.from({ length: count }, (_, i) => {
        const minutes = i * minutesInterval;
        return createTimeSeriesPoint(`${minutes}m`, 0);
    });
}

/**
 * Create new node performance metrics object
 * @returns {Object} Node performance metrics
 */
function createNodePerformanceMetrics() {
    return {
        avgResponseTime: 0,
        requestsProcessed: 0,
        errorRate: 0,
        lastRequest: new Date().toISOString(),
        cpuUsage: 0,
        memoryUsage: 0,
        concurrentRequests: 0,
        maxConcurrentRequests: 0
    };
}

/**
 * Create new model performance metrics object
 * @returns {Object} Model performance metrics
 */
function createModelPerformanceMetrics() {
    return {
        avgResponseTime: 0,
        requestsProcessed: 0,
        avgTokensGenerated: 0,
        tokensPerSecond: 0,
        lastRequest: new Date().toISOString(),
        errorRate: 0,
        timeoutRate: 0,
        usageByEndpoint: {
            generate: 0,
            chat: 0
        }
    };
}

/**
 * Create new system metrics object
 * @returns {Object} System metrics
 */
function createSystemMetrics() {
    return {
        cpuUsage: 0,
        memoryUsage: {
            total: 0,
            free: 0,
            used: 0,
            heapTotal: 0,
            heapUsed: 0,
            external: 0
        },
        uptime: 0,
        requestsTotal: 0,
        requestsPerMinute: 0,
        errorsTotal: 0,
        errorRate: 0
    };
}

/**
 * Create new agent collaboration metrics
 * For MAESTRO system to track agent interactions
 * @returns {Object} Agent collaboration metrics
 */
function createAgentCollaborationMetrics() {
    return {
        collaborationCount: 0,
        avgCollaborationTime: 0,
        agentInteractions: 0,
        interactionsPerCollaboration: 0,
        successRate: 0,
        workflows: {
            sequential: {
                count: 0,
                avgTime: 0,
                successRate: 0
            },
            parallel: {
                count: 0,
                avgTime: 0,
                successRate: 0
            },
            debate: {
                count: 0,
                avgTime: 0,
                successRate: 0
            }
        },
        agentRoleCounts: {}
    };
}

/**
 * Create new complete metrics object
 * @param {number} timeSeriesPoints - Number of time series points to create
 * @returns {Object} Complete metrics object
 */
function createMetrics(timeSeriesPoints = 12) {
    return {
        startTime: Date.now(),
        responseTimes: {},
        requestCounts: createTimeSeries(timeSeriesPoints),
        nodePerformance: {},
        modelPerformance: {},
        system: createSystemMetrics(),
        agentCollaboration: createAgentCollaborationMetrics()
    };
}

module.exports = {
    createTimeSeriesPoint,
    createTimeSeries,
    createNodePerformanceMetrics,
    createModelPerformanceMetrics,
    createSystemMetrics,
    createAgentCollaborationMetrics,
    createMetrics
};