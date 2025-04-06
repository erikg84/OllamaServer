/**
 * ResourceMonitor - Tracks system resource usage to inform concurrency decisions
 *
 * This class provides methods to monitor CPU, memory, and load average
 * to help determine optimal concurrency levels for the request queue.
 */
class ResourceMonitor {
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            sampleInterval: config.sampleInterval || 5000, // How often to sample resource usage (ms)
            sampleHistory: config.sampleHistory || 12,     // How many samples to keep
            cpuHighThreshold: config.cpuHighThreshold || 80,   // CPU % threshold to reduce concurrency
            cpuLowThreshold: config.cpuLowThreshold || 40,     // CPU % threshold to increase concurrency
            memoryHighThreshold: config.memoryHighThreshold || 85, // Memory % threshold to reduce concurrency
            memoryLowThreshold: config.memoryLowThreshold || 50,   // Memory % threshold to increase concurrency
            ...config
        };

        // Resource usage history
        this.cpuHistory = [];
        this.memoryHistory = [];
        this.loadHistory = [];

        // Current values - initialized with default values
        this.currentCpuUsage = 0;
        this.currentMemoryUsage = 0;
        this.currentLoadAverage = 0;
        this.totalMemory = 0;
        this.freeMemory = 0;

        // Monitoring state
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.lastSampleTime = 0;

        // Require OS module for getting system information
        this.os = require('os');

        // Calculate total system memory at initialization
        this.totalMemory = this.os.totalmem();

        // Bind the sample method to maintain 'this' context
        this.sample = this.sample.bind(this);
    }

    /**
     * Start resource monitoring
     * @returns {boolean} True if monitoring started, false if already running
     */
    start() {
        if (this.isMonitoring) {
            return false;
        }

        // Take an initial sample immediately
        this.sample();

        // Set up regular sampling interval
        this.monitoringInterval = setInterval(this.sample, this.config.sampleInterval);
        this.isMonitoring = true;

        return true;
    }

    /**
     * Stop resource monitoring
     * @returns {boolean} True if monitoring stopped, false if not running
     */
    stop() {
        if (!this.isMonitoring) {
            return false;
        }

        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;
        this.isMonitoring = false;

        return true;
    }

    /**
     * Take a sample of current system resource usage
     * @returns {Object} Current resource usage metrics
     */
    sample() {
        this.lastSampleTime = Date.now();

        // Get CPU usage - need to sample twice with delay to calculate usage
        const cpuInfo1 = this.getCpuInfo();
        const cpuSamplePromise = new Promise(resolve => {
            setTimeout(() => {
                const cpuInfo2 = this.getCpuInfo();
                const cpuPercent = this.calculateCpuUsage(cpuInfo1, cpuInfo2);
                resolve(cpuPercent);
            }, 100); // Short delay to calculate CPU usage
        });

        // Get memory information
        this.freeMemory = this.os.freemem();
        const memoryUsedPercent = 100 - ((this.freeMemory / this.totalMemory) * 100);

        // Get load average (1, 5, 15 minutes)
        const loadAverage = this.os.loadavg();

        // Update current memory metrics
        this.currentMemoryUsage = memoryUsedPercent;
        this.addToHistory(this.memoryHistory, {
            timestamp: this.lastSampleTime,
            value: memoryUsedPercent
        });

        // Update current load average
        this.currentLoadAverage = loadAverage[0]; // 1-minute load average
        this.addToHistory(this.loadHistory, {
            timestamp: this.lastSampleTime,
            value: loadAverage[0]
        });

        // Wait for CPU usage calculation
        cpuSamplePromise.then(cpuPercent => {
            this.currentCpuUsage = cpuPercent;
            this.addToHistory(this.cpuHistory, {
                timestamp: this.lastSampleTime,
                value: cpuPercent
            });
        });

        // Return current metrics
        return {
            timestamp: this.lastSampleTime,
            cpu: this.currentCpuUsage,
            memory: this.currentMemoryUsage,
            load: this.currentLoadAverage,
            totalMemory: this.totalMemory,
            freeMemory: this.freeMemory
        };
    }

    /**
     * Add a data point to history, maintaining max history length
     * @param {Array} history - The history array to add to
     * @param {Object} dataPoint - The data point to add
     */
    addToHistory(history, dataPoint) {
        history.push(dataPoint);
        if (history.length > this.config.sampleHistory) {
            history.shift(); // Remove oldest entry
        }
    }

    /**
     * Get CPU information
     * @returns {Object} Object containing idle and total CPU time
     */
    getCpuInfo() {
        const cpus = this.os.cpus();
        let idle = 0;
        let total = 0;

        for (const cpu of cpus) {
            for (const type in cpu.times) {
                total += cpu.times[type];
            }
            idle += cpu.times.idle;
        }

        return { idle, total };
    }

    /**
     * Calculate CPU usage percentage from two samples
     * @param {Object} start - Starting CPU info
     * @param {Object} end - Ending CPU info
     * @returns {number} CPU usage percentage
     */
    calculateCpuUsage(start, end) {
        const idleDiff = end.idle - start.idle;
        const totalDiff = end.total - start.total;

        // Avoid division by zero
        if (totalDiff === 0) return 0;

        const percentage = 100 - Math.floor(100 * idleDiff / totalDiff);
        return percentage;
    }

    /**
     * Get the average CPU usage over recent samples
     * @param {number} sampleCount - Number of recent samples to average (default: all)
     * @returns {number} Average CPU usage percentage
     */
    getAverageCpuUsage(sampleCount = this.cpuHistory.length) {
        const recentSamples = this.cpuHistory.slice(-sampleCount);
        if (recentSamples.length === 0) return this.currentCpuUsage;

        const sum = recentSamples.reduce((total, sample) => total + sample.value, 0);
        return sum / recentSamples.length;
    }

    /**
     * Get the average memory usage over recent samples
     * @param {number} sampleCount - Number of recent samples to average (default: all)
     * @returns {number} Average memory usage percentage
     */
    getAverageMemoryUsage(sampleCount = this.memoryHistory.length) {
        const recentSamples = this.memoryHistory.slice(-sampleCount);
        if (recentSamples.length === 0) return this.currentMemoryUsage;

        const sum = recentSamples.reduce((total, sample) => total + sample.value, 0);
        return sum / recentSamples.length;
    }

    /**
     * Get the average load over recent samples
     * @param {number} sampleCount - Number of recent samples to average (default: all)
     * @returns {number} Average load
     */
    getAverageLoad(sampleCount = this.loadHistory.length) {
        const recentSamples = this.loadHistory.slice(-sampleCount);
        if (recentSamples.length === 0) return this.currentLoadAverage;

        const sum = recentSamples.reduce((total, sample) => total + sample.value, 0);
        return sum / recentSamples.length;
    }

    /**
     * Get current resource metrics
     * @returns {Object} Current resource usage metrics
     */
    getCurrentMetrics() {
        return {
            cpu: this.currentCpuUsage,
            memory: this.currentMemoryUsage,
            load: this.currentLoadAverage,
            totalMemory: this.totalMemory,
            freeMemory: this.freeMemory,
            memoryUsedMB: Math.round((this.totalMemory - this.freeMemory) / (1024 * 1024)),
            memoryTotalMB: Math.round(this.totalMemory / (1024 * 1024)),
            timestamp: this.lastSampleTime
        };
    }

    /**
     * Get complete resource history
     * @returns {Object} Complete resource usage history
     */
    getHistory() {
        return {
            cpu: [...this.cpuHistory],
            memory: [...this.memoryHistory],
            load: [...this.loadHistory]
        };
    }

    /**
     * Check if CPU usage exceeds the high threshold
     * @param {number} sampleCount - Number of recent samples to consider
     * @returns {boolean} True if CPU usage exceeds high threshold
     */
    isCpuOverloaded(sampleCount = 3) {
        return this.getAverageCpuUsage(sampleCount) > this.config.cpuHighThreshold;
    }

    /**
     * Check if CPU usage is below the low threshold
     * @param {number} sampleCount - Number of recent samples to consider
     * @returns {boolean} True if CPU usage is below low threshold
     */
    isCpuUnderused(sampleCount = 3) {
        return this.getAverageCpuUsage(sampleCount) < this.config.cpuLowThreshold;
    }

    /**
     * Check if memory usage exceeds the high threshold
     * @param {number} sampleCount - Number of recent samples to consider
     * @returns {boolean} True if memory usage exceeds high threshold
     */
    isMemoryOverloaded(sampleCount = 3) {
        return this.getAverageMemoryUsage(sampleCount) > this.config.memoryHighThreshold;
    }

    /**
     * Check if memory usage is below the low threshold
     * @param {number} sampleCount - Number of recent samples to consider
     * @returns {boolean} True if memory usage is below low threshold
     */
    isMemoryUnderused(sampleCount = 3) {
        return this.getAverageMemoryUsage(sampleCount) < this.config.memoryLowThreshold;
    }

    /**
     * Determine if system resources are overloaded
     * @returns {boolean} True if either CPU or memory is overloaded
     */
    isSystemOverloaded() {
        return this.isCpuOverloaded() || this.isMemoryOverloaded();
    }

    /**
     * Determine if system resources are underused
     * @returns {boolean} True if both CPU and memory are underused
     */
    isSystemUnderused() {
        return this.isCpuUnderused() && this.isMemoryUnderused();
    }

    /**
     * Get recommended concurrency adjustment based on resource usage
     * @param {number} currentConcurrency - Current concurrency level
     * @returns {Object} Recommendation with direction and reason
     */
    getRecommendedAdjustment(currentConcurrency) {
        const metrics = this.getCurrentMetrics();

        if (this.isSystemOverloaded()) {
            const reason = this.isCpuOverloaded()
                ? `CPU usage (${metrics.cpu.toFixed(1)}%) exceeds threshold (${this.config.cpuHighThreshold}%)`
                : `Memory usage (${metrics.memory.toFixed(1)}%) exceeds threshold (${this.config.memoryHighThreshold}%)`;

            return {
                direction: 'decrease',
                reason
            };
        }

        if (this.isSystemUnderused()) {
            return {
                direction: 'increase',
                reason: `Both CPU (${metrics.cpu.toFixed(1)}%) and memory (${metrics.memory.toFixed(1)}%) are below thresholds`
            };
        }

        return {
            direction: 'maintain',
            reason: 'System resources are within optimal range'
        };
    }
}

module.exports = ResourceMonitor;