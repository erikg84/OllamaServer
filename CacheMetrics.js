/**
 * CacheMetrics - Tracks and analyzes cache performance metrics
 *
 * This class collects, processes, and exposes metrics about cache utilization,
 * hit/miss rates, and performance impact for the LLM request cache.
 */
class CacheMetrics {
    /**
     * Constructor for CacheMetrics
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            // How many data points to keep in time series
            historyLength: config.historyLength || 100,

            // Interval for calculating time-based metrics (ms)
            metricsInterval: config.metricsInterval || 60000, // 1 minute

            // How often to sample metrics for time series (ms)
            samplingInterval: config.samplingInterval || 5000, // 5 seconds

            // Number of request types to track separately
            maxRequestTypes: config.maxRequestTypes || 10,

            // Number of models to track separately
            maxModels: config.maxModels || 20,

            // Logger instance
            logger: config.logger || console,

            ...config
        };

        // Basic metrics counters
        this.counters = {
            hits: 0,
            misses: 0,
            adds: 0,
            evictions: 0,
            errors: 0,
            lookups: 0
        };

        // Performance metrics
        this.performance = {
            // Time saved by cache hits (ms)
            timeSaved: 0,

            // Time spent on cache operations (ms)
            cacheOverhead: 0,

            // Hit durations (ms)
            hitDurations: [],

            // Miss durations for same requests (ms)
            missDurations: [],

            // Key generation times (ms)
            keyGenTimes: []
        };

        // Size metrics
        this.size = {
            current: 0,
            max: 0,
            bytes: 0,
            maxBytes: 0
        };

        // Per-model metrics
        this.modelMetrics = new Map();

        // Per-request-type metrics
        this.requestTypeMetrics = new Map();

        // Time series data
        this.timeSeries = {
            hitRate: [],
            size: [],
            memoryUsage: [],
            requestRate: []
        };

        // Current metrics calculated on interval
        this.current = {
            hitRate: 0,
            requestsPerMinute: 0,
            avgHitDuration: 0,
            avgMissDuration: 0,
            timeSavedPerMinute: 0,
            bytesPerItem: 0
        };

        // Tracking time periods
        this.trackingPeriods = {
            // For current metrics calculation
            metrics: {
                start: Date.now(),
                hits: 0,
                misses: 0,
                timeSaved: 0
            },

            // For request rate calculation
            requestRate: {
                timestamps: [],
                window: 60000 // 1 minute window
            }
        };

        // Setup interval for metrics calculation
        this.metricsInterval = setInterval(() => {
            this.calculateCurrentMetrics();
        }, this.config.metricsInterval);

        // Setup interval for time series sampling
        this.samplingInterval = setInterval(() => {
            this.sampleTimeSeries();
        }, this.config.samplingInterval);

        this.config.logger.info({
            message: 'CacheMetrics initialized',
            metricsInterval: `${this.config.metricsInterval}ms`,
            samplingInterval: `${this.config.samplingInterval}ms`,
            historyLength: this.config.historyLength,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Record a cache hit
     * @param {Object} metadata - Metadata about the hit
     */
    recordHit(metadata = {}) {
        this.counters.hits++;
        this.counters.lookups++;
        this.trackingPeriods.metrics.hits++;

        // Add to request rate tracking
        this.trackRequestTimestamp();

        // Track performance data if provided
        if (metadata.duration) {
            this.performance.hitDurations.push(metadata.duration);
            this.limitArraySize(this.performance.hitDurations);
        }

        // Track time saved if comparable miss duration is available
        if (metadata.duration && metadata.avgMissDuration) {
            const timeSaved = metadata.avgMissDuration - metadata.duration;
            if (timeSaved > 0) {
                this.performance.timeSaved += timeSaved;
                this.trackingPeriods.metrics.timeSaved += timeSaved;
            }
        }

        // Track key generation time
        if (metadata.keyGenTime) {
            this.performance.keyGenTimes.push(metadata.keyGenTime);
            this.limitArraySize(this.performance.keyGenTimes);
            this.performance.cacheOverhead += metadata.keyGenTime;
        }

        // Track by model
        if (metadata.modelId) {
            this.recordModelHit(metadata.modelId);
        }

        // Track by request type
        if (metadata.requestType) {
            this.recordRequestTypeHit(metadata.requestType);
        }
    }

    /**
     * Record a cache miss
     * @param {Object} metadata - Metadata about the miss
     */
    recordMiss(metadata = {}) {
        this.counters.misses++;
        this.counters.lookups++;
        this.trackingPeriods.metrics.misses++;

        // Add to request rate tracking
        this.trackRequestTimestamp();

        // Track performance data if provided
        if (metadata.duration) {
            this.performance.missDurations.push(metadata.duration);
            this.limitArraySize(this.performance.missDurations);
        }

        // Track key generation time
        if (metadata.keyGenTime) {
            this.performance.keyGenTimes.push(metadata.keyGenTime);
            this.limitArraySize(this.performance.keyGenTimes);
            this.performance.cacheOverhead += metadata.keyGenTime;
        }

        // Track by model
        if (metadata.modelId) {
            this.recordModelMiss(metadata.modelId);
        }

        // Track by request type
        if (metadata.requestType) {
            this.recordRequestTypeMiss(metadata.requestType);
        }
    }

    /**
     * Record addition of an item to the cache
     * @param {Object} metadata - Metadata about the addition
     */
    recordAdd(metadata = {}) {
        this.counters.adds++;

        // Update size tracking
        this.size.current++;
        if (this.size.current > this.size.max) {
            this.size.max = this.size.current;
        }

        // Track size in bytes
        if (metadata.bytes) {
            this.size.bytes += metadata.bytes;
            if (this.size.bytes > this.size.maxBytes) {
                this.size.maxBytes = this.size.bytes;
            }
        }

        // Track by model
        if (metadata.modelId) {
            this.recordModelAdd(metadata.modelId, metadata.bytes);
        }

        // Track by request type
        if (metadata.requestType) {
            this.recordRequestTypeAdd(metadata.requestType, metadata.bytes);
        }
    }

    /**
     * Record an eviction from the cache
     * @param {Object} metadata - Metadata about the eviction
     */
    recordEviction(metadata = {}) {
        this.counters.evictions++;

        // Update size tracking
        this.size.current = Math.max(0, this.size.current - 1);

        // Track size in bytes
        if (metadata.bytes) {
            this.size.bytes = Math.max(0, this.size.bytes - metadata.bytes);
        }

        // Track by model
        if (metadata.modelId) {
            this.recordModelEviction(metadata.modelId, metadata.bytes);
        }

        // Track by request type
        if (metadata.requestType) {
            this.recordRequestTypeEviction(metadata.requestType, metadata.bytes);
        }
    }

    /**
     * Record a cache-related error
     * @param {Object} metadata - Metadata about the error
     */
    recordError(metadata = {}) {
        this.counters.errors++;

        // Additional error-specific tracking could be added here

        this.config.logger.warn({
            message: 'Cache error recorded',
            errorType: metadata.errorType || 'unknown',
            errorMessage: metadata.message || 'No details',
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Record model-specific cache hit
     * @param {string} modelId - Model identifier
     */
    recordModelHit(modelId) {
        if (!this.modelMetrics.has(modelId)) {
            this.initializeModelMetrics(modelId);
        }

        const metrics = this.modelMetrics.get(modelId);
        metrics.hits++;
        metrics.lookups++;
    }

    /**
     * Record model-specific cache miss
     * @param {string} modelId - Model identifier
     */
    recordModelMiss(modelId) {
        if (!this.modelMetrics.has(modelId)) {
            this.initializeModelMetrics(modelId);
        }

        const metrics = this.modelMetrics.get(modelId);
        metrics.misses++;
        metrics.lookups++;
    }

    /**
     * Record model-specific cache addition
     * @param {string} modelId - Model identifier
     * @param {number} bytes - Size of added item in bytes
     */
    recordModelAdd(modelId, bytes = 0) {
        if (!this.modelMetrics.has(modelId)) {
            this.initializeModelMetrics(modelId);
        }

        const metrics = this.modelMetrics.get(modelId);
        metrics.adds++;
        metrics.size++;

        if (bytes) {
            metrics.bytes += bytes;
        }
    }

    /**
     * Record model-specific cache eviction
     * @param {string} modelId - Model identifier
     * @param {number} bytes - Size of evicted item in bytes
     */
    recordModelEviction(modelId, bytes = 0) {
        if (!this.modelMetrics.has(modelId)) {
            return; // No metrics for this model
        }

        const metrics = this.modelMetrics.get(modelId);
        metrics.evictions++;
        metrics.size = Math.max(0, metrics.size - 1);

        if (bytes) {
            metrics.bytes = Math.max(0, metrics.bytes - bytes);
        }
    }

    /**
     * Record request-type specific cache hit
     * @param {string} requestType - Request type (e.g., 'generate', 'chat')
     */
    recordRequestTypeHit(requestType) {
        if (!this.requestTypeMetrics.has(requestType)) {
            this.initializeRequestTypeMetrics(requestType);
        }

        const metrics = this.requestTypeMetrics.get(requestType);
        metrics.hits++;
        metrics.lookups++;
    }

    /**
     * Record request-type specific cache miss
     * @param {string} requestType - Request type
     */
    recordRequestTypeMiss(requestType) {
        if (!this.requestTypeMetrics.has(requestType)) {
            this.initializeRequestTypeMetrics(requestType);
        }

        const metrics = this.requestTypeMetrics.get(requestType);
        metrics.misses++;
        metrics.lookups++;
    }

    /**
     * Record request-type specific cache addition
     * @param {string} requestType - Request type
     * @param {number} bytes - Size of added item in bytes
     */
    recordRequestTypeAdd(requestType, bytes = 0) {
        if (!this.requestTypeMetrics.has(requestType)) {
            this.initializeRequestTypeMetrics(requestType);
        }

        const metrics = this.requestTypeMetrics.get(requestType);
        metrics.adds++;
        metrics.size++;

        if (bytes) {
            metrics.bytes += bytes;
        }
    }

    /**
     * Record request-type specific cache eviction
     * @param {string} requestType - Request type
     * @param {number} bytes - Size of evicted item in bytes
     */
    recordRequestTypeEviction(requestType, bytes = 0) {
        if (!this.requestTypeMetrics.has(requestType)) {
            return; // No metrics for this request type
        }

        const metrics = this.requestTypeMetrics.get(requestType);
        metrics.evictions++;
        metrics.size = Math.max(0, metrics.size - 1);

        if (bytes) {
            metrics.bytes = Math.max(0, metrics.bytes - bytes);
        }
    }

    /**
     * Initialize metrics tracking for a model
     * @param {string} modelId - Model identifier
     */
    initializeModelMetrics(modelId) {
        // Ensure we don't track too many models
        if (this.modelMetrics.size >= this.config.maxModels) {
            // Find the least used model to replace
            let leastUsedModel = null;
            let leastUsedCount = Infinity;

            for (const [id, metrics] of this.modelMetrics.entries()) {
                if (metrics.lookups < leastUsedCount) {
                    leastUsedCount = metrics.lookups;
                    leastUsedModel = id;
                }
            }

            // Delete the least used model
            if (leastUsedModel) {
                this.modelMetrics.delete(leastUsedModel);
            }
        }

        // Create new model metrics
        this.modelMetrics.set(modelId, {
            hits: 0,
            misses: 0,
            lookups: 0,
            adds: 0,
            evictions: 0,
            size: 0,
            bytes: 0,
            firstSeen: Date.now()
        });
    }

    /**
     * Initialize metrics tracking for a request type
     * @param {string} requestType - Request type
     */
    initializeRequestTypeMetrics(requestType) {
        // Ensure we don't track too many request types
        if (this.requestTypeMetrics.size >= this.config.maxRequestTypes) {
            // Find the least used request type to replace
            let leastUsedType = null;
            let leastUsedCount = Infinity;

            for (const [type, metrics] of this.requestTypeMetrics.entries()) {
                if (metrics.lookups < leastUsedCount) {
                    leastUsedCount = metrics.lookups;
                    leastUsedType = type;
                }
            }

            // Delete the least used request type
            if (leastUsedType) {
                this.requestTypeMetrics.delete(leastUsedType);
            }
        }

        // Create new request type metrics
        this.requestTypeMetrics.set(requestType, {
            hits: 0,
            misses: 0,
            lookups: 0,
            adds: 0,
            evictions: 0,
            size: 0,
            bytes: 0,
            firstSeen: Date.now()
        });
    }

    /**
     * Track request timestamp for rate calculation
     */
    trackRequestTimestamp() {
        const now = Date.now();
        this.trackingPeriods.requestRate.timestamps.push(now);

        // Remove timestamps outside the window
        const cutoff = now - this.trackingPeriods.requestRate.window;
        this.trackingPeriods.requestRate.timestamps =
            this.trackingPeriods.requestRate.timestamps.filter(ts => ts >= cutoff);
    }

    /**
     * Calculate current metrics from tracking periods
     */
    calculateCurrentMetrics() {
        const period = this.trackingPeriods.metrics;
        const now = Date.now();
        const durationMinutes = (now - period.start) / 60000;

        // Calculate hit rate for the period
        const periodLookups = period.hits + period.misses;
        this.current.hitRate = periodLookups > 0 ?
            (period.hits / periodLookups) * 100 : 0;

        // Calculate requests per minute
        this.current.requestsPerMinute =
            this.trackingPeriods.requestRate.timestamps.length;

        // Calculate average hit duration
        this.current.avgHitDuration = this.calculateAverage(this.performance.hitDurations);

        // Calculate average miss duration
        this.current.avgMissDuration = this.calculateAverage(this.performance.missDurations);

        // Calculate time saved per minute
        this.current.timeSavedPerMinute = durationMinutes > 0 ?
            period.timeSaved / durationMinutes : 0;

        // Calculate bytes per item
        this.current.bytesPerItem = this.size.current > 0 ?
            this.size.bytes / this.size.current : 0;

        // Reset period tracking
        this.trackingPeriods.metrics = {
            start: now,
            hits: 0,
            misses: 0,
            timeSaved: 0
        };

        this.config.logger.debug({
            message: 'Cache metrics calculated',
            hitRate: `${this.current.hitRate.toFixed(2)}%`,
            requestsPerMinute: this.current.requestsPerMinute,
            timeSavedPerMinute: `${Math.round(this.current.timeSavedPerMinute)}ms`,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Sample current values to time series
     */
    sampleTimeSeries() {
        const now = Date.now();

        // Add hit rate sample
        this.timeSeries.hitRate.push({
            timestamp: now,
            value: this.current.hitRate
        });
        this.limitArraySize(this.timeSeries.hitRate);

        // Add size sample
        this.timeSeries.size.push({
            timestamp: now,
            value: this.size.current,
            max: this.size.max
        });
        this.limitArraySize(this.timeSeries.size);

        // Add memory usage sample
        this.timeSeries.memoryUsage.push({
            timestamp: now,
            value: this.size.bytes,
            max: this.size.maxBytes
        });
        this.limitArraySize(this.timeSeries.memoryUsage);

        // Add request rate sample
        this.timeSeries.requestRate.push({
            timestamp: now,
            value: this.current.requestsPerMinute
        });
        this.limitArraySize(this.timeSeries.requestRate);
    }

    /**
     * Limit array to configured history length by removing oldest items
     * @param {Array} array - Array to limit
     */
    limitArraySize(array) {
        if (array.length > this.config.historyLength) {
            array.splice(0, array.length - this.config.historyLength);
        }
    }

    /**
     * Calculate average of values in an array
     * @param {Array} array - Array of numbers
     * @returns {number} Average value
     */
    calculateAverage(array) {
        if (array.length === 0) return 0;
        const sum = array.reduce((a, b) => a + b, 0);
        return sum / array.length;
    }

    /**
     * Get current cache metrics
     * @returns {Object} Current metrics
     */
    getMetrics() {
        // Calculate overall hit rate
        const totalLookups = this.counters.hits + this.counters.misses;
        const overallHitRate = totalLookups > 0 ?
            (this.counters.hits / totalLookups) * 100 : 0;

        // Calculate average overhead per request (ms)
        const averageKeyGenTime = this.calculateAverage(this.performance.keyGenTimes);

        return {
            summary: {
                hitRate: {
                    current: `${this.current.hitRate.toFixed(2)}%`,
                    overall: `${overallHitRate.toFixed(2)}%`
                },
                size: {
                    current: this.size.current,
                    max: this.size.max,
                    currentBytes: this.formatBytes(this.size.bytes),
                    maxBytes: this.formatBytes(this.size.maxBytes)
                },
                performance: {
                    requestsPerMinute: this.current.requestsPerMinute,
                    totalTimeSaved: `${Math.round(this.performance.timeSaved)}ms`,
                    timeSavedPerMinute: `${Math.round(this.current.timeSavedPerMinute)}ms`,
                    avgHitDuration: `${Math.round(this.current.avgHitDuration)}ms`,
                    avgMissDuration: `${Math.round(this.current.avgMissDuration)}ms`,
                    avgKeyGenTime: `${averageKeyGenTime.toFixed(2)}ms`,
                    cacheOverhead: `${Math.round(this.performance.cacheOverhead)}ms`
                }
            },
            counters: {
                hits: this.counters.hits,
                misses: this.counters.misses,
                lookups: this.counters.lookups,
                adds: this.counters.adds,
                evictions: this.counters.evictions,
                errors: this.counters.errors
            },
            models: this.getModelMetricsSummary(),
            requestTypes: this.getRequestTypeMetricsSummary(),
            timeSeries: this.timeSeries
        };
    }

    /**
     * Get summary of model-specific metrics
     * @returns {Object} Model metrics summary
     */
    getModelMetricsSummary() {
        const summary = {};

        for (const [modelId, metrics] of this.modelMetrics.entries()) {
            const lookups = metrics.hits + metrics.misses;
            const hitRate = lookups > 0 ? (metrics.hits / lookups) * 100 : 0;

            summary[modelId] = {
                hits: metrics.hits,
                misses: metrics.misses,
                lookups: lookups,
                hitRate: `${hitRate.toFixed(2)}%`,
                size: metrics.size,
                bytes: this.formatBytes(metrics.bytes),
                firstSeen: new Date(metrics.firstSeen).toISOString()
            };
        }

        return summary;
    }

    /**
     * Get summary of request-type specific metrics
     * @returns {Object} Request type metrics summary
     */
    getRequestTypeMetricsSummary() {
        const summary = {};

        for (const [requestType, metrics] of this.requestTypeMetrics.entries()) {
            const lookups = metrics.hits + metrics.misses;
            const hitRate = lookups > 0 ? (metrics.hits / lookups) * 100 : 0;

            summary[requestType] = {
                hits: metrics.hits,
                misses: metrics.misses,
                lookups: lookups,
                hitRate: `${hitRate.toFixed(2)}%`,
                size: metrics.size,
                bytes: this.formatBytes(metrics.bytes),
                firstSeen: new Date(metrics.firstSeen).toISOString()
            };
        }

        return summary;
    }

    /**
     * Format bytes value to human-readable string
     * @param {number} bytes - Bytes value
     * @returns {string} Formatted string
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';

        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));

        return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Get performance impact analysis
     * @returns {Object} Performance impact analysis
     */
    getPerformanceImpact() {
        const totalRequests = this.counters.hits + this.counters.misses;

        // Skip if no requests yet
        if (totalRequests === 0) {
            return {
                timeSaved: '0ms',
                overhead: '0ms',
                netBenefit: '0ms',
                efficiency: '0%',
                averageTimeSavedPerHit: '0ms',
                averageOverheadPerRequest: '0ms'
            };
        }

        // Calculate overall performance metrics
        const totalTimeSaved = this.performance.timeSaved;
        const totalOverhead = this.performance.cacheOverhead;
        const netBenefit = totalTimeSaved - totalOverhead;

        // Calculate efficiency ratio
        const efficiency = totalTimeSaved > 0 ?
            (netBenefit / totalTimeSaved) * 100 : 0;

        // Calculate per-request metrics
        const averageTimeSavedPerHit = this.counters.hits > 0 ?
            totalTimeSaved / this.counters.hits : 0;

        const averageOverheadPerRequest = totalRequests > 0 ?
            totalOverhead / totalRequests : 0;

        return {
            timeSaved: `${Math.round(totalTimeSaved)}ms`,
            overhead: `${Math.round(totalOverhead)}ms`,
            netBenefit: `${Math.round(netBenefit)}ms`,
            efficiency: `${efficiency.toFixed(2)}%`,
            averageTimeSavedPerHit: `${averageTimeSavedPerHit.toFixed(2)}ms`,
            averageOverheadPerRequest: `${averageOverheadPerRequest.toFixed(2)}ms`
        };
    }

    /**
     * Reset all metrics
     * @returns {boolean} Success status
     */
    reset() {
        // Reset counters
        this.counters = {
            hits: 0,
            misses: 0,
            adds: 0,
            evictions: 0,
            errors: 0,
            lookups: 0
        };

        // Reset performance metrics
        this.performance = {
            timeSaved: 0,
            cacheOverhead: 0,
            hitDurations: [],
            missDurations: [],
            keyGenTimes: []
        };

        // Reset size metrics
        this.size = {
            current: 0,
            max: 0,
            bytes: 0,
            maxBytes: 0
        };

        // Reset model metrics
        this.modelMetrics.clear();

        // Reset request type metrics
        this.requestTypeMetrics.clear();

        // Reset time series data
        this.timeSeries = {
            hitRate: [],
            size: [],
            memoryUsage: [],
            requestRate: []
        };

        // Reset current metrics
        this.current = {
            hitRate: 0,
            requestsPerMinute: 0,
            avgHitDuration: 0,
            avgMissDuration: 0,
            timeSavedPerMinute: 0,
            bytesPerItem: 0
        };

        // Reset tracking periods
        this.trackingPeriods = {
            metrics: {
                start: Date.now(),
                hits: 0,
                misses: 0,
                timeSaved: 0
            },
            requestRate: {
                timestamps: [],
                window: 60000
            }
        };

        this.config.logger.info({
            message: 'Cache metrics reset',
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Stop metrics tracking
     */
    stop() {
        // Clear intervals
        if (this.metricsInterval) {
            clearInterval(this.metricsInterval);
            this.metricsInterval = null;
        }

        if (this.samplingInterval) {
            clearInterval(this.samplingInterval);
            this.samplingInterval = null;
        }

        this.config.logger.info({
            message: 'CacheMetrics stopped',
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = CacheMetrics;