const EventEmitter = require('events');

class TimeoutManager extends EventEmitter {
    constructor(config = {}, logger = console) {
        super();
        this.logger = logger;
        this.defaultTimeout = config.defaultTimeout || 60000; // Default: 60 seconds
        this.modelTimeouts = config.modelTimeouts || {};
        this.timeoutStats = {};
        this.requestTimers = new Map();
    }

    setTimeoutForModel(model, timeout) {
        this.modelTimeouts[model] = timeout;
        this.logger.info({
            message: 'Timeout updated for model',
            model,
            timeout,
            timestamp: new Date().toISOString()
        });
    }

    getTimeoutForModel(model) {
        return this.modelTimeouts[model] || this.defaultTimeout;
    }

    startTimeout(requestId, model, cancelCallback) {
        const timeoutDuration = this.getTimeoutForModel(model);

        const timer = setTimeout(() => {
            this.logger.warn({
                message: 'Request timed out',
                requestId,
                model,
                timeoutDuration,
                timestamp: new Date().toISOString()
            });

            cancelCallback(new Error(`Request timed out after ${timeoutDuration}ms`));

            this.recordTimeout(model);

            this.emit('timeout', { requestId, model, timeoutDuration });
        }, timeoutDuration);

        this.requestTimers.set(requestId, timer);

        this.logger.info({
            message: 'Timeout started for request',
            requestId,
            model,
            timeoutDuration,
            timestamp: new Date().toISOString()
        });
    }

    clearTimeout(requestId) {
        if (this.requestTimers.has(requestId)) {
            clearTimeout(this.requestTimers.get(requestId));
            this.requestTimers.delete(requestId);

            this.logger.info({
                message: 'Timeout cleared for request',
                requestId,
                timestamp: new Date().toISOString()
            });
        }
    }

    recordTimeout(model) {
        if (!this.timeoutStats[model]) {
            this.timeoutStats[model] = { count: 0, lastTimeout: null };
        }

        this.timeoutStats[model].count += 1;
        this.timeoutStats[model].lastTimeout = new Date().toISOString();

        this.logger.info({
            message: 'Timeout recorded',
            model,
            totalTimeouts: this.timeoutStats[model].count,
            timestamp: new Date().toISOString()
        });
    }

    getTimeoutStats(model = null) {
        if (model) {
            return this.timeoutStats[model] || { count: 0, lastTimeout: null };
        }
        return this.timeoutStats;
    }

    adjustTimeoutsBasedOnPerformance(performanceMetrics) {
        for (const model in performanceMetrics) {
            const avgResponseTime = performanceMetrics[model].averageResponseTime;
            const adjustedTimeout = Math.max(this.defaultTimeout, avgResponseTime * 1.5);
            this.setTimeoutForModel(model, adjustedTimeout);

            this.logger.info({
                message: 'Timeout dynamically adjusted based on performance',
                model,
                adjustedTimeout,
                avgResponseTime,
                timestamp: new Date().toISOString()
            });
        }
    }
}

module.exports = TimeoutManager;
