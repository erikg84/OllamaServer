/**
 * ModelPerformanceTracker - Tracks performance metrics for different LLM models
 *
 * This class collects and analyzes performance data for different models
 * to help inform intelligent routing and concurrency decisions.
 */
class ModelPerformanceTracker {
    /**
     * Constructor for ModelPerformanceTracker
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            historyLength: config.historyLength || 100,       // History items per model
            modelPruneThreshold: config.modelPruneThreshold || 24 * 60 * 60 * 1000, // 24 hours
            pruneInterval: config.pruneInterval || 60 * 60 * 1000, // 1 hour
            ...config
        };

        // Model performance data
        this.models = {};

        // Aggregate system-wide statistics
        this.systemStats = {
            totalRequests: 0,
            totalTokensGenerated: 0,
            totalPromptTokens: 0,
            totalErrors: 0,
            requestsPerMinute: 0,
            tokensPerSecond: 0,
            averageLatencyMs: 0,
            lastUpdated: Date.now()
        };

        // Request rate tracking for calculating requests per minute
        this.requestTimestamps = [];

        // Task tracking by ID
        this.activeTasks = new Map();

        // Required for logging
        this.logger = config.logger || console;

        // Setup cleanup interval
        this.pruneInterval = null;
        if (this.config.pruneInterval > 0) {
            this.pruneInterval = setInterval(() => {
                this.pruneStaleData();
            }, this.config.pruneInterval);
        }

        // Bind methods to maintain 'this' context
        this.trackRequest = this.trackRequest.bind(this);
        this.trackRequestCompletion = this.trackRequestCompletion.bind(this);
        this.calculateSystemMetrics = this.calculateSystemMetrics.bind(this);
    }

    /**
     * Initialize tracking for a model if it doesn't exist
     * @param {string} modelId - Model identifier
     */
    initializeModel(modelId) {
        if (!this.models[modelId]) {
            this.models[modelId] = {
                id: modelId,
                firstSeen: Date.now(),
                lastUsed: Date.now(),
                totalRequests: 0,
                completedRequests: 0,
                failedRequests: 0,
                totalTokensGenerated: 0,
                totalPromptTokens: 0,
                totalLatencyMs: 0,
                averageLatencyMs: 0,
                tokensPerSecond: 0,
                maxConcurrentRequests: 0,
                currentConcurrentRequests: 0,
                requestHistory: [],
                latencyPercentiles: {
                    p50: 0,
                    p90: 0,
                    p95: 0,
                    p99: 0
                },
                tokenPercentiles: {
                    p50: 0,
                    p90: 0,
                    p95: 0,
                    p99: 0
                }
            };

            this.logger.info({
                message: 'New model tracked',
                modelId,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Start tracking a new request for a model
     * @param {string} requestId - Unique request ID
     * @param {string} modelId - Model identifier
     * @param {Object} metadata - Additional request metadata
     * @returns {string} The request ID
     */
    trackRequest(requestId, modelId, metadata = {}) {
        // Ensure model is initialized
        this.initializeModel(modelId);

        const model = this.models[modelId];
        const startTime = Date.now();

        // Update model stats
        model.totalRequests++;
        model.currentConcurrentRequests++;
        model.lastUsed = startTime;

        // Update max concurrent requests if new high
        if (model.currentConcurrentRequests > model.maxConcurrentRequests) {
            model.maxConcurrentRequests = model.currentConcurrentRequests;
        }

        // Track the active task
        this.activeTasks.set(requestId, {
            requestId,
            modelId,
            startTime,
            metadata,
            promptTokens: metadata.promptTokens || 0
        });

        // Update system stats
        this.systemStats.totalRequests++;
        this.requestTimestamps.push(startTime);

        // Trim request timestamps to last hour for rate calculation
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        this.requestTimestamps = this.requestTimestamps.filter(
            timestamp => timestamp >= oneHourAgo
        );

        // Calculate current system metrics
        this.calculateSystemMetrics();

        this.logger.debug({
            message: 'Request started',
            requestId,
            modelId,
            timestamp: new Date(startTime).toISOString(),
            concurrentRequests: model.currentConcurrentRequests
        });

        return requestId;
    }

    /**
     * Track the completion of a request
     * @param {string} requestId - Request ID to complete
     * @param {Object} results - Completion results
     * @param {boolean} isError - Whether the request failed
     * @returns {Object} Performance metrics for the request
     */
    trackRequestCompletion(requestId, results = {}, isError = false) {
        const task = this.activeTasks.get(requestId);
        if (!task) {
            this.logger.warn({
                message: 'Attempted to complete unknown request',
                requestId,
                timestamp: new Date().toISOString()
            });
            return null;
        }

        const { modelId, startTime, metadata, promptTokens } = task;
        const model = this.models[modelId];
        const endTime = Date.now();
        const latencyMs = endTime - startTime;
        const outputTokens = results.completionTokens || results.tokenCount || 0;
        const totalTokens = outputTokens + promptTokens;

        // Calculate tokens per second
        const tokensPerSecond = latencyMs > 0 ? (outputTokens / (latencyMs / 1000)) : 0;

        // Create result entry
        const resultEntry = {
            requestId,
            startTime,
            endTime,
            latencyMs,
            promptTokens,
            outputTokens,
            totalTokens,
            tokensPerSecond,
            metadata,
            isError
        };

        // Update model stats
        model.currentConcurrentRequests = Math.max(0, model.currentConcurrentRequests - 1);

        if (isError) {
            model.failedRequests++;
            this.systemStats.totalErrors++;
        } else {
            model.completedRequests++;
            model.totalTokensGenerated += outputTokens;
            model.totalPromptTokens += promptTokens;
            model.totalLatencyMs += latencyMs;

            // Update average latency
            model.averageLatencyMs =
                model.totalLatencyMs / model.completedRequests;

            // Update tokens per second (running average)
            if (model.tokensPerSecond === 0) {
                model.tokensPerSecond = tokensPerSecond;
            } else {
                model.tokensPerSecond = (model.tokensPerSecond * 0.95) + (tokensPerSecond * 0.05);
            }

            // Update system totals
            this.systemStats.totalTokensGenerated += outputTokens;
            this.systemStats.totalPromptTokens += promptTokens;
        }

        // Add to request history
        model.requestHistory.push(resultEntry);

        // Trim history to configured length
        if (model.requestHistory.length > this.config.historyLength) {
            model.requestHistory.shift();
        }

        // Update model percentiles
        this.updateModelPercentiles(modelId);

        // Clean up active task
        this.activeTasks.delete(requestId);

        // Calculate current system metrics
        this.calculateSystemMetrics();

        this.logger.debug({
            message: isError ? 'Request failed' : 'Request completed',
            requestId,
            modelId,
            latencyMs,
            outputTokens,
            promptTokens,
            tokensPerSecond: tokensPerSecond.toFixed(2),
            timestamp: new Date(endTime).toISOString()
        });

        return resultEntry;
    }

    /**
     * Calculate current system-wide metrics
     */
    calculateSystemMetrics() {
        const now = Date.now();

        // Calculate requests per minute
        const oneMinuteAgo = now - (60 * 1000);
        const requestsLastMinute = this.requestTimestamps.filter(
            timestamp => timestamp >= oneMinuteAgo
        ).length;

        this.systemStats.requestsPerMinute = requestsLastMinute;

        // Calculate system-wide tokens per second (if we have completed requests)
        const completedRequests = Object.values(this.models).reduce(
            (sum, model) => sum + model.completedRequests, 0
        );

        if (completedRequests > 0) {
            // Calculate total latency across all models
            const totalLatencyMs = Object.values(this.models).reduce(
                (sum, model) => sum + model.totalLatencyMs, 0
            );

            // Calculate system-wide average latency
            this.systemStats.averageLatencyMs = totalLatencyMs / completedRequests;

            // Estimate tokens per second across the system
            const totalTokensGenerated = this.systemStats.totalTokensGenerated;
            const totalProcessingTimeSeconds = totalLatencyMs / 1000;

            if (totalProcessingTimeSeconds > 0) {
                this.systemStats.tokensPerSecond =
                    totalTokensGenerated / totalProcessingTimeSeconds;
            }
        }

        this.systemStats.lastUpdated = now;
    }

    /**
     * Update percentile calculations for a model
     * @param {string} modelId - Model to update
     */
    updateModelPercentiles(modelId) {
        const model = this.models[modelId];

        // Need at least a few requests for meaningful percentiles
        if (model.requestHistory.length < 5) {
            return;
        }

        // Extract latency values and sort them
        const latencies = model.requestHistory
            .filter(entry => !entry.isError)
            .map(entry => entry.latencyMs)
            .sort((a, b) => a - b);

        // Extract token counts and sort them
        const tokenCounts = model.requestHistory
            .filter(entry => !entry.isError)
            .map(entry => entry.outputTokens)
            .sort((a, b) => a - b);

        // Only calculate if we have valid entries
        if (latencies.length > 0) {
            model.latencyPercentiles = {
                p50: this.calculatePercentile(latencies, 50),
                p90: this.calculatePercentile(latencies, 90),
                p95: this.calculatePercentile(latencies, 95),
                p99: this.calculatePercentile(latencies, 99)
            };
        }

        if (tokenCounts.length > 0) {
            model.tokenPercentiles = {
                p50: this.calculatePercentile(tokenCounts, 50),
                p90: this.calculatePercentile(tokenCounts, 90),
                p95: this.calculatePercentile(tokenCounts, 95),
                p99: this.calculatePercentile(tokenCounts, 99)
            };
        }
    }

    /**
     * Calculate a percentile value from an array of numbers
     * @param {Array} values - Sorted array of values
     * @param {number} percentile - Percentile to calculate (0-100)
     * @returns {number} The percentile value
     */
    calculatePercentile(values, percentile) {
        if (values.length === 0) return 0;

        const index = Math.ceil((percentile / 100) * values.length) - 1;
        return values[Math.max(0, Math.min(values.length - 1, index))];
    }

    /**
     * Remove stale data from the tracker
     */
    pruneStaleData() {
        const now = Date.now();
        const staleThreshold = now - this.config.modelPruneThreshold;

        let prunedModels = 0;

        // Check each model for staleness
        Object.keys(this.models).forEach(modelId => {
            const model = this.models[modelId];

            // If model hasn't been used for threshold period, remove it
            if (model.lastUsed < staleThreshold) {
                delete this.models[modelId];
                prunedModels++;

                this.logger.info({
                    message: 'Pruned stale model data',
                    modelId,
                    lastUsed: new Date(model.lastUsed).toISOString(),
                    timestamp: new Date().toISOString()
                });
            }
        });

        if (prunedModels > 0) {
            this.logger.info({
                message: 'Completed model data pruning',
                prunedModels,
                remainingModels: Object.keys(this.models).length,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Stop the tracker and clean up resources
     */
    stop() {
        if (this.pruneInterval) {
            clearInterval(this.pruneInterval);
            this.pruneInterval = null;
        }

        this.logger.info({
            message: 'ModelPerformanceTracker stopped',
            trackedModels: Object.keys(this.models).length,
            activeTasks: this.activeTasks.size,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Get performance metrics for a specific model
     * @param {string} modelId - Model ID to get metrics for
     * @returns {Object} Model performance metrics
     */
    getModelMetrics(modelId) {
        const model = this.models[modelId];
        if (!model) {
            return null;
        }

        // Calculate success rate
        const successRate = model.totalRequests > 0
            ? ((model.completedRequests / model.totalRequests) * 100).toFixed(2)
            : 100;

        // Return a clean metrics object
        return {
            id: model.id,
            totalRequests: model.totalRequests,
            completedRequests: model.completedRequests,
            failedRequests: model.failedRequests,
            successRate: `${successRate}%`,
            averageLatencyMs: Math.round(model.averageLatencyMs),
            tokensPerSecond: model.tokensPerSecond.toFixed(2),
            totalTokensGenerated: model.totalTokensGenerated,
            totalPromptTokens: model.totalPromptTokens,
            currentConcurrentRequests: model.currentConcurrentRequests,
            maxConcurrentRequests: model.maxConcurrentRequests,
            firstSeen: new Date(model.firstSeen).toISOString(),
            lastUsed: new Date(model.lastUsed).toISOString(),
            latencyPercentiles: { ...model.latencyPercentiles },
            tokenPercentiles: { ...model.tokenPercentiles }
        };
    }

    /**
     * Get summary metrics for all tracked models
     * @returns {Array} Array of model summary metrics
     */
    getAllModelMetrics() {
        return Object.keys(this.models).map(modelId => this.getModelMetrics(modelId));
    }

    /**
     * Get system-wide performance metrics
     * @returns {Object} System performance metrics
     */
    getSystemMetrics() {
        // Calculate additional metrics
        const totalRequests = this.systemStats.totalRequests;
        const errorRate = totalRequests > 0
            ? ((this.systemStats.totalErrors / totalRequests) * 100).toFixed(2)
            : 0;

        return {
            totalRequests,
            totalErrors: this.systemStats.totalErrors,
            errorRate: `${errorRate}%`,
            totalTokensGenerated: this.systemStats.totalTokensGenerated,
            totalPromptTokens: this.systemStats.totalPromptTokens,
            requestsPerMinute: this.systemStats.requestsPerMinute,
            tokensPerSecond: this.systemStats.tokensPerSecond.toFixed(2),
            averageLatencyMs: Math.round(this.systemStats.averageLatencyMs),
            activeModels: Object.keys(this.models).length,
            activeRequests: this.activeTasks.size,
            lastUpdated: new Date(this.systemStats.lastUpdated).toISOString()
        };
    }

    /**
     * Get detailed request history for a model
     * @param {string} modelId - Model ID to get history for
     * @param {number} limit - Maximum number of history items
     * @returns {Array} Request history for the model
     */
    getModelRequestHistory(modelId, limit = this.config.historyLength) {
        const model = this.models[modelId];
        if (!model) {
            return [];
        }

        // Return most recent entries up to limit
        return model.requestHistory
            .slice(-limit)
            .map(entry => ({
                requestId: entry.requestId,
                startTime: new Date(entry.startTime).toISOString(),
                endTime: new Date(entry.endTime).toISOString(),
                latencyMs: entry.latencyMs,
                promptTokens: entry.promptTokens,
                outputTokens: entry.outputTokens,
                totalTokens: entry.totalTokens,
                tokensPerSecond: entry.tokensPerSecond.toFixed(2),
                isError: entry.isError
            }));
    }

    /**
     * Get optimal concurrency recommendation for a model
     * @param {string} modelId - Model ID to get recommendation for
     * @returns {Object} Concurrency recommendation
     */
    getOptimalConcurrency(modelId) {
        const model = this.models[modelId];
        if (!model || model.completedRequests < 10) {
            // Not enough data for a good recommendation
            return {
                modelId,
                recommendedConcurrency: 1,
                confidence: "low",
                reason: "Insufficient performance data"
            };
        }

        // Get recent history (last 20 requests or whatever's available)
        const recentHistory = model.requestHistory
            .filter(entry => !entry.isError)
            .slice(-20);

        if (recentHistory.length < 5) {
            return {
                modelId,
                recommendedConcurrency: 1,
                confidence: "low",
                reason: "Insufficient recent successful requests"
            };
        }

        // Calculate throughput at different concurrency levels
        const concurrencyPerformance = {};

        recentHistory.forEach(entry => {
            // Use the concurrent requests count when this request started
            const concurrencyLevel = entry.metadata.concurrentRequests || 1;

            if (!concurrencyPerformance[concurrencyLevel]) {
                concurrencyPerformance[concurrencyLevel] = {
                    requests: 0,
                    totalTokens: 0,
                    totalTime: 0,
                    tokensPerSecond: 0
                };
            }

            const perf = concurrencyPerformance[concurrencyLevel];
            perf.requests++;
            perf.totalTokens += entry.outputTokens;
            perf.totalTime += entry.latencyMs;
        });

        // Calculate tokens per second for each concurrency level
        Object.keys(concurrencyPerformance).forEach(level => {
            const perf = concurrencyPerformance[level];

            if (perf.totalTime > 0) {
                perf.tokensPerSecond =
                    perf.totalTokens / (perf.totalTime / 1000);
            }
        });

        // Find the concurrency level with the best performance
        let bestLevel = 1;
        let bestThroughput = 0;
        let bestSampleCount = 0;

        Object.keys(concurrencyPerformance).forEach(level => {
            const perf = concurrencyPerformance[level];
            const numLevel = parseInt(level, 10);

            // Only consider levels with enough samples for confidence
            const minSamples = Math.max(3, Math.min(5, recentHistory.length / 4));

            if (perf.requests >= minSamples && perf.tokensPerSecond > bestThroughput) {
                bestLevel = numLevel;
                bestThroughput = perf.tokensPerSecond;
                bestSampleCount = perf.requests;
            }
        });

        // Determine confidence level
        let confidence = "low";
        if (bestSampleCount >= 10) {
            confidence = "high";
        } else if (bestSampleCount >= 5) {
            confidence = "medium";
        }

        return {
            modelId,
            recommendedConcurrency: bestLevel,
            optimalTokensPerSecond: bestThroughput.toFixed(2),
            confidence,
            sampleSize: bestSampleCount,
            reason: `Based on throughput analysis of ${recentHistory.length} recent requests`
        };
    }

    /**
     * Get recommendations for all tracked models
     * @returns {Array} Array of concurrency recommendations
     */
    getAllConcurrencyRecommendations() {
        return Object.keys(this.models).map(modelId =>
            this.getOptimalConcurrency(modelId)
        );
    }

    /**
     * Analyze model performance trend
     * @param {string} modelId - Model ID to analyze
     * @returns {Object} Trend analysis
     */
    analyzeModelTrend(modelId) {
        const model = this.models[modelId];
        if (!model || model.requestHistory.length < 10) {
            return {
                modelId,
                trend: "unknown",
                reason: "Insufficient data for trend analysis"
            };
        }

        // Split history into two halves to compare
        const history = model.requestHistory.filter(entry => !entry.isError);
        const midpoint = Math.floor(history.length / 2);
        const firstHalf = history.slice(0, midpoint);
        const secondHalf = history.slice(midpoint);

        // Calculate average latency for each half
        const firstHalfLatency = firstHalf.reduce((sum, entry) =>
            sum + entry.latencyMs, 0) / firstHalf.length;

        const secondHalfLatency = secondHalf.reduce((sum, entry) =>
            sum + entry.latencyMs, 0) / secondHalf.length;

        // Calculate average tokens per second for each half
        const firstHalfTPS = firstHalf.reduce((sum, entry) =>
            sum + entry.tokensPerSecond, 0) / firstHalf.length;

        const secondHalfTPS = secondHalf.reduce((sum, entry) =>
            sum + entry.tokensPerSecond, 0) / secondHalf.length;

        // Calculate percentage changes
        const latencyChange = ((secondHalfLatency - firstHalfLatency) / firstHalfLatency) * 100;
        const tpsChange = ((secondHalfTPS - firstHalfTPS) / firstHalfTPS) * 100;

        // Determine overall trend
        let trend = "stable";
        let reason = "Performance metrics are relatively stable";

        if (latencyChange > 10 && tpsChange < -10) {
            trend = "degrading";
            reason = `Performance degrading: Latency increased by ${latencyChange.toFixed(1)}%, throughput decreased by ${Math.abs(tpsChange).toFixed(1)}%`;
        } else if (latencyChange < -10 && tpsChange > 10) {
            trend = "improving";
            reason = `Performance improving: Latency decreased by ${Math.abs(latencyChange).toFixed(1)}%, throughput increased by ${tpsChange.toFixed(1)}%`;
        } else if (latencyChange > 20) {
            trend = "degrading";
            reason = `Latency increased significantly by ${latencyChange.toFixed(1)}%`;
        } else if (tpsChange < -20) {
            trend = "degrading";
            reason = `Throughput decreased significantly by ${Math.abs(tpsChange).toFixed(1)}%`;
        } else if (latencyChange < -20) {
            trend = "improving";
            reason = `Latency decreased significantly by ${Math.abs(latencyChange).toFixed(1)}%`;
        } else if (tpsChange > 20) {
            trend = "improving";
            reason = `Throughput increased significantly by ${tpsChange.toFixed(1)}%`;
        }

        return {
            modelId,
            trend,
            reason,
            metrics: {
                latencyChange: `${latencyChange.toFixed(1)}%`,
                throughputChange: `${tpsChange.toFixed(1)}%`,
                firstHalfLatency: Math.round(firstHalfLatency),
                secondHalfLatency: Math.round(secondHalfLatency),
                firstHalfTPS: firstHalfTPS.toFixed(2),
                secondHalfTPS: secondHalfTPS.toFixed(2),
                sampleSize: history.length
            }
        };
    }
}

module.exports = ModelPerformanceTracker;