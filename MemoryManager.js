/**
 * MemoryManager - Manages memory allocation and limits for LLM requests
 *
 * This class monitors system memory availability, tracks per-request memory usage,
 * and prevents out-of-memory conditions by implementing dynamic memory limits.
 */
class MemoryManager {
    /**
     * Constructor for MemoryManager
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Ensure logger is always available (fallback to console if not provided)
        this.logger = config.logger || {
            info: console.info.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            debug: console.debug.bind(console)
        };

        // Configuration with defaults
        this.config = {
            // Memory thresholds (percentage of total system memory)
            criticalMemoryThreshold: config.criticalMemoryThreshold || 90, // Critical threshold (%)
            warningMemoryThreshold: config.warningMemoryThreshold || 80,   // Warning threshold (%)
            healthyMemoryThreshold: config.healthyMemoryThreshold || 60,   // Healthy threshold (%)

            // Garbage collection settings
            gcTriggerThreshold: config.gcTriggerThreshold || 85,           // Trigger GC at this memory usage (%)
            gcCooldownPeriod: config.gcCooldownPeriod || 60000,            // Minimum time between GC calls (ms)

            // Memory allocation settings
            maxRequestMemoryMB: config.maxRequestMemoryMB || 1024,         // Max memory per request (MB)
            reservedSystemMemoryMB: config.reservedSystemMemoryMB || 512,  // Reserved for system use (MB)

            // Model-specific settings (memory required per model in MB)
            modelMemoryRequirements: config.modelMemoryRequirements || {
                default: 512  // Default allocation for unknown models (MB)
            },

            // Memory buffer for token generation (MB per 1K tokens)
            memoryPerKiloTokenMB: config.memoryPerKiloTokenMB || 2,

            // Monitoring settings
            monitoringInterval: config.monitoringInterval || 5000,         // Memory check interval (ms)

            ...config
        };

        // Active request tracking
        this.activeRequests = new Map();

        // Memory usage history
        this.memoryHistory = [];
        this.historyMaxLength = config.historyMaxLength || 100;

        // System memory information (initialized in getSystemMemory)
        this.totalSystemMemoryMB = 0;
        this.availableMemoryMB = 0;
        this.usedMemoryMB = 0;
        this.memoryUsagePercent = 0;

        // GC tracking
        this.lastGCTime = 0;
        this.gcCount = 0;

        // Memory state
        this.currentMemoryState = 'unknown';
        this.lastMemoryCheckTime = 0;

        // Running counters
        this.totalRequests = 0;
        this.rejectedRequests = 0;
        this.limitedRequests = 0;

        // Get OS module for system memory information
        this.os = require('os');

        // Get initial system memory values
        this.updateSystemMemory();

        // Bind methods to maintain 'this' context
        this.updateSystemMemory = this.updateSystemMemory.bind(this);
        this.startMonitoring = this.startMonitoring.bind(this);
        this.stopMonitoring = this.stopMonitoring.bind(this);

        // Start memory monitoring if configured
        this.monitoringInterval = null;
        if (config.startMonitoring !== false) {
            this.startMonitoring();
        }

        this.logger.info({
            message: 'MemoryManager initialized',
            totalMemory: `${this.totalSystemMemoryMB} MB`,
            memoryThresholds: {
                critical: `${this.config.criticalMemoryThreshold}%`,
                warning: `${this.config.warningMemoryThreshold}%`,
                healthy: `${this.config.healthyMemoryThreshold}%`
            },
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Start periodic memory monitoring
     * @returns {boolean} True if monitoring started, false if already running
     */
    startMonitoring() {
        if (this.monitoringInterval) {
            return false;
        }

        this.monitoringInterval = setInterval(() => {
            this.updateSystemMemory();

            // Check if we need to trigger garbage collection
            if (this.shouldTriggerGC()) {
                this.triggerGarbageCollection();
            }
        }, this.config.monitoringInterval);

        this.logger.info({
            message: 'Memory monitoring started',
            interval: `${this.config.monitoringInterval}ms`,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Stop memory monitoring
     * @returns {boolean} True if monitoring stopped, false if not running
     */
    stopMonitoring() {
        if (!this.monitoringInterval) {
            return false;
        }

        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;

        this.logger.info({
            message: 'Memory monitoring stopped',
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Update system memory information
     * @returns {Object} Current memory metrics
     */
    updateSystemMemory() {
        // Get system memory information
        this.totalSystemMemoryMB = Math.floor(this.os.totalmem() / (1024 * 1024));
        this.availableMemoryMB = Math.floor(this.os.freemem() / (1024 * 1024));
        this.usedMemoryMB = this.totalSystemMemoryMB - this.availableMemoryMB;
        this.memoryUsagePercent = Math.floor((this.usedMemoryMB / this.totalSystemMemoryMB) * 100);

        // Update memory state
        this.lastMemoryCheckTime = Date.now();
        this.updateMemoryState();

        // Add to history
        this.addToMemoryHistory({
            timestamp: this.lastMemoryCheckTime,
            totalMemoryMB: this.totalSystemMemoryMB,
            availableMemoryMB: this.availableMemoryMB,
            usedMemoryMB: this.usedMemoryMB,
            usagePercent: this.memoryUsagePercent,
            state: this.currentMemoryState,
            activeRequests: this.activeRequests.size,
            processMemory: process.memoryUsage()
        });

        // Return current metrics
        return this.getCurrentMemoryUsage();
    }

    /**
     * Update the current memory state based on thresholds
     */
    updateMemoryState() {
        const oldState = this.currentMemoryState;

        // Determine new state based on memory usage percentage
        if (this.memoryUsagePercent >= this.config.criticalMemoryThreshold) {
            this.currentMemoryState = 'critical';
        } else if (this.memoryUsagePercent >= this.config.warningMemoryThreshold) {
            this.currentMemoryState = 'warning';
        } else if (this.memoryUsagePercent <= this.config.healthyMemoryThreshold) {
            this.currentMemoryState = 'healthy';
        } else {
            this.currentMemoryState = 'normal';
        }

        // Log state transitions
        if (oldState !== this.currentMemoryState) {
            this.logger.info({
                message: 'Memory state changed',
                previousState: oldState,
                newState: this.currentMemoryState,
                memoryUsage: `${this.memoryUsagePercent}%`,
                availableMemory: `${this.availableMemoryMB} MB`,
                activeRequests: this.activeRequests.size,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Add an entry to memory history
     * @param {Object} entry - Memory metrics entry
     */
    addToMemoryHistory(entry) {
        this.memoryHistory.push(entry);

        // Maintain maximum history length
        if (this.memoryHistory.length > this.historyMaxLength) {
            this.memoryHistory.shift();
        }
    }

    /**
     * Get current memory usage metrics
     * @returns {Object} Current memory metrics
     */
    getCurrentMemoryUsage() {
        return {
            totalMemoryMB: this.totalSystemMemoryMB,
            availableMemoryMB: this.availableMemoryMB,
            usedMemoryMB: this.usedMemoryMB,
            usagePercent: this.memoryUsagePercent,
            state: this.currentMemoryState,
            processMemory: {
                rss: Math.floor(process.memoryUsage().rss / (1024 * 1024)),
                heapTotal: Math.floor(process.memoryUsage().heapTotal / (1024 * 1024)),
                heapUsed: Math.floor(process.memoryUsage().heapUsed / (1024 * 1024)),
                external: Math.floor(process.memoryUsage().external / (1024 * 1024))
            },
            activeRequests: this.activeRequests.size,
            lastUpdated: this.lastMemoryCheckTime
        };
    }

    /**
     * Get memory history for analysis
     * @param {number} limit - Maximum number of entries to return
     * @returns {Array} Memory history entries
     */
    getMemoryHistory(limit = this.historyMaxLength) {
        return this.memoryHistory.slice(-limit);
    }

    /**
     * Determine if garbage collection should be triggered
     * @returns {boolean} True if GC should be triggered
     */
    shouldTriggerGC() {
        // Check if memory usage exceeds the GC trigger threshold
        if (this.memoryUsagePercent < this.config.gcTriggerThreshold) {
            return false;
        }

        // Check cooldown period
        const now = Date.now();
        if (now - this.lastGCTime < this.config.gcCooldownPeriod) {
            return false;
        }

        // We should trigger GC
        return true;
    }

    /**
     * Trigger manual garbage collection
     * @returns {boolean} True if GC was triggered
     */
    triggerGarbageCollection() {
        // Don't trigger if GC is not available
        if (typeof global.gc !== 'function') {
            this.logger.warn({
                message: 'Manual garbage collection not available',
                resolution: 'Run Node.js with --expose-gc flag',
                timestamp: new Date().toISOString()
            });
            return false;
        }

        // Track memory before GC
        const memoryBefore = process.memoryUsage();

        // Trigger garbage collection
        this.logger.info({
            message: 'Triggering manual garbage collection',
            memoryUsage: `${this.memoryUsagePercent}%`,
            heapUsedMB: Math.floor(memoryBefore.heapUsed / (1024 * 1024)),
            timestamp: new Date().toISOString()
        });

        global.gc();

        // Update timestamp and count
        this.lastGCTime = Date.now();
        this.gcCount++;

        // Measure impact
        const memoryAfter = process.memoryUsage();
        const freedMemoryMB = Math.floor((memoryBefore.heapUsed - memoryAfter.heapUsed) / (1024 * 1024));

        // Force memory update
        this.updateSystemMemory();

        this.logger.info({
            message: 'Garbage collection completed',
            freedMemoryMB,
            durationMs: Date.now() - this.lastGCTime,
            newHeapUsedMB: Math.floor(memoryAfter.heapUsed / (1024 * 1024)),
            newMemoryUsage: `${this.memoryUsagePercent}%`,
            gcCount: this.gcCount,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Get memory requirement for a specific model
     * @param {string} modelId - Model identifier
     * @returns {number} Memory requirement in MB
     */
    getModelMemoryRequirement(modelId) {
        // Look up model-specific memory requirement
        if (this.config.modelMemoryRequirements[modelId]) {
            return this.config.modelMemoryRequirements[modelId];
        }

        // Use default if not specified
        return this.config.modelMemoryRequirements.default;
    }

    /**
     * Estimate memory requirement for a request
     * @param {string} modelId - Model identifier
     * @param {Object} requestData - Request data
     * @returns {number} Estimated memory requirement in MB
     */
    estimateRequestMemory(modelId, requestData) {
        // Base memory requirement for the model
        const baseModelMemory = this.getModelMemoryRequirement(modelId);

        // Estimate memory based on prompt size
        let promptTokens = 0;

        // Determine token count from different request types
        if (requestData.prompt) {
            // For /generate endpoint
            promptTokens = this.estimateTokenCount(requestData.prompt);
        } else if (requestData.messages) {
            // For /chat endpoint
            promptTokens = this.estimateChatTokens(requestData.messages, requestData.system);
        }

        // Calculate additional memory based on token count
        const tokenMemory = Math.ceil(promptTokens / 1000) * this.config.memoryPerKiloTokenMB;

        // Add buffer for response tokens (assume 2x prompt tokens as a rough estimate)
        const responseTokenMemory = tokenMemory * 2;

        // Total estimated memory
        const totalEstimatedMemory = baseModelMemory + tokenMemory + responseTokenMemory;

        // Cap at configured maximum
        return Math.min(totalEstimatedMemory, this.config.maxRequestMemoryMB);
    }

    /**
     * Estimate token count for text
     * @param {string} text - Text to estimate tokens for
     * @returns {number} Estimated token count
     */
    estimateTokenCount(text) {
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
    estimateChatTokens(messages, system) {
        let count = 0;

        // Count system prompt tokens
        if (system) {
            count += this.estimateTokenCount(system);
        }

        // Count message tokens
        if (Array.isArray(messages)) {
            for (const message of messages) {
                if (message.content) {
                    count += this.estimateTokenCount(message.content);
                }
            }
        }

        return count;
    }

    /**
     * Check if there's enough memory to process a request
     * @param {string} modelId - Model identifier
     * @param {Object} requestData - Request data
     * @returns {Object} Result with allowed status and reason
     */
    canProcessRequest(modelId, requestData) {
        // Update memory information
        this.updateSystemMemory();

        // Calculate estimated memory requirement
        const estimatedMemoryMB = this.estimateRequestMemory(modelId, requestData);

        // Calculate available memory after accounting for reserved memory
        const effectiveAvailableMemory = this.availableMemoryMB - this.config.reservedSystemMemoryMB;

        // Check if we're in a critical memory state
        if (this.currentMemoryState === 'critical') {
            return {
                allowed: false,
                reason: 'System is in critical memory state',
                memoryNeeded: estimatedMemoryMB,
                memoryAvailable: effectiveAvailableMemory,
                memoryState: this.currentMemoryState
            };
        }

        // Check if the request exceeds available memory
        if (estimatedMemoryMB > effectiveAvailableMemory) {
            return {
                allowed: false,
                reason: 'Insufficient memory for request',
                memoryNeeded: estimatedMemoryMB,
                memoryAvailable: effectiveAvailableMemory,
                memoryState: this.currentMemoryState
            };
        }

        // Request is allowed
        return {
            allowed: true,
            reason: 'Sufficient memory available',
            memoryNeeded: estimatedMemoryMB,
            memoryAvailable: effectiveAvailableMemory,
            memoryState: this.currentMemoryState
        };
    }

    /**
     * Start tracking memory for a request
     * @param {string} requestId - Request identifier
     * @param {string} modelId - Model identifier
     * @param {Object} requestData - Request data
     * @returns {Object} Tracking information
     */
    trackRequestMemory(requestId, modelId, requestData) {
        // Estimate memory requirement
        const estimatedMemoryMB = this.estimateRequestMemory(modelId, requestData);

        // Check if we need to apply limits based on memory state
        let maxTokens = null;

        if (this.currentMemoryState === 'warning') {
            // In warning state, limit token generation to 75% of what the model would normally allow
            maxTokens = requestData.options?.max_tokens
                ? Math.floor(requestData.options.max_tokens * 0.75)
                : 1024; // Default fallback
            this.limitedRequests++;
        }

        // Create tracking entry
        const trackingInfo = {
            requestId,
            modelId,
            startTime: Date.now(),
            estimatedMemoryMB,
            maxTokens,
            originalMaxTokens: requestData.options?.max_tokens,
            memoryState: this.currentMemoryState
        };

        // Store tracking information
        this.activeRequests.set(requestId, trackingInfo);

        // Update counters
        this.totalRequests++;

        this.logger.debug({
            message: 'Request memory tracking started',
            requestId,
            modelId,
            estimatedMemoryMB,
            maxTokens: maxTokens !== null ? maxTokens : 'unlimited',
            activeRequests: this.activeRequests.size,
            memoryState: this.currentMemoryState,
            timestamp: new Date().toISOString()
        });

        return trackingInfo;
    }

    /**
     * Release memory tracking for a completed request
     * @param {string} requestId - Request identifier
     * @returns {Object|null} Request tracking info or null if not found
     */
    releaseRequestMemory(requestId) {
        // Check if request is being tracked
        if (!this.activeRequests.has(requestId)) {
            return null;
        }

        // Get tracking info
        const trackingInfo = this.activeRequests.get(requestId);

        // Remove from active requests
        this.activeRequests.delete(requestId);

        // Update duration
        trackingInfo.endTime = Date.now();
        trackingInfo.durationMs = trackingInfo.endTime - trackingInfo.startTime;

        this.logger.debug({
            message: 'Request memory tracking released',
            requestId,
            modelId: trackingInfo.modelId,
            durationMs: trackingInfo.durationMs,
            activeRequests: this.activeRequests.size,
            memoryState: this.currentMemoryState,
            timestamp: new Date().toISOString()
        });

        // Maybe trigger garbage collection if we're in warning or critical state
        if (this.currentMemoryState === 'warning' || this.currentMemoryState === 'critical') {
            if (this.shouldTriggerGC()) {
                this.triggerGarbageCollection();
            }
        }

        return trackingInfo;
    }

    /**
     * Calculate maximum safe token limit based on available memory
     * @param {string} modelId - Model identifier
     * @returns {number} Maximum safe token limit
     */
    getMaxTokensForModel(modelId) {
        // Update memory information
        this.updateSystemMemory();

        // Base model memory requirement
        const baseModelMemory = this.getModelMemoryRequirement(modelId);

        // Calculate available memory for tokens
        const memoryForTokens = Math.max(0, this.availableMemoryMB -
            this.config.reservedSystemMemoryMB -
            baseModelMemory);

        // Calculate max tokens based on memory per token
        const maxTokens = Math.floor((memoryForTokens / this.config.memoryPerKiloTokenMB) * 1000);

        // Apply scaling based on memory state
        let scalingFactor = 1.0;

        if (this.currentMemoryState === 'critical') {
            scalingFactor = 0.5; // 50% of normal
        } else if (this.currentMemoryState === 'warning') {
            scalingFactor = 0.75; // 75% of normal
        }

        return Math.max(256, Math.floor(maxTokens * scalingFactor));
    }

    /**
     * Calculate maximum concurrent requests based on memory
     * @param {string} modelId - Model identifier
     * @returns {number} Recommended concurrent requests
     */
    getMaxConcurrentRequestsForModel(modelId) {
        // Update memory information
        this.updateSystemMemory();

        // Get model memory requirement
        const modelMemory = this.getModelMemoryRequirement(modelId);

        // Calculate available memory after accounting for reserved memory
        const effectiveAvailableMemory = Math.max(0, this.availableMemoryMB - this.config.reservedSystemMemoryMB);

        // Calculate max concurrent requests
        const maxRequests = Math.floor(effectiveAvailableMemory / modelMemory);

        // Apply scaling based on memory state
        let scalingFactor = 1.0;

        if (this.currentMemoryState === 'critical') {
            scalingFactor = 0.5; // 50% of normal
        } else if (this.currentMemoryState === 'warning') {
            scalingFactor = 0.75; // 75% of normal
        }

        return Math.max(1, Math.floor(maxRequests * scalingFactor));
    }

    /**
     * Check if system is in critical memory state
     * @returns {boolean} True if in critical state
     */
    isCriticalMemoryState() {
        this.updateSystemMemory();
        return this.currentMemoryState === 'critical';
    }

    /**
     * Apply memory-based constraints to a request
     * @param {Object} requestData - Original request data
     * @param {string} modelId - Model identifier
     * @returns {Object} Modified request data with constraints
     */
    applyMemoryConstraints(requestData, modelId) {
        // Create a copy of the request data
        const modifiedRequest = JSON.parse(JSON.stringify(requestData));

        // Determine max tokens based on memory state
        const safeMaxTokens = this.getMaxTokensForModel(modelId);

        // Ensure options object exists
        if (!modifiedRequest.options) {
            modifiedRequest.options = {};
        }

        // Set max_tokens if not set or if current value exceeds safe limit
        if (!modifiedRequest.options.max_tokens ||
            modifiedRequest.options.max_tokens > safeMaxTokens) {

            // Store original value if it exists
            const originalMaxTokens = modifiedRequest.options.max_tokens;

            // Set new value
            modifiedRequest.options.max_tokens = safeMaxTokens;

            // Log the constraint
            if (originalMaxTokens) {
                this.logger.info({
                    message: 'Applied memory-based token constraint',
                    modelId,
                    originalMaxTokens,
                    newMaxTokens: safeMaxTokens,
                    memoryState: this.currentMemoryState,
                    timestamp: new Date().toISOString()
                });

                this.limitedRequests++;
            }
        }

        return modifiedRequest;
    }

    /**
     * Get detailed memory statistics
     * @returns {Object} Detailed memory statistics
     */
    getMemoryStats() {
        return {
            current: this.getCurrentMemoryUsage(),
            limits: {
                criticalThreshold: this.config.criticalMemoryThreshold,
                warningThreshold: this.config.warningMemoryThreshold,
                healthyThreshold: this.config.healthyMemoryThreshold,
                reservedSystemMemoryMB: this.config.reservedSystemMemoryMB,
                maxRequestMemoryMB: this.config.maxRequestMemoryMB
            },
            activeRequests: {
                count: this.activeRequests.size,
                details: Array.from(this.activeRequests.values()).map(req => ({
                    requestId: req.requestId,
                    modelId: req.modelId,
                    estimatedMemoryMB: req.estimatedMemoryMB,
                    durationMs: Date.now() - req.startTime
                }))
            },
            modelMemorySettings: this.config.modelMemoryRequirements,
            counters: {
                totalRequests: this.totalRequests,
                rejectedRequests: this.rejectedRequests,
                limitedRequests: this.limitedRequests,
                gcCount: this.gcCount
            },
            gcSettings: {
                gcTriggerThreshold: this.config.gcTriggerThreshold,
                gcCooldownPeriod: this.config.gcCooldownPeriod,
                lastGCTime: this.lastGCTime > 0 ? new Date(this.lastGCTime).toISOString() : 'never'
            }
        };
    }

    /**
     * Update model memory requirements
     * @param {Object} modelRequirements - New memory requirements by model
     * @returns {boolean} True if settings were updated
     */
    updateModelMemoryRequirements(modelRequirements) {
        if (!modelRequirements || typeof modelRequirements !== 'object') {
            return false;
        }

        // Backup current settings
        const oldSettings = { ...this.config.modelMemoryRequirements };

        // Update settings
        this.config.modelMemoryRequirements = {
            ...this.config.modelMemoryRequirements,
            ...modelRequirements
        };

        this.logger.info({
            message: 'Model memory requirements updated',
            oldSettings,
            newSettings: this.config.modelMemoryRequirements,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Forecast memory usage based on queue
     * @param {Array} queuedRequests - Array of queued requests with models
     * @returns {Object} Forecasted memory usage
     */
    getForecastedMemoryUsage(queuedRequests) {
        // Current memory usage
        const currentUsage = this.getCurrentMemoryUsage();

        // Calculate additional memory needed for queued requests
        let additionalMemoryMB = 0;
        const requestForecasts = [];

        if (Array.isArray(queuedRequests) && queuedRequests.length > 0) {
            queuedRequests.forEach(req => {
                const modelMemory = this.getModelMemoryRequirement(req.model);
                additionalMemoryMB += modelMemory;

                requestForecasts.push({
                    modelId: req.model,
                    estimatedMemoryMB: modelMemory
                });
            });
        }

        // Calculate forecasted totals
        const forecastedUsedMemoryMB = this.usedMemoryMB + additionalMemoryMB;
        const forecastedAvailableMemoryMB = this.totalSystemMemoryMB - forecastedUsedMemoryMB;
        const forecastedUsagePercent = Math.floor((forecastedUsedMemoryMB / this.totalSystemMemoryMB) * 100);

        // Determine forecasted state
        let forecastedState = 'healthy';
        if (forecastedUsagePercent >= this.config.criticalMemoryThreshold) {
            forecastedState = 'critical';
        } else if (forecastedUsagePercent >= this.config.warningMemoryThreshold) {
            forecastedState = 'warning';
        } else if (forecastedUsagePercent <= this.config.healthyMemoryThreshold) {
            forecastedState = 'healthy';
        } else {
            forecastedState = 'normal';
        }

        return {
            current: currentUsage,
            forecasted: {
                usedMemoryMB: forecastedUsedMemoryMB,
                availableMemoryMB: forecastedAvailableMemoryMB,
                usagePercent: forecastedUsagePercent,
                state: forecastedState,
                additionalMemoryMB,
                queuedRequests: queuedRequests.length,
                requestForecasts
            }
        };
    }
}

module.exports = MemoryManager;