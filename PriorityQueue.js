/**
 * PriorityQueue - Extends Queue with priority levels and fairness mechanisms
 *
 * This class provides priority-based task execution with starvation prevention
 * for the LLM orchestration system.
 */
class PriorityQueue {
    /**
     * Priority levels
     * @readonly
     * @enum {number}
     */
    static Priority = {
        CRITICAL: 0,   // Highest priority (admin/system tasks)
        HIGH: 1,       // High priority (premium user tasks)
        NORMAL: 2,     // Normal priority (standard tasks)
        LOW: 3,        // Low priority (batch processing)
        BACKGROUND: 4  // Lowest priority (non-urgent background tasks)
    };

    /**
     * Constructor for PriorityQueue
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            // Default concurrency (how many tasks can run at once)
            concurrency: config.concurrency || 5,

            // Maximum concurrent tasks per priority level (null = no limit)
            maxConcurrentByPriority: config.maxConcurrentByPriority || {
                [PriorityQueue.Priority.CRITICAL]: null,  // No limit for critical
                [PriorityQueue.Priority.HIGH]: null,      // No limit for high
                [PriorityQueue.Priority.NORMAL]: null,    // No limit for normal
                [PriorityQueue.Priority.LOW]: 2,          // Max 2 low priority tasks
                [PriorityQueue.Priority.BACKGROUND]: 1    // Max 1 background task
            },

            // Default priority for tasks
            defaultPriority: config.defaultPriority || PriorityQueue.Priority.NORMAL,

            // Starvation prevention: age factor (ms)
            agingFactor: config.agingFactor || 10000, // 10 seconds

            // Starvation prevention: max age multiplier for effective priority boost
            maxAgingBoost: config.maxAgingBoost || 2,

            // Maximum wait time before priority boost (ms)
            maxWaitTime: config.maxWaitTime || 5 * 60 * 1000, // 5 minutes

            // Queue fairness: percentage of capacity reserved for non-high-priority tasks
            fairnessReservedPercentage: config.fairnessReservedPercentage || 20,

            // Automatically start processing
            autoStart: config.autoStart !== undefined ? config.autoStart : true,

            // Logger instance
            logger: config.logger || console,

            ...config
        };

        // Queue of pending tasks by priority level
        this.queues = {
            [PriorityQueue.Priority.CRITICAL]: [],
            [PriorityQueue.Priority.HIGH]: [],
            [PriorityQueue.Priority.NORMAL]: [],
            [PriorityQueue.Priority.LOW]: [],
            [PriorityQueue.Priority.BACKGROUND]: []
        };

        // Currently running tasks
        this.running = new Map();

        // Count of pending tasks by priority
        this.pendingCounts = {
            [PriorityQueue.Priority.CRITICAL]: 0,
            [PriorityQueue.Priority.HIGH]: 0,
            [PriorityQueue.Priority.NORMAL]: 0,
            [PriorityQueue.Priority.LOW]: 0,
            [PriorityQueue.Priority.BACKGROUND]: 0
        };

        // Currently running tasks by priority
        this.runningCounts = {
            [PriorityQueue.Priority.CRITICAL]: 0,
            [PriorityQueue.Priority.HIGH]: 0,
            [PriorityQueue.Priority.NORMAL]: 0,
            [PriorityQueue.Priority.LOW]: 0,
            [PriorityQueue.Priority.BACKGROUND]: 0
        };

        // Statistics
        this.stats = {
            added: 0,
            completed: 0,
            failed: 0,
            totalWaitTime: 0,
            waitTimeByPriority: {
                [PriorityQueue.Priority.CRITICAL]: 0,
                [PriorityQueue.Priority.HIGH]: 0,
                [PriorityQueue.Priority.NORMAL]: 0,
                [PriorityQueue.Priority.LOW]: 0,
                [PriorityQueue.Priority.BACKGROUND]: 0
            },
            completedByPriority: {
                [PriorityQueue.Priority.CRITICAL]: 0,
                [PriorityQueue.Priority.HIGH]: 0,
                [PriorityQueue.Priority.NORMAL]: 0,
                [PriorityQueue.Priority.LOW]: 0,
                [PriorityQueue.Priority.BACKGROUND]: 0
            },
            priorityBoosts: 0,
            longestWaitTime: 0,
            shortestWaitTime: Infinity,
            averageWaitTime: 0
        };

        // Task ID counter
        this.taskIdCounter = 0;

        // Processing state
        this.isPaused = true;
        this.interval = null;
        this.processingPromise = null;

        // Event listeners
        this.listeners = {
            add: [],
            next: [],
            completed: [],
            error: [],
            idle: [],
            pause: [],
            start: []
        };

        // Start processing if autoStart is enabled
        if (this.config.autoStart) {
            this.start();
        }

        this.config.logger.info({
            message: 'PriorityQueue initialized',
            concurrency: this.config.concurrency,
            defaultPriority: this.config.defaultPriority,
            autoStart: this.config.autoStart,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Get queue size (total number of pending tasks)
     * @returns {number} Queue size
     */
    get size() {
        return Object.values(this.pendingCounts).reduce((a, b) => a + b, 0);
    }

    /**
     * Get number of pending tasks by priority
     * @param {number} priority - Priority level
     * @returns {number} Number of pending tasks
     */
    getPendingCount(priority) {
        return this.pendingCounts[priority] || 0;
    }

    /**
     * Get the size of individual priority queues
     * @returns {Object} Queue sizes by priority
     */
    getSizes() {
        return { ...this.pendingCounts };
    }

    /**
     * Get number of running tasks
     * @returns {number} Number of running tasks
     */
    get pending() {
        return this.running.size;
    }

    /**
     * Get number of running tasks by priority
     * @param {number} priority - Priority level
     * @returns {number} Number of running tasks
     */
    getRunningCount(priority) {
        return this.runningCounts[priority] || 0;
    }

    /**
     * Get the concurrency level (max simultaneous tasks)
     * @returns {number} Concurrency level
     */
    get concurrency() {
        return this.config.concurrency;
    }

    /**
     * Set the concurrency level
     * @param {number} value - New concurrency level
     */
    set concurrency(value) {
        const prevValue = this.config.concurrency;
        this.config.concurrency = Math.max(1, value);

        this.config.logger.info({
            message: 'Queue concurrency changed',
            previousValue: prevValue,
            newValue: this.config.concurrency,
            timestamp: new Date().toISOString()
        });

        // Process tasks if we increased capacity
        if (this.config.concurrency > prevValue && !this.isPaused) {
            this.processNextTasks();
        }
    }

    /**
     * Check if the queue is currently paused
     * @returns {boolean} True if queue is paused
     */
    get isPaused() {
        return this._isPaused;
    }

    /**
     * Set the paused state
     * @param {boolean} value - New paused state
     */
    set isPaused(value) {
        const wasPaused = this._isPaused;
        this._isPaused = value;

        if (wasPaused && !value) {
            // Queue was resumed
            this.emitEvent('start');
            this.processNextTasks();
        } else if (!wasPaused && value) {
            // Queue was paused
            this.emitEvent('pause');
        }
    }

    /**
     * Get priority name from value
     * @param {number} priority - Priority value
     * @returns {string} Priority name
     */
    static getPriorityName(priority) {
        switch (priority) {
            case PriorityQueue.Priority.CRITICAL:
                return 'CRITICAL';
            case PriorityQueue.Priority.HIGH:
                return 'HIGH';
            case PriorityQueue.Priority.NORMAL:
                return 'NORMAL';
            case PriorityQueue.Priority.LOW:
                return 'LOW';
            case PriorityQueue.Priority.BACKGROUND:
                return 'BACKGROUND';
            default:
                return 'UNKNOWN';
        }
    }

    /**
     * Add an event listener
     * @param {string} event - Event name
     * @param {Function} listener - Event listener function
     * @returns {boolean} Success indicator
     */
    on(event, listener) {
        if (!this.listeners[event]) {
            return false;
        }

        this.listeners[event].push(listener);
        return true;
    }

    /**
     * Remove an event listener
     * @param {string} event - Event name
     * @param {Function} listener - Event listener function to remove
     * @returns {boolean} Success indicator
     */
    off(event, listener) {
        if (!this.listeners[event]) {
            return false;
        }

        const index = this.listeners[event].indexOf(listener);
        if (index === -1) {
            return false;
        }

        this.listeners[event].splice(index, 1);
        return true;
    }

    /**
     * Emit an event to all listeners
     * @param {string} event - Event name
     * @param  {...any} args - Event arguments
     * @private
     */
    emitEvent(event, ...args) {
        if (!this.listeners[event]) {
            return;
        }

        for (const listener of this.listeners[event]) {
            try {
                listener(...args);
            } catch (error) {
                this.config.logger.error({
                    message: 'Error in event listener',
                    event,
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    /**
     * Add a task to the queue
     * @param {Function} fn - Task function to execute
     * @param {Object} options - Task options
     * @returns {Promise} Promise that resolves with the task result
     */
    add(fn, options = {}) {
        const priority = options.priority !== undefined
            ? options.priority
            : this.config.defaultPriority;

        if (typeof fn !== 'function') {
            throw new Error('Task must be a function');
        }

        const taskId = this.taskIdCounter++;

        // Create a task object
        const task = {
            id: taskId,
            fn,
            priority,
            addedTime: Date.now(),
            startTime: null,
            options,
            effectivePriority: priority
        };

        // Create a promise for this task
        const promise = new Promise((resolve, reject) => {
            task.resolve = resolve;
            task.reject = reject;
        });

        // Add task to the appropriate queue
        this.queues[priority].push(task);
        this.pendingCounts[priority]++;

        // Update stats
        this.stats.added++;

        // Log task addition
        this.config.logger.debug({
            message: 'Task added to queue',
            taskId,
            priority: PriorityQueue.getPriorityName(priority),
            queueSize: this.size,
            timestamp: new Date().toISOString()
        });

        // Emit add event
        this.emitEvent('add', task);

        // Process next tasks if we're running
        if (!this.isPaused) {
            this.processNextTasks();
        }

        return promise;
    }

    /**
     * Start processing tasks
     * @returns {PriorityQueue} This queue instance for chaining
     */
    start() {
        if (!this.isPaused) {
            return this;
        }

        this.isPaused = false;
        this.config.logger.info({
            message: 'Queue processing started',
            pendingTasks: this.size,
            timestamp: new Date().toISOString()
        });

        return this;
    }

    /**
     * Pause task processing
     * @returns {PriorityQueue} This queue instance for chaining
     */
    pause() {
        if (this.isPaused) {
            return this;
        }

        this.isPaused = true;
        this.config.logger.info({
            message: 'Queue processing paused',
            runningTasks: this.running.size,
            pendingTasks: this.size,
            timestamp: new Date().toISOString()
        });

        return this;
    }

    /**
     * Clear all pending tasks
     * @returns {number} Number of cleared tasks
     */
    clear() {
        let clearedCount = 0;

        // Clear each priority queue
        for (const priority in this.queues) {
            clearedCount += this.queues[priority].length;

            // Reject all pending promises
            for (const task of this.queues[priority]) {
                try {
                    task.reject(new Error('Task cancelled: queue cleared'));
                } catch (error) {
                    this.config.logger.error({
                        message: 'Error rejecting cleared task',
                        taskId: task.id,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            // Clear the queue
            this.queues[priority] = [];
            this.pendingCounts[priority] = 0;
        }

        this.config.logger.info({
            message: 'Queue cleared',
            clearedTasks: clearedCount,
            remainingRunning: this.running.size,
            timestamp: new Date().toISOString()
        });

        return clearedCount;
    }

    /**
     * Process next tasks based on priority and concurrency
     * @returns {Promise} Promise that resolves when processing is complete
     * @private
     */
    async processNextTasks() {
        // Skip if paused or already processing
        if (this.isPaused || this.processingPromise) {
            return;
        }

        // Create a promise to track processing
        this.processingPromise = (async () => {
            try {
                // Update effective priorities based on age
                this.updateEffectivePriorities();

                // Process tasks until we reach concurrency limit or run out of tasks
                while (!this.isPaused && this.running.size < this.concurrency && this.size > 0) {
                    // Get next task respecting fairness and priority
                    const task = this.getNextTask();

                    // No task available even though size > 0 (concurrency limits per priority)
                    if (!task) {
                        break;
                    }

                    // Process this task
                    await this.processTask(task);
                }

                // Check if we're idle
                if (this.size === 0 && this.running.size === 0 && !this.isPaused) {
                    this.emitEvent('idle');
                }
            } catch (error) {
                this.config.logger.error({
                    message: 'Error in task processing',
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
            } finally {
                this.processingPromise = null;
            }
        })();

        return this.processingPromise;
    }

    /**
     * Update effective priorities based on age to prevent starvation
     * @private
     */
    updateEffectivePriorities() {
        const now = Date.now();

        // Process each priority queue except CRITICAL (which doesn't need aging)
        for (let priority = PriorityQueue.Priority.HIGH; priority <= PriorityQueue.Priority.BACKGROUND; priority++) {
            for (const task of this.queues[priority]) {
                // Calculate age factor (how long has this task been waiting)
                const ageMs = now - task.addedTime;

                // Skip tasks that haven't waited long
                if (ageMs < this.config.agingFactor) {
                    continue;
                }

                // Calculate aging boost (0.0 to maxAgingBoost)
                const agingBoost = Math.min(
                    this.config.maxAgingBoost,
                    ageMs / this.config.agingFactor
                );

                // Apply boost to get effective priority (lower is better)
                // We subtract the boost, but never go below CRITICAL
                const newEffectivePriority = Math.max(
                    PriorityQueue.Priority.CRITICAL,
                    priority - Math.floor(agingBoost)
                );

                // Only log if changed
                if (newEffectivePriority !== task.effectivePriority) {
                    // Track stats for boosts
                    if (newEffectivePriority < task.effectivePriority) {
                        this.stats.priorityBoosts++;
                    }

                    task.effectivePriority = newEffectivePriority;

                    this.config.logger.debug({
                        message: 'Task priority boosted due to age',
                        taskId: task.id,
                        originalPriority: PriorityQueue.getPriorityName(priority),
                        newEffectivePriority: PriorityQueue.getPriorityName(newEffectivePriority),
                        ageMs,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
    }

    /**
     * Get next task respecting fairness and priority
     * @returns {Object|null} Next task to process or null if none available
     * @private
     */
    getNextTask() {
        // Track tasks we found but couldn't run due to concurrency limits
        const skippedDueToConcurrency = [];

        // Check for tasks in priority order (0 = highest priority)
        for (let priority = PriorityQueue.Priority.CRITICAL; priority <= PriorityQueue.Priority.BACKGROUND; priority++) {
            // Skip empty queues
            if (this.queues[priority].length === 0) {
                continue;
            }

            // Handle fairness: reserve some capacity for non-high-priority tasks
            // Only applies when we're at more than 50% capacity
            if (priority <= PriorityQueue.Priority.HIGH &&
                this.running.size >= this.concurrency / 2) {

                // Calculate reserved slots for lower priority tasks
                const reservedSlots = Math.ceil(
                    (this.concurrency * this.config.fairnessReservedPercentage) / 100
                );

                // Calculate available slots for high priority tasks
                const highPrioritySlots = this.concurrency - reservedSlots;

                // Current high priority task count
                const highPriorityCount =
                    this.runningCounts[PriorityQueue.Priority.CRITICAL] +
                    this.runningCounts[PriorityQueue.Priority.HIGH];

                // Skip if we've used all high priority slots
                if (highPriorityCount >= highPrioritySlots) {
                    continue;
                }
            }

            // Find best task in this queue based on effective priority
            let bestTask = null;
            let bestIndex = -1;

            for (let i = 0; i < this.queues[priority].length; i++) {
                const task = this.queues[priority][i];

                // Check concurrency limit for this priority level
                const maxConcurrent = this.config.maxConcurrentByPriority[task.priority];
                if (maxConcurrent !== null &&
                    this.runningCounts[task.priority] >= maxConcurrent) {
                    skippedDueToConcurrency.push(task.priority);
                    continue;
                }

                // First task or better effective priority (aged task)
                if (bestTask === null || task.effectivePriority < bestTask.effectivePriority) {
                    bestTask = task;
                    bestIndex = i;
                }
                // Same effective priority, use age as tiebreaker
                else if (task.effectivePriority === bestTask.effectivePriority &&
                    task.addedTime < bestTask.addedTime) {
                    bestTask = task;
                    bestIndex = i;
                }
            }

            // If we found a suitable task, remove it from the queue and return it
            if (bestTask !== null) {
                this.queues[priority].splice(bestIndex, 1);
                this.pendingCounts[priority]--;
                return bestTask;
            }
        }

        // Log if we skipped tasks due to concurrency limits
        if (skippedDueToConcurrency.length > 0) {
            this.config.logger.debug({
                message: 'Tasks skipped due to concurrency limits',
                priorities: skippedDueToConcurrency.map(p => PriorityQueue.getPriorityName(p)),
                timestamp: new Date().toISOString()
            });
        }

        // No suitable task found
        return null;
    }

    /**
     * Process a single task
     * @param {Object} task - Task to process
     * @returns {Promise} Promise that resolves when task is processed
     * @private
     */
    async processTask(task) {
        // Mark task as running
        task.startTime = Date.now();
        const waitTime = task.startTime - task.addedTime;

        // Add to running set
        this.running.set(task.id, task);
        this.runningCounts[task.priority]++;

        // Update wait time stats
        this.stats.totalWaitTime += waitTime;
        this.stats.waitTimeByPriority[task.priority] += waitTime;

        if (waitTime > this.stats.longestWaitTime) {
            this.stats.longestWaitTime = waitTime;
        }

        if (waitTime < this.stats.shortestWaitTime) {
            this.stats.shortestWaitTime = waitTime;
        }

        this.stats.averageWaitTime =
            this.stats.totalWaitTime / (this.stats.completed + this.stats.failed + 1);

        // Log task start
        this.config.logger.debug({
            message: 'Task started',
            taskId: task.id,
            priority: PriorityQueue.getPriorityName(task.priority),
            effectivePriority: PriorityQueue.getPriorityName(task.effectivePriority),
            waitTime: `${waitTime}ms`,
            timestamp: new Date().toISOString()
        });

        // Emit next event
        this.emitEvent('next', task);

        try {
            // Execute the task
            const result = await task.fn();

            // Remove from running tasks
            this.running.delete(task.id);
            this.runningCounts[task.priority]--;

            // Update stats
            this.stats.completed++;
            this.stats.completedByPriority[task.priority]++;

            // Log task completion
            this.config.logger.debug({
                message: 'Task completed',
                taskId: task.id,
                priority: PriorityQueue.getPriorityName(task.priority),
                waitTime: `${waitTime}ms`,
                executionTime: `${Date.now() - task.startTime}ms`,
                timestamp: new Date().toISOString()
            });

            // Emit completion event
            this.emitEvent('completed', result, waitTime);

            // Resolve the task's promise
            task.resolve(result);

            // Process next tasks
            this.processNextTasks();

            return result;
        } catch (error) {
            // Remove from running tasks
            this.running.delete(task.id);
            this.runningCounts[task.priority]--;

            // Update stats
            this.stats.failed++;

            // Log task failure
            this.config.logger.error({
                message: 'Task failed',
                taskId: task.id,
                priority: PriorityQueue.getPriorityName(task.priority),
                error: error.message,
                stack: error.stack,
                waitTime: `${waitTime}ms`,
                executionTime: `${Date.now() - task.startTime}ms`,
                timestamp: new Date().toISOString()
            });

            // Emit error event
            this.emitEvent('error', error);

            // Reject the task's promise
            task.reject(error);

            // Process next tasks
            this.processNextTasks();

            throw error;
        }
    }

    /**
     * Get detailed queue statistics
     * @returns {Object} Queue statistics
     */
    getStats() {
        return {
            size: this.size,
            pending: this.pending,
            concurrency: this.concurrency,
            isPaused: this.isPaused,

            pendingByPriority: { ...this.pendingCounts },
            runningByPriority: { ...this.runningCounts },

            performance: {
                added: this.stats.added,
                completed: this.stats.completed,
                failed: this.stats.failed,
                completedByPriority: { ...this.stats.completedByPriority },

                waitTime: {
                    average: this.stats.averageWaitTime,
                    longest: this.stats.longestWaitTime,
                    shortest: this.stats.shortestWaitTime > 0 ?
                        this.stats.shortestWaitTime : 0,
                    byPriority: {
                        [PriorityQueue.Priority.CRITICAL]:
                            this.calculateAverageWaitTime(PriorityQueue.Priority.CRITICAL),
                        [PriorityQueue.Priority.HIGH]:
                            this.calculateAverageWaitTime(PriorityQueue.Priority.HIGH),
                        [PriorityQueue.Priority.NORMAL]:
                            this.calculateAverageWaitTime(PriorityQueue.Priority.NORMAL),
                        [PriorityQueue.Priority.LOW]:
                            this.calculateAverageWaitTime(PriorityQueue.Priority.LOW),
                        [PriorityQueue.Priority.BACKGROUND]:
                            this.calculateAverageWaitTime(PriorityQueue.Priority.BACKGROUND)
                    }
                },

                priorityBoosts: this.stats.priorityBoosts
            },

            config: {
                fairnessReservedPercentage: this.config.fairnessReservedPercentage,
                maxConcurrentByPriority: { ...this.config.maxConcurrentByPriority },
                agingFactor: this.config.agingFactor,
                maxAgingBoost: this.config.maxAgingBoost,
                maxWaitTime: this.config.maxWaitTime
            }
        };
    }

    /**
     * Calculate average wait time for a specific priority
     * @param {number} priority - Priority level
     * @returns {number} Average wait time in ms
     * @private
     */
    calculateAverageWaitTime(priority) {
        if (this.stats.completedByPriority[priority] === 0) {
            return 0;
        }

        return this.stats.waitTimeByPriority[priority] / this.stats.completedByPriority[priority];
    }

    /**
     * Get oldest pending task by priority
     * @param {number} priority - Priority level
     * @returns {Object|null} Oldest pending task or null if none
     */
    getOldestPendingTask(priority) {
        if (this.queues[priority].length === 0) {
            return null;
        }

        // Find oldest task in this queue
        let oldestTask = this.queues[priority][0];
        let oldestTime = oldestTask.addedTime;

        for (let i = 1; i < this.queues[priority].length; i++) {
            const task = this.queues[priority][i];
            if (task.addedTime < oldestTime) {
                oldestTask = task;
                oldestTime = task.addedTime;
            }
        }

        return {
            taskId: oldestTask.id,
            priority: oldestTask.priority,
            effectivePriority: oldestTask.effectivePriority,
            addedTime: new Date(oldestTask.addedTime).toISOString(),
            ageMs: Date.now() - oldestTask.addedTime
        };
    }

    /**
     * Get details about waiting tasks
     * @returns {Object} Waiting task details
     */
    getWaitingTasksInfo() {
        const info = {
            totalWaiting: this.size,
            byPriority: {},
            oldestByPriority: {}
        };

        // Add stats for each priority level
        for (let priority = PriorityQueue.Priority.CRITICAL; priority <= PriorityQueue.Priority.BACKGROUND; priority++) {
            info.byPriority[priority] = {
                count: this.pendingCounts[priority],
                name: PriorityQueue.getPriorityName(priority)
            };

            const oldestTask = this.getOldestPendingTask(priority);
            if (oldestTask) {
                info.oldestByPriority[priority] = oldestTask;
            }
        }

        return info;
    }

    /**
     * Stop the queue and clean up resources
     */
    stop() {
        this.pause();
        this.clear();

        // Clear all listeners
        for (const event in this.listeners) {
            this.listeners[event] = [];
        }

        this.config.logger.info({
            message: 'Queue stopped and cleaned up',
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = PriorityQueue;