/**
 * CircuitBreaker - Monitors API call failures and implements circuit breaking pattern
 *
 * This class tracks success/failure rates for API calls and implements the circuit breaker
 * pattern to prevent cascading failures when the Ollama service is experiencing issues.
 */
class CircuitBreaker {
    /**
     * Circuit breaker states
     * @readonly
     * @enum {string}
     */
    static States = {
        CLOSED: 'closed',       // Normal operation, requests flow through
        OPEN: 'open',           // Circuit is open, requests fail fast
        HALF_OPEN: 'half-open'  // Testing if service is recovered
    };

    /**
     * Constructor for CircuitBreaker
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            // Error threshold percentage to trip the circuit (default: 50%)
            errorThresholdPercentage: config.errorThresholdPercentage || 50,

            // Minimum number of requests before the circuit can trip (default: 5)
            requestVolumeThreshold: config.requestVolumeThreshold || 5,

            // How long to wait before trying half-open state (default: 30 seconds)
            resetTimeout: config.resetTimeout || 30000,

            // Number of successful requests required to close circuit (default: 3)
            successThreshold: config.successThreshold || 3,

            // Time window for calculating error rates (default: 60 seconds)
            rollingWindow: config.rollingWindow || 60000,

            // Whether to track metrics by model (default: true)
            trackByModel: config.trackByModel !== undefined ? config.trackByModel : true,

            // Logger instance
            logger: config.logger || console,

            ...config
        };

        // Current circuit state
        this.state = CircuitBreaker.States.CLOSED;

        // Timestamps for state transitions
        this.lastStateChange = Date.now();
        this.nextAttemptTime = 0;

        // Global request tracking
        this.requestCount = 0;
        this.failureCount = 0;
        this.successCount = 0;
        this.consecutiveSuccesses = 0;

        // Model-specific tracking
        this.modelCircuits = new Map();

        // Rolling window tracking
        this.requestHistory = [];

        // Circuit state change handlers
        this.stateChangeHandlers = [];

        // Internal timer for cleanup
        this.cleanupInterval = setInterval(() => {
            this.cleanupHistory();
        }, 10000); // Every 10 seconds

        this.config.logger.info({
            message: 'CircuitBreaker initialized',
            initialState: this.state,
            errorThreshold: `${this.config.errorThresholdPercentage}%`,
            requestVolumeThreshold: this.config.requestVolumeThreshold,
            resetTimeout: `${this.config.resetTimeout}ms`,
            trackByModel: this.config.trackByModel,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Add state change handler
     * @param {Function} handler - Handler function(fromState, toState, timestamp)
     * @returns {number} Handler index for removal
     */
    onStateChange(handler) {
        if (typeof handler === 'function') {
            return this.stateChangeHandlers.push(handler) - 1;
        }
        return -1;
    }

    /**
     * Remove state change handler
     * @param {number} index - Handler index returned from onStateChange
     * @returns {boolean} Success indicator
     */
    removeStateChangeHandler(index) {
        if (index >= 0 && index < this.stateChangeHandlers.length) {
            this.stateChangeHandlers.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Trigger state change handlers
     * @param {string} fromState - Previous state
     * @param {string} toState - New state
     * @param {number} timestamp - Time of change
     * @private
     */
    triggerStateChangeHandlers(fromState, toState, timestamp) {
        for (const handler of this.stateChangeHandlers) {
            try {
                handler(fromState, toState, timestamp);
            } catch (error) {
                this.config.logger.warn({
                    message: 'Error in circuit breaker state change handler',
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    /**
     * Change circuit state
     * @param {string} newState - New state for the circuit
     * @param {Object} metadata - Additional information about the state change
     * @private
     */
    changeState(newState, metadata = {}) {
        if (this.state === newState) {
            return; // No change
        }

        const prevState = this.state;
        const timestamp = Date.now();

        this.state = newState;
        this.lastStateChange = timestamp;

        // Reset counters on state change
        if (newState === CircuitBreaker.States.HALF_OPEN) {
            this.consecutiveSuccesses = 0;
            this.nextAttemptTime = timestamp;
        } else if (newState === CircuitBreaker.States.CLOSED) {
            this.failureCount = 0;
            this.successCount = 0;
            this.requestCount = 0;
            this.consecutiveSuccesses = 0;
            this.requestHistory = [];
        } else if (newState === CircuitBreaker.States.OPEN) {
            this.nextAttemptTime = timestamp + this.config.resetTimeout;
        }

        // Log state change
        this.config.logger.info({
            message: 'Circuit breaker state changed',
            prevState,
            newState,
            lastFailureRate: this.getErrorRate(),
            lastRequestCount: this.requestCount,
            model: metadata.model || 'global',
            reason: metadata.reason || 'unspecified',
            timestamp: new Date(timestamp).toISOString()
        });

        // Trigger handlers
        this.triggerStateChangeHandlers(prevState, newState, timestamp);
    }

    /**
     * Record successful request
     * @param {string} modelId - Optional model identifier
     */
    recordSuccess(modelId = null) {
        // Update global counters
        this.successCount++;
        this.requestCount++;

        // Add to request history
        this.requestHistory.push({
            timestamp: Date.now(),
            success: true,
            modelId
        });

        // Update model-specific circuit if tracked
        if (modelId && this.config.trackByModel) {
            const modelCircuit = this.getModelCircuit(modelId);
            modelCircuit.successCount++;
            modelCircuit.requestCount++;
            modelCircuit.consecutiveSuccesses++;

            // Check if we should close this model's circuit
            if (modelCircuit.state === CircuitBreaker.States.HALF_OPEN &&
                modelCircuit.consecutiveSuccesses >= this.config.successThreshold) {
                this.closeModelCircuit(modelId, { reason: 'consecutive_successes' });
            }
        }

        // In half-open state, track consecutive successes
        if (this.state === CircuitBreaker.States.HALF_OPEN) {
            this.consecutiveSuccesses++;

            // If we've had enough consecutive successes, close the circuit
            if (this.consecutiveSuccesses >= this.config.successThreshold) {
                this.changeState(CircuitBreaker.States.CLOSED, {
                    reason: 'consecutive_successes'
                });
            }
        }
    }

    /**
     * Record failed request
     * @param {string} modelId - Optional model identifier
     * @param {Object} error - Error information
     */
    recordFailure(modelId = null, error = null) {
        // Update global counters
        this.failureCount++;
        this.requestCount++;

        // Add to request history
        this.requestHistory.push({
            timestamp: Date.now(),
            success: false,
            modelId,
            error: error ? error.message : 'unknown error'
        });

        // Reset consecutive successes counter
        this.consecutiveSuccesses = 0;

        // Update model-specific circuit if tracked
        if (modelId && this.config.trackByModel) {
            const modelCircuit = this.getModelCircuit(modelId);
            modelCircuit.failureCount++;
            modelCircuit.requestCount++;
            modelCircuit.consecutiveSuccesses = 0;

            // Check if we should open this model's circuit
            this.checkOpenModelCircuit(modelId);
        }

        // In half-open state, a single failure reopens the circuit
        if (this.state === CircuitBreaker.States.HALF_OPEN) {
            this.changeState(CircuitBreaker.States.OPEN, {
                reason: 'failure_during_half_open',
                error: error ? error.message : 'unknown error'
            });
            return;
        }

        // In closed state, check if we should open the circuit
        if (this.state === CircuitBreaker.States.CLOSED) {
            this.checkStateTransition();
        }
    }

    /**
     * Check if the circuit should change state
     * @private
     */
    checkStateTransition() {
        if (this.state === CircuitBreaker.States.OPEN) {
            // Check if it's time to try half-open
            if (Date.now() >= this.nextAttemptTime) {
                this.changeState(CircuitBreaker.States.HALF_OPEN, {
                    reason: 'timeout_elapsed'
                });
            }
            return;
        }

        if (this.state === CircuitBreaker.States.CLOSED) {
            // Check if we should open the circuit based on error rate
            const errorRate = this.getErrorRate();

            if (this.requestCount >= this.config.requestVolumeThreshold &&
                errorRate >= this.config.errorThresholdPercentage) {
                this.changeState(CircuitBreaker.States.OPEN, {
                    reason: 'error_threshold_exceeded',
                    errorRate: `${errorRate}%`,
                    threshold: `${this.config.errorThresholdPercentage}%`
                });
            }
        }
    }

    /**
     * Get the current error rate percentage
     * @returns {number} Error rate percentage
     */
    getErrorRate() {
        if (this.requestCount === 0) return 0;
        return (this.failureCount / this.requestCount) * 100;
    }

    /**
     * Get or create a model-specific circuit
     * @param {string} modelId - Model identifier
     * @returns {Object} Model circuit state
     * @private
     */
    getModelCircuit(modelId) {
        if (!this.modelCircuits.has(modelId)) {
            this.modelCircuits.set(modelId, {
                state: CircuitBreaker.States.CLOSED,
                requestCount: 0,
                failureCount: 0,
                successCount: 0,
                consecutiveSuccesses: 0,
                lastStateChange: Date.now(),
                nextAttemptTime: 0
            });
        }

        return this.modelCircuits.get(modelId);
    }

    /**
     * Check if a model-specific circuit should be opened
     * @param {string} modelId - Model identifier
     * @private
     */
    checkOpenModelCircuit(modelId) {
        const circuit = this.getModelCircuit(modelId);

        if (circuit.state !== CircuitBreaker.States.CLOSED) return;

        const errorRate = circuit.requestCount > 0 ?
            (circuit.failureCount / circuit.requestCount) * 100 : 0;

        if (circuit.requestCount >= this.config.requestVolumeThreshold &&
            errorRate >= this.config.errorThresholdPercentage) {
            this.openModelCircuit(modelId, {
                reason: 'error_threshold_exceeded',
                errorRate: `${errorRate}%`
            });
        }
    }

    /**
     * Open a model-specific circuit
     * @param {string} modelId - Model identifier
     * @param {Object} metadata - Additional information
     * @private
     */
    openModelCircuit(modelId, metadata = {}) {
        const circuit = this.getModelCircuit(modelId);

        if (circuit.state === CircuitBreaker.States.OPEN) return;

        const timestamp = Date.now();
        const prevState = circuit.state;

        circuit.state = CircuitBreaker.States.OPEN;
        circuit.lastStateChange = timestamp;
        circuit.nextAttemptTime = timestamp + this.config.resetTimeout;

        this.config.logger.info({
            message: 'Model circuit opened',
            modelId,
            prevState,
            errorRate: this.getModelErrorRate(modelId),
            requestCount: circuit.requestCount,
            reason: metadata.reason || 'unspecified',
            timestamp: new Date(timestamp).toISOString()
        });
    }

    /**
     * Close a model-specific circuit
     * @param {string} modelId - Model identifier
     * @param {Object} metadata - Additional information
     * @private
     */
    closeModelCircuit(modelId, metadata = {}) {
        const circuit = this.getModelCircuit(modelId);

        if (circuit.state === CircuitBreaker.States.CLOSED) return;

        const timestamp = Date.now();
        const prevState = circuit.state;

        circuit.state = CircuitBreaker.States.CLOSED;
        circuit.lastStateChange = timestamp;
        circuit.failureCount = 0;
        circuit.successCount = 0;
        circuit.requestCount = 0;
        circuit.consecutiveSuccesses = 0;

        this.config.logger.info({
            message: 'Model circuit closed',
            modelId,
            prevState,
            reason: metadata.reason || 'unspecified',
            timestamp: new Date(timestamp).toISOString()
        });
    }

    /**
     * Set model circuit to half-open state
     * @param {string} modelId - Model identifier
     * @private
     */
    halfOpenModelCircuit(modelId) {
        const circuit = this.getModelCircuit(modelId);

        if (circuit.state !== CircuitBreaker.States.OPEN) return;

        const timestamp = Date.now();

        circuit.state = CircuitBreaker.States.HALF_OPEN;
        circuit.lastStateChange = timestamp;
        circuit.nextAttemptTime = timestamp;
        circuit.consecutiveSuccesses = 0;

        this.config.logger.info({
            message: 'Model circuit half-opened',
            modelId,
            timestamp: new Date(timestamp).toISOString()
        });
    }

    /**
     * Get model-specific error rate
     * @param {string} modelId - Model identifier
     * @returns {number} Error rate percentage
     */
    getModelErrorRate(modelId) {
        const circuit = this.getModelCircuit(modelId);

        if (circuit.requestCount === 0) return 0;
        return (circuit.failureCount / circuit.requestCount) * 100;
    }

    /**
     * Check if the circuit is open
     * @returns {boolean} True if circuit is open
     */
    isOpen() {
        return this.state === CircuitBreaker.States.OPEN;
    }

    /**
     * Check if the circuit is closed
     * @returns {boolean} True if circuit is closed
     */
    isClosed() {
        return this.state === CircuitBreaker.States.CLOSED;
    }

    /**
     * Check if the circuit is half-open
     * @returns {boolean} True if circuit is half-open
     */
    isHalfOpen() {
        return this.state === CircuitBreaker.States.HALF_OPEN;
    }

    /**
     * Check the state of a model-specific circuit
     * @param {string} modelId - Model identifier
     * @returns {string} Circuit state
     */
    getModelState(modelId) {
        if (!this.config.trackByModel || !this.modelCircuits.has(modelId)) {
            return this.state; // Use global state
        }

        return this.modelCircuits.get(modelId).state;
    }

    /**
     * Execute a function with circuit breaker protection
     * @param {Function} func - Function to execute
     * @param {Object} options - Options for execution
     * @returns {Promise} Promise that resolves with the function result or rejects with CircuitOpenError
     */
    async execute(func, options = {}) {
        const modelId = options.modelId || null;

        // Update circuit state
        this.checkStateTransition();

        // For model-specific tracking, check model circuit
        if (modelId && this.config.trackByModel) {
            const modelCircuit = this.getModelCircuit(modelId);

            // Check if model-specific circuit is open
            if (modelCircuit.state === CircuitBreaker.States.OPEN) {
                // Check if reset timeout has elapsed
                if (Date.now() >= modelCircuit.nextAttemptTime) {
                    this.halfOpenModelCircuit(modelId);
                } else {
                    const error = new CircuitOpenError(
                        `Circuit for model '${modelId}' is open`,
                        { modelId, nextAttemptTime: modelCircuit.nextAttemptTime }
                    );

                    this.config.logger.warn({
                        message: 'Request rejected: model circuit open',
                        modelId,
                        nextAttempt: new Date(modelCircuit.nextAttemptTime).toISOString(),
                        timestamp: new Date().toISOString()
                    });

                    throw error;
                }
            }
        }

        // Check if main circuit is open
        if (this.state === CircuitBreaker.States.OPEN) {
            // Check if reset timeout has elapsed
            if (Date.now() >= this.nextAttemptTime) {
                this.changeState(CircuitBreaker.States.HALF_OPEN, {
                    reason: 'timeout_elapsed'
                });
            } else {
                const error = new CircuitOpenError('Circuit is open', {
                    nextAttemptTime: this.nextAttemptTime
                });

                this.config.logger.warn({
                    message: 'Request rejected: circuit open',
                    nextAttempt: new Date(this.nextAttemptTime).toISOString(),
                    modelId: modelId || 'unknown',
                    timestamp: new Date().toISOString()
                });

                throw error;
            }
        }

        // If we're in half-open state, ensure we don't exceed concurrency
        if (this.state === CircuitBreaker.States.HALF_OPEN &&
            this.consecutiveSuccesses >= this.config.successThreshold) {
            this.changeState(CircuitBreaker.States.CLOSED, {
                reason: 'success_threshold_reached'
            });
        }

        try {
            // Execute the function
            const result = await func();

            // Record success
            this.recordSuccess(modelId);

            return result;
        } catch (error) {
            // Record failure
            this.recordFailure(modelId, error);

            // Re-throw the original error
            throw error;
        }
    }

    /**
     * Manually open the circuit
     * @param {Object} options - Options for the operation
     * @returns {boolean} Success indicator
     */
    forceOpen(options = {}) {
        const modelId = options.modelId;
        const timeout = options.timeout || this.config.resetTimeout;

        if (modelId && this.config.trackByModel) {
            const circuit = this.getModelCircuit(modelId);

            circuit.state = CircuitBreaker.States.OPEN;
            circuit.lastStateChange = Date.now();
            circuit.nextAttemptTime = Date.now() + timeout;

            this.config.logger.info({
                message: 'Circuit manually opened for model',
                modelId,
                timeout: `${timeout}ms`,
                timestamp: new Date().toISOString()
            });

            return true;
        } else {
            this.changeState(CircuitBreaker.States.OPEN, {
                reason: 'manual_open',
                timeout: `${timeout}ms`
            });
            this.nextAttemptTime = Date.now() + timeout;

            return true;
        }
    }

    /**
     * Manually close the circuit
     * @param {Object} options - Options for the operation
     * @returns {boolean} Success indicator
     */
    forceClose(options = {}) {
        const modelId = options.modelId;

        if (modelId && this.config.trackByModel) {
            this.closeModelCircuit(modelId, { reason: 'manual_close' });
            return true;
        } else {
            this.changeState(CircuitBreaker.States.CLOSED, {
                reason: 'manual_close'
            });
            return true;
        }
    }

    /**
     * Reset the circuit to initial state
     * @param {Object} options - Options for the operation
     * @returns {boolean} Success indicator
     */
    reset(options = {}) {
        const modelId = options.modelId;

        if (modelId && this.config.trackByModel) {
            const circuit = this.getModelCircuit(modelId);
            circuit.state = CircuitBreaker.States.CLOSED;
            circuit.lastStateChange = Date.now();
            circuit.failureCount = 0;
            circuit.successCount = 0;
            circuit.requestCount = 0;
            circuit.consecutiveSuccesses = 0;

            this.config.logger.info({
                message: 'Circuit reset for model',
                modelId,
                timestamp: new Date().toISOString()
            });

            return true;
        } else {
            // Reset global circuit
            this.state = CircuitBreaker.States.CLOSED;
            this.lastStateChange = Date.now();
            this.failureCount = 0;
            this.successCount = 0;
            this.requestCount = 0;
            this.consecutiveSuccesses = 0;
            this.requestHistory = [];

            // Reset all model circuits
            for (const [modelId, circuit] of this.modelCircuits.entries()) {
                circuit.state = CircuitBreaker.States.CLOSED;
                circuit.lastStateChange = Date.now();
                circuit.failureCount = 0;
                circuit.successCount = 0;
                circuit.requestCount = 0;
                circuit.consecutiveSuccesses = 0;
            }

            this.config.logger.info({
                message: 'All circuits reset',
                timestamp: new Date().toISOString()
            });

            return true;
        }
    }

    /**
     * Clean up old request history items
     * @private
     */
    cleanupHistory() {
        const cutoffTime = Date.now() - this.config.rollingWindow;

        // Remove old requests from history
        this.requestHistory = this.requestHistory.filter(req => req.timestamp >= cutoffTime);

        // Recalculate counters based on history
        this.recalculateCounters();
    }

    /**
     * Recalculate request counters based on filtered history
     * @private
     */
    recalculateCounters() {
        // Reset counters
        this.requestCount = this.requestHistory.length;
        this.successCount = this.requestHistory.filter(req => req.success).length;
        this.failureCount = this.requestCount - this.successCount;

        // Reset model counters
        if (this.config.trackByModel) {
            const modelCounts = new Map();

            // Count by model
            for (const req of this.requestHistory) {
                if (!req.modelId) continue;

                if (!modelCounts.has(req.modelId)) {
                    modelCounts.set(req.modelId, {
                        requestCount: 0,
                        successCount: 0,
                        failureCount: 0
                    });
                }

                const counts = modelCounts.get(req.modelId);
                counts.requestCount++;

                if (req.success) {
                    counts.successCount++;
                } else {
                    counts.failureCount++;
                }
            }

            // Update model circuits
            for (const [modelId, counts] of modelCounts.entries()) {
                const circuit = this.getModelCircuit(modelId);
                circuit.requestCount = counts.requestCount;
                circuit.successCount = counts.successCount;
                circuit.failureCount = counts.failureCount;
            }
        }
    }

    /**
     * Get circuit status and metrics
     * @returns {Object} Circuit status and metrics
     */
    getStatus() {
        // Update circuit state first
        this.checkStateTransition();

        const errorRate = this.getErrorRate();
        const timeInCurrentState = Date.now() - this.lastStateChange;
        const modelsStatus = {};

        // Compile model-specific statuses
        if (this.config.trackByModel) {
            for (const [modelId, circuit] of this.modelCircuits.entries()) {
                const modelErrorRate = (circuit.requestCount > 0) ?
                    (circuit.failureCount / circuit.requestCount) * 100 : 0;

                modelsStatus[modelId] = {
                    state: circuit.state,
                    errorRate: `${modelErrorRate.toFixed(2)}%`,
                    requestCount: circuit.requestCount,
                    successCount: circuit.successCount,
                    failureCount: circuit.failureCount,
                    lastStateChange: new Date(circuit.lastStateChange).toISOString(),
                    timeInCurrentState: Date.now() - circuit.lastStateChange
                };

                if (circuit.state === CircuitBreaker.States.OPEN) {
                    modelsStatus[modelId].nextAttemptTime =
                        new Date(circuit.nextAttemptTime).toISOString();
                    modelsStatus[modelId].timeUntilNextAttempt =
                        Math.max(0, circuit.nextAttemptTime - Date.now());
                }
            }
        }

        const status = {
            global: {
                state: this.state,
                errorRate: `${errorRate.toFixed(2)}%`,
                errorThreshold: `${this.config.errorThresholdPercentage}%`,
                requestCount: this.requestCount,
                successCount: this.successCount,
                failureCount: this.failureCount,
                consecutiveSuccesses: this.consecutiveSuccesses,
                lastStateChange: new Date(this.lastStateChange).toISOString(),
                timeInCurrentState: timeInCurrentState
            },
            models: modelsStatus,
            rollingWindow: this.config.rollingWindow,
            requestVolumeThreshold: this.config.requestVolumeThreshold,
            successThreshold: this.config.successThreshold,
            recentRequests: this.requestHistory.slice(-10).map(req => ({
                timestamp: new Date(req.timestamp).toISOString(),
                success: req.success,
                modelId: req.modelId || 'unknown',
                error: req.error
            }))
        };

        // Add open-state specific information
        if (this.state === CircuitBreaker.States.OPEN) {
            status.global.nextAttemptTime = new Date(this.nextAttemptTime).toISOString();
            status.global.timeUntilNextAttempt = Math.max(0, this.nextAttemptTime - Date.now());
        }

        return status;
    }

    /**
     * Stop the circuit breaker and clean up resources
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        this.config.logger.info({
            message: 'CircuitBreaker stopped',
            timestamp: new Date().toISOString()
        });
    }
}

/**
 * Error thrown when a circuit is open
 * @extends Error
 */
class CircuitOpenError extends Error {
    /**
     * Constructor for CircuitOpenError
     * @param {string} message - Error message
     * @param {Object} details - Additional error details
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'CircuitOpenError';
        this.details = details;
    }
}

module.exports = { CircuitBreaker, CircuitOpenError };