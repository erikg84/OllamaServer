/**
 * QueueConfigManager - Manages queue concurrency based on system resources
 *
 * This class uses ResourceMonitor data to dynamically adjust queue concurrency
 * settings based on system load and historical performance.
 */
class QueueConfigManager {
    /**
     * Constructor for QueueConfigManager
     * @param {Object} queue - The p-queue instance to manage
     * @param {ResourceMonitor} resourceMonitor - The resource monitor instance
     * @param {Object} config - Configuration options
     */
    constructor(queue, resourceMonitor, config = {}) {
        // Store references to managed components
        this.queue = queue;
        this.resourceMonitor = resourceMonitor;

        // Configuration with defaults
        this.config = {
            minConcurrency: config.minConcurrency || 1,
            maxConcurrency: config.maxConcurrency || 10,
            defaultConcurrency: config.defaultConcurrency || 5,
            adjustmentStep: config.adjustmentStep || 1,
            adjustmentInterval: config.adjustmentInterval || 30000, // 30 seconds
            adjustmentCooldown: config.adjustmentCooldown || 10000, // 10 seconds
            ...config
        };

        // Performance tracking
        this.performanceHistory = [];
        this.historyMaxLength = config.historyMaxLength || 100;

        // Concurrency state
        this.currentConcurrency = this.config.defaultConcurrency;
        this.lastAdjustmentTime = 0;
        this.adjustmentCount = 0;

        // Adjustment history for analysis
        this.adjustmentHistory = [];
        this.adjustmentHistoryMaxLength = config.adjustmentHistoryMaxLength || 50;

        // State tracking
        this.isAdjusting = false;
        this.adjustmentInterval = null;

        // Statistics
        this.stats = {
            increasesCount: 0,
            decreasesCount: 0,
            totalAdjustments: 0,
            lastAdjustmentReason: '',
            averageResponseTime: 0,
            averageQueueDepth: 0,
            totalTasksProcessed: 0
        };

        // Required for logging
        this.logger = config.logger || console;

        // Bind methods to maintain 'this' context
        this.adjustConcurrency = this.adjustConcurrency.bind(this);
        this.trackTaskPerformance = this.trackTaskPerformance.bind(this);
    }

    /**
     * Start automatic concurrency adjustments
     * @returns {boolean} True if started, false if already running
     */
    start() {
        if (this.isAdjusting) {
            return false;
        }

        // Apply initial concurrency setting
        this.setConcurrency(this.config.defaultConcurrency);

        // Set up queue event listeners for performance tracking
        this.setupQueueListeners();

        // Start regular adjustment checks
        this.adjustmentInterval = setInterval(this.adjustConcurrency, this.config.adjustmentInterval);
        this.isAdjusting = true;

        this.logger.info({
            message: 'QueueConfigManager started',
            initialConcurrency: this.currentConcurrency,
            minConcurrency: this.config.minConcurrency,
            maxConcurrency: this.config.maxConcurrency,
            adjustmentInterval: `${this.config.adjustmentInterval}ms`,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Stop automatic concurrency adjustments
     * @returns {boolean} True if stopped, false if not running
     */
    stop() {
        if (!this.isAdjusting) {
            return false;
        }

        // Remove queue event listeners
        this.removeQueueListeners();

        // Stop adjustment interval
        clearInterval(this.adjustmentInterval);
        this.adjustmentInterval = null;
        this.isAdjusting = false;

        this.logger.info({
            message: 'QueueConfigManager stopped',
            finalConcurrency: this.currentConcurrency,
            totalAdjustments: this.stats.totalAdjustments,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Set up event listeners on queue for performance tracking
     */
    setupQueueListeners() {
        // When a task is added to the queue
        this.queue.on('add', () => {
            this.updateStats();
        });

        // When a task starts execution
        this.queue.on('next', () => {
            this.updateStats();
        });

        // Track task completion performance
        this.queue.on('completed', this.trackTaskPerformance);

        // Track task errors
        this.queue.on('error', (error) => {
            this.updateStats();

            this.logger.warn({
                message: 'Queue task error logged by QueueConfigManager',
                queueSize: this.queue.size,
                queuePending: this.queue.pending,
                concurrency: this.currentConcurrency,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        });
    }

    /**
     * Remove queue event listeners
     */
    removeQueueListeners() {
        this.queue.off('add');
        this.queue.off('next');
        this.queue.off('completed', this.trackTaskPerformance);
        this.queue.off('error');
    }

    /**
     * Track the performance of completed tasks
     * @param {Object} result - The task result
     * @param {number} taskTime - Time it took to process the task
     */
    trackTaskPerformance(result, taskTime) {
        // Record performance metrics for the completed task
        const performanceEntry = {
            timestamp: Date.now(),
            taskTime, // Time to process the task
            queueDepth: this.queue.size, // Queue depth at completion time
            concurrencyLevel: this.currentConcurrency, // Concurrency when task completed
            resourceMetrics: this.resourceMonitor.getCurrentMetrics() // Resource state
        };

        // Add to performance history, maintain max length
        this.performanceHistory.push(performanceEntry);
        if (this.performanceHistory.length > this.historyMaxLength) {
            this.performanceHistory.shift();
        }

        // Update statistics
        this.stats.totalTasksProcessed++;
        this.updateResponseTimeAverage(taskTime);
        this.updateQueueDepthAverage();

        this.updateStats();
    }

    /**
     * Update average response time statistic
     * @param {number} newTaskTime - Time for the latest task
     */
    updateResponseTimeAverage(newTaskTime) {
        if (this.stats.totalTasksProcessed === 1) {
            this.stats.averageResponseTime = newTaskTime;
        } else {
            // Calculate running average
            const oldWeight = (this.stats.totalTasksProcessed - 1) / this.stats.totalTasksProcessed;
            const newWeight = 1 / this.stats.totalTasksProcessed;
            this.stats.averageResponseTime =
                (oldWeight * this.stats.averageResponseTime) + (newWeight * newTaskTime);
        }
    }

    /**
     * Update average queue depth statistic
     */
    updateQueueDepthAverage() {
        const currentQueueDepth = this.queue.size;
        if (this.stats.totalTasksProcessed === 1) {
            this.stats.averageQueueDepth = currentQueueDepth;
        } else {
            // Calculate running average
            const oldWeight = (this.stats.totalTasksProcessed - 1) / this.stats.totalTasksProcessed;
            const newWeight = 1 / this.stats.totalTasksProcessed;
            this.stats.averageQueueDepth =
                (oldWeight * this.stats.averageQueueDepth) + (newWeight * currentQueueDepth);
        }
    }

    /**
     * Update queue statistics
     */
    updateStats() {
        // This is called frequently, so we keep it lightweight
        // Just update the latest queue state in our stats
        this.stats.currentQueueSize = this.queue.size;
        this.stats.currentPending = this.queue.pending;
        this.stats.isPaused = this.queue.isPaused;
    }

    /**
     * Set concurrency level for the queue
     * @param {number} concurrency - New concurrency level
     * @returns {boolean} True if concurrency was changed
     */
    setConcurrency(concurrency) {
        // Enforce min/max bounds
        const newConcurrency = Math.max(
            this.config.minConcurrency,
            Math.min(concurrency, this.config.maxConcurrency)
        );

        // Only update if value has changed
        if (newConcurrency === this.currentConcurrency) {
            return false;
        }

        // Update queue concurrency
        this.queue.concurrency = newConcurrency;
        const oldConcurrency = this.currentConcurrency;
        this.currentConcurrency = newConcurrency;

        this.logger.info({
            message: 'Queue concurrency changed',
            oldConcurrency,
            newConcurrency,
            queueSize: this.queue.size,
            queuePending: this.queue.pending,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Automatically adjust concurrency based on system resources
     */
    adjustConcurrency() {
        const now = Date.now();

        // Check cooldown period
        if (now - this.lastAdjustmentTime < this.config.adjustmentCooldown) {
            return;
        }

        // Get resource-based recommendation
        const recommendation = this.resourceMonitor.getRecommendedAdjustment(this.currentConcurrency);

        // Get performance-based recommendation
        const performanceRecommendation = this.getPerformanceBasedRecommendation();

        // Combine recommendations (prioritize resource constraints)
        let adjustment = 0;
        let reason = '';

        if (recommendation.direction === 'decrease') {
            // If resources are constrained, always decrease
            adjustment = -this.config.adjustmentStep;
            reason = recommendation.reason;
        } else if (recommendation.direction === 'increase' && performanceRecommendation.direction === 'increase') {
            // Only increase if both resource and performance metrics agree
            adjustment = this.config.adjustmentStep;
            reason = `${recommendation.reason}, ${performanceRecommendation.reason}`;
        } else if (recommendation.direction === 'maintain' && performanceRecommendation.direction === 'decrease') {
            // If performance metrics suggest decrease but resources are fine, still decrease
            adjustment = -this.config.adjustmentStep;
            reason = performanceRecommendation.reason;
        } else {
            // Default case - maintain current level
            reason = 'Current concurrency level is optimal';
        }

        // If there's an adjustment to make
        if (adjustment !== 0) {
            const newConcurrency = this.currentConcurrency + adjustment;

            // Apply the new concurrency
            if (this.setConcurrency(newConcurrency)) {
                // Update state
                this.lastAdjustmentTime = now;
                this.adjustmentCount++;
                this.stats.totalAdjustments++;
                this.stats.lastAdjustmentReason = reason;

                if (adjustment > 0) {
                    this.stats.increasesCount++;
                } else {
                    this.stats.decreasesCount++;
                }

                // Record adjustment for analysis
                const adjustmentRecord = {
                    timestamp: now,
                    oldConcurrency: this.currentConcurrency - adjustment,
                    newConcurrency: this.currentConcurrency,
                    adjustment,
                    reason,
                    resourceMetrics: this.resourceMonitor.getCurrentMetrics(),
                    queueState: {
                        size: this.queue.size,
                        pending: this.queue.pending,
                        isPaused: this.queue.isPaused
                    }
                };

                this.adjustmentHistory.push(adjustmentRecord);
                if (this.adjustmentHistory.length > this.adjustmentHistoryMaxLength) {
                    this.adjustmentHistory.shift();
                }

                this.logger.info({
                    message: 'Queue concurrency adjusted automatically',
                    oldConcurrency: this.currentConcurrency - adjustment,
                    newConcurrency: this.currentConcurrency,
                    adjustment,
                    reason,
                    resourceUsage: {
                        cpu: this.resourceMonitor.currentCpuUsage.toFixed(1) + '%',
                        memory: this.resourceMonitor.currentMemoryUsage.toFixed(1) + '%'
                    },
                    queueState: {
                        size: this.queue.size,
                        pending: this.queue.pending
                    },
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    /**
     * Get recommendation based on task performance
     * @returns {Object} Recommendation with direction and reason
     */
    getPerformanceBasedRecommendation() {
        // Default response if we don't have enough data
        if (this.performanceHistory.length < 5) {
            return {
                direction: 'maintain',
                reason: 'Insufficient performance history'
            };
        }

        // Calculate metrics from recent performance history
        const recentHistory = this.performanceHistory.slice(-10);

        // Average response time trend
        const oldAvgTime = this.calculateAverageTaskTime(recentHistory.slice(0, 5));
        const newAvgTime = this.calculateAverageTaskTime(recentHistory.slice(-5));
        const responseTimeTrend = newAvgTime - oldAvgTime;

        // Queue depth trend
        const avgQueueDepth = this.calculateAverageQueueDepth(recentHistory);
        const highQueueLoad = avgQueueDepth > 5; // Arbitrary threshold

        // Queue growth rate
        const queueSizeIncreasing = this.isQueueSizeIncreasing(recentHistory);

        // Make recommendation based on performance trends
        if (responseTimeTrend > 100 && this.currentConcurrency > this.config.minConcurrency) {
            // Response time is increasing significantly - reduce concurrency
            return {
                direction: 'decrease',
                reason: `Response time increasing (${responseTimeTrend.toFixed(0)}ms)`
            };
        } else if (highQueueLoad && !queueSizeIncreasing && this.currentConcurrency < this.config.maxConcurrency) {
            // High queue depth but not growing - increase concurrency to process faster
            return {
                direction: 'increase',
                reason: `High queue depth (${avgQueueDepth.toFixed(1)}) with stable growth`
            };
        } else if (queueSizeIncreasing && this.currentConcurrency < this.config.maxConcurrency) {
            // Queue is growing - increase concurrency to keep up
            return {
                direction: 'increase',
                reason: 'Queue size is increasing'
            };
        } else if (avgQueueDepth < 1 && this.stats.averageResponseTime < 500 && this.currentConcurrency > this.config.minConcurrency) {
            // Low queue depth and fast responses - might be over-provisioned
            return {
                direction: 'decrease',
                reason: 'Low queue utilization with fast responses'
            };
        }

        // Default - maintain current level
        return {
            direction: 'maintain',
            reason: 'Performance metrics indicate current level is appropriate'
        };
    }

    /**
     * Calculate average task time from history
     * @param {Array} history - Array of performance records
     * @returns {number} Average task time in ms
     */
    calculateAverageTaskTime(history) {
        if (history.length === 0) return 0;
        const sum = history.reduce((total, record) => total + record.taskTime, 0);
        return sum / history.length;
    }

    /**
     * Calculate average queue depth from history
     * @param {Array} history - Array of performance records
     * @returns {number} Average queue depth
     */
    calculateAverageQueueDepth(history) {
        if (history.length === 0) return 0;
        const sum = history.reduce((total, record) => total + record.queueDepth, 0);
        return sum / history.length;
    }

    /**
     * Determine if queue size is increasing based on history
     * @param {Array} history - Array of performance records
     * @returns {boolean} True if queue size appears to be increasing
     */
    isQueueSizeIncreasing(history) {
        if (history.length < 5) return false;

        // Look at first half vs second half of history
        const midpoint = Math.floor(history.length / 2);
        const firstHalf = history.slice(0, midpoint);
        const secondHalf = history.slice(midpoint);

        const firstHalfAvg = this.calculateAverageQueueDepth(firstHalf);
        const secondHalfAvg = this.calculateAverageQueueDepth(secondHalf);

        // Queue is considered increasing if second half average is at least 20% higher
        return secondHalfAvg > (firstHalfAvg * 1.2);
    }

    /**
     * Get current queue configuration and statistics
     * @returns {Object} Current configuration and statistics
     */
    getStatus() {
        return {
            currentConcurrency: this.currentConcurrency,
            config: { ...this.config },
            stats: { ...this.stats },
            resourceUsage: this.resourceMonitor.getCurrentMetrics(),
            queueState: {
                size: this.queue.size,
                pending: this.queue.pending,
                isPaused: this.queue.isPaused
            },
            lastAdjustment: this.adjustmentHistory.length > 0 ?
                this.adjustmentHistory[this.adjustmentHistory.length - 1] : null
        };
    }

    /**
     * Get performance history for analysis
     * @param {number} limit - Maximum number of records to return
     * @returns {Array} Recent performance history
     */
    getPerformanceHistory(limit = this.historyMaxLength) {
        return this.performanceHistory.slice(-limit);
    }

    /**
     * Get adjustment history for analysis
     * @param {number} limit - Maximum number of records to return
     * @returns {Array} Recent adjustment history
     */
    getAdjustmentHistory(limit = this.adjustmentHistoryMaxLength) {
        return this.adjustmentHistory.slice(-limit);
    }

    /**
     * Force a specific concurrency level and disable auto-adjustment temporarily
     * @param {number} concurrency - Forced concurrency level
     * @param {number} duration - Duration in ms to maintain this level (0 = indefinite)
     */
    forceSetConcurrency(concurrency, duration = 0) {
        // Store current state
        const wasAdjusting = this.isAdjusting;

        // Stop auto-adjustment if running
        if (wasAdjusting) {
            this.stop();
        }

        // Set the specified concurrency
        this.setConcurrency(concurrency);

        this.logger.info({
            message: 'Queue concurrency forced manually',
            concurrency,
            duration: duration > 0 ? `${duration}ms` : 'indefinite',
            autoAdjustStopped: wasAdjusting,
            timestamp: new Date().toISOString()
        });

        // If duration specified, restore previous state after timeout
        if (duration > 0) {
            setTimeout(() => {
                this.logger.info({
                    message: 'Forced concurrency period ended',
                    restoringAutoAdjust: wasAdjusting,
                    timestamp: new Date().toISOString()
                });

                if (wasAdjusting) {
                    this.start();
                }
            }, duration);
        }
    }
}

module.exports = QueueConfigManager;