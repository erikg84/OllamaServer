// src/services/queue.service.js
const logger = require('../logging/logger');

/**
 * Service for task queue management
 * Wraps p-queue functionality with enhanced features
 */
class QueueService {
    /**
     * Create a new QueueService instance
     * @param {Object} queueManager - Queue manager instance
     * @param {Object} options - Configuration options
     */
    constructor(queueManager, options = {}) {
        this.queueManager = queueManager;
        this.options = {
            defaultPriority: options.defaultPriority || 0,
            defaultTimeout: options.defaultTimeout || 300000, // 5 minutes
            enablePrioritization: options.enablePrioritization !== false,
            ...options
        };

        // Task statistics
        this.stats = {
            tasksSubmitted: 0,
            tasksCompleted: 0,
            tasksFailed: 0,
            avgProcessingTime: 0,
            avgWaitTime: 0,
            priorityStats: {
                high: 0,
                normal: 0,
                low: 0
            },
            modelStats: {}
        };

        this.activeTaskIds = new Set();

        logger.info({
            message: 'Queue service initialized',
            queueManagerAvailable: !!this.queueManager,
            options: this.options,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Add a task to the queue
     * @param {Function} task - Task function to execute
     * @param {Object} options - Task options
     * @param {string} options.id - Task ID (auto-generated if not provided)
     * @param {number} options.priority - Task priority (higher is more important)
     * @param {string} options.model - Model ID associated with the task
     * @param {string} options.taskType - Type of task (e.g., 'chat', 'generate')
     * @param {number} options.timeout - Task timeout in milliseconds
     * @returns {Promise} Task result promise
     */
    async addTask(task, options = {}) {
        const taskId = options.id || `task-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const priority = this.getPriorityValue(options.priority);
        const model = options.model || 'unknown';
        const taskType = options.taskType || 'unknown';
        const timeout = options.timeout || this.options.defaultTimeout;

        const taskInfo = {
            id: taskId,
            priority,
            model,
            taskType,
            timeout,
            submittedAt: Date.now()
        };

        logger.info({
            message: 'Task added to queue',
            taskId,
            priority,
            model,
            taskType,
            timeout,
            queueSize: this.queueManager ? this.queueManager.size() : 'unknown',
            queuePending: this.queueManager ? this.queueManager.pending() : 'unknown',
            timestamp: new Date().toISOString()
        });

        // Update stats
        this.stats.tasksSubmitted++;
        this.updatePriorityStats(priority);
        this.updateModelStats(model, 'submitted');

        try {
            // Register active task
            this.activeTaskIds.add(taskId);

            // Wrap the task with metadata and timeout
            const wrappedTask = async () => {
                const startProcessingTime = Date.now();
                const waitTime = startProcessingTime - taskInfo.submittedAt;

                // Update wait time statistics
                this.stats.avgWaitTime = this.calculateRollingAverage(
                    this.stats.avgWaitTime,
                    waitTime,
                    this.stats.tasksSubmitted
                );

                logger.debug({
                    message: 'Task started processing',
                    taskId,
                    waitTime: `${waitTime}ms`,
                    timestamp: new Date().toISOString()
                });

                // Create timeout promise
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`Task ${taskId} timed out after ${timeout}ms`));
                    }, timeout);
                });

                // Race the task against the timeout
                try {
                    const result = await Promise.race([task(), timeoutPromise]);

                    const processingTime = Date.now() - startProcessingTime;
                    const totalTime = Date.now() - taskInfo.submittedAt;

                    // Update processing time statistics
                    this.stats.tasksCompleted++;
                    this.stats.avgProcessingTime = this.calculateRollingAverage(
                        this.stats.avgProcessingTime,
                        processingTime,
                        this.stats.tasksCompleted
                    );

                    this.updateModelStats(model, 'completed', processingTime);

                    logger.info({
                        message: 'Task completed successfully',
                        taskId,
                        waitTime: `${waitTime}ms`,
                        processingTime: `${processingTime}ms`,
                        totalTime: `${totalTime}ms`,
                        timestamp: new Date().toISOString()
                    });

                    return result;
                } catch (error) {
                    this.stats.tasksFailed++;
                    this.updateModelStats(model, 'failed');

                    logger.error({
                        message: 'Task failed',
                        taskId,
                        error: error.message,
                        isTimeout: error.message.includes('timed out'),
                        stack: error.stack,
                        waitTime: `${waitTime}ms`,
                        timestamp: new Date().toISOString()
                    });

                    throw error;
                } finally {
                    // Remove from active tasks
                    this.activeTaskIds.delete(taskId);
                }
            };

            // Add to queue with priority if available
            if (this.queueManager) {
                // If prioritization is enabled, use it
                if (this.options.enablePrioritization) {
                    return await this.queueManager.add(wrappedTask, { priority });
                } else {
                    return await this.queueManager.add(wrappedTask);
                }
            } else {
                // Fall back to direct execution if no queue manager
                logger.warn({
                    message: 'Queue manager not available, executing task directly',
                    taskId,
                    timestamp: new Date().toISOString()
                });

                return await wrappedTask();
            }
        } catch (error) {
            // Remove from active tasks on error
            this.activeTaskIds.delete(taskId);

            this.stats.tasksFailed++;
            this.updateModelStats(model, 'failed');

            logger.error({
                message: 'Error adding task to queue',
                taskId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });

            throw error;
        }
    }

    /**
     * Add a MAESTRO agent collaboration task to the queue
     * @param {Function} task - Collaboration task function
     * @param {Object} options - Task options
     * @param {string} options.workflow - Collaboration workflow type
     * @param {Array} options.agents - List of agent details
     * @param {string} options.queryType - Type of user query
     * @returns {Promise} Task result promise
     */
    async addCollaborationTask(task, options = {}) {
        const taskId = `collab-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const workflow = options.workflow || 'sequential';
        const agents = options.agents || [];
        const queryType = options.queryType || 'unknown';
        const priority = this.getPriorityValue(options.priority);

        logger.info({
            message: 'Agent collaboration task added',
            taskId,
            workflow,
            agentCount: agents.length,
            agents: agents.map(a => a.role || 'unknown'),
            queryType,
            priority,
            timestamp: new Date().toISOString()
        });

        // Add enhanced options for the task
        const enhancedOptions = {
            ...options,
            id: taskId,
            priority,
            taskType: 'collaboration',
            model: agents.map(a => a.model || 'unknown').join(',')
        };

        return await this.addTask(task, enhancedOptions);
    }

    /**
     * Get queue status information
     * @returns {Object} Queue status information
     */
    getStatus() {
        return {
            stats: { ...this.stats },
            activeTasks: this.activeTaskIds.size,
            activeTaskIds: [...this.activeTaskIds],
            queueSize: this.queueManager ? this.queueManager.size() : 0,
            queuePending: this.queueManager ? this.queueManager.pending() : 0,
            isPaused: this.queueManager ? this.queueManager.isPaused() : false
        };
    }

    /**
     * Pause the queue
     */
    pause() {
        if (this.queueManager && !this.queueManager.isPaused()) {
            this.queueManager.pause();
            logger.info({
                message: 'Queue paused',
                queueSize: this.queueManager.size(),
                queuePending: this.queueManager.pending(),
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Resume the queue
     */
    resume() {
        if (this.queueManager && this.queueManager.isPaused()) {
            this.queueManager.resume();
            logger.info({
                message: 'Queue resumed',
                queueSize: this.queueManager.size(),
                queuePending: this.queueManager.pending(),
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Clear the queue
     */
    clear() {
        if (this.queueManager) {
            const previousSize = this.queueManager.size();
            this.queueManager.clear();
            logger.info({
                message: 'Queue cleared',
                previousSize,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Get all active tasks
     * @returns {Array} List of active task IDs
     */
    getActiveTasks() {
        return [...this.activeTaskIds];
    }

    /**
     * Check if a task is active
     * @param {string} taskId - Task ID to check
     * @returns {boolean} Whether the task is active
     */
    isTaskActive(taskId) {
        return this.activeTaskIds.has(taskId);
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            tasksSubmitted: 0,
            tasksCompleted: 0,
            tasksFailed: 0,
            avgProcessingTime: 0,
            avgWaitTime: 0,
            priorityStats: {
                high: 0,
                normal: 0,
                low: 0
            },
            modelStats: {}
        };

        logger.info({
            message: 'Queue statistics reset',
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Convert priority name to numeric value
     * @param {string|number} priority - Priority name or value
     * @returns {number} Numeric priority value
     */
    getPriorityValue(priority) {
        if (typeof priority === 'number') {
            return priority;
        }

        switch (priority) {
            case 'high':
                return 2;
            case 'low':
                return 0;
            case 'normal':
            default:
                return 1;
        }
    }

    /**
     * Update priority statistics
     * @param {number} priority - Priority value
     */
    updatePriorityStats(priority) {
        let priorityName = 'normal';

        if (priority >= 2) {
            priorityName = 'high';
        } else if (priority <= 0) {
            priorityName = 'low';
        }

        this.stats.priorityStats[priorityName]++;
    }

    /**
     * Update model statistics
     * @param {string} model - Model ID
     * @param {string} event - Event type (submitted, completed, failed)
     * @param {number} processingTime - Task processing time (for completed tasks)
     */
    updateModelStats(model, event, processingTime = 0) {
        // Initialize model stats if not exists
        if (!this.stats.modelStats[model]) {
            this.stats.modelStats[model] = {
                submitted: 0,
                completed: 0,
                failed: 0,
                avgProcessingTime: 0
            };
        }

        const modelStats = this.stats.modelStats[model];

        // Update stats based on event type
        switch (event) {
            case 'submitted':
                modelStats.submitted++;
                break;
            case 'completed':
                modelStats.completed++;
                if (processingTime > 0) {
                    modelStats.avgProcessingTime = this.calculateRollingAverage(
                        modelStats.avgProcessingTime,
                        processingTime,
                        modelStats.completed
                    );
                }
                break;
            case 'failed':
                modelStats.failed++;
                break;
        }
    }

    /**
     * Calculate rolling average
     * @param {number} currentAvg - Current average value
     * @param {number} newValue - New value to include
     * @param {number} count - Total count including the new value
     * @returns {number} New rolling average
     */
    calculateRollingAverage(currentAvg, newValue, count) {
        if (count <= 1) {
            return newValue;
        }

        return (currentAvg * (count - 1) + newValue) / count;
    }
}

/**
 * Create a queue service instance
 * @param {Object} queueManager - Queue manager instance
 * @param {Object} options - Configuration options
 * @returns {QueueService} Queue service instance
 */
function createQueueService(queueManager, options = {}) {
    return new QueueService(queueManager, options);
}

module.exports = {
    QueueService,
    createQueueService
};