/**
 * GpuMonitor - Monitors GPU utilization and memory for LLM workload optimization
 *
 * This class interfaces with NVIDIA tools to track GPU metrics and provide
 * recommendations for optimal concurrency and load distribution based on
 * GPU performance characteristics.
 */
class GpuMonitor {
    /**
     * Constructor for GpuMonitor
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            // How often to sample GPU metrics (ms)
            sampleInterval: config.sampleInterval || 5000,

            // History length for metrics
            historyLength: config.historyLength || 100,

            // Whether to start monitoring immediately
            autoStart: config.autoStart !== undefined ? config.autoStart : true,

            // Path to nvidia-smi executable
            nvidiaSmiPath: config.nvidiaSmiPath || 'nvidia-smi',

            // GPU utilization thresholds
            utilizationHighThreshold: config.utilizationHighThreshold || 85,
            utilizationLowThreshold: config.utilizationLowThreshold || 30,

            // GPU memory thresholds (%)
            memoryHighThreshold: config.memoryHighThreshold || 85,
            memoryLowThreshold: config.memoryLowThreshold || 40,

            // GPU temperature thresholds (°C)
            temperatureHighThreshold: config.temperatureHighThreshold || 80,
            temperatureWarningThreshold: config.temperatureWarningThreshold || 70,

            // Per-model GPU memory requirements (MB)
            modelMemoryRequirements: config.modelMemoryRequirements || {
                default: 2000 // Default for unknown models
            },

            // Logger instance
            logger: config.logger || console,

            ...config
        };

        // GPU information
        this.gpuInfo = {
            detected: false,
            count: 0,
            devices: []
        };

        // Metrics history
        this.history = [];

        // Current metrics
        this.currentMetrics = {
            timestamp: 0,
            gpus: []
        };

        // Monitoring state
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.lastSampleTime = 0;

        // Statistics
        this.stats = {
            samplesCollected: 0,
            errorsEncountered: 0,
            lastErrorTime: 0,
            lastErrorMessage: '',
            startTime: Date.now()
        };

        // Load required modules
        this.child_process = require('child_process');
        this.os = require('os');

        // Bind methods to maintain 'this' context
        this.checkGpuAvailability = this.checkGpuAvailability.bind(this);
        this.sampleMetrics = this.sampleMetrics.bind(this);
        this.start = this.start.bind(this);
        this.stop = this.stop.bind(this);

        // Initialize by checking for GPU
        this.checkGpuAvailability();

        // Start monitoring if configured and GPU is available
        if (this.config.autoStart && this.gpuInfo.detected) {
            this.start();
        }
    }

    /**
     * Check if NVIDIA GPU is available
     * @returns {boolean} Whether GPU was detected
     */
    checkGpuAvailability() {
        try {
            this.config.logger.info({
                message: 'Checking GPU availability',
                nvidiaSmiPath: this.config.nvidiaSmiPath,
                timestamp: new Date().toISOString()
            });

            // Run nvidia-smi to check for GPU and get device count
            const output = this.child_process.execSync(
                `${this.config.nvidiaSmiPath} --query-gpu=count --format=csv,noheader`,
                { encoding: 'utf8' }
            ).trim();

            const gpuCount = parseInt(output, 10);

            if (isNaN(gpuCount) || gpuCount === 0) {
                this.config.logger.warn({
                    message: 'No NVIDIA GPUs detected',
                    output,
                    timestamp: new Date().toISOString()
                });

                this.gpuInfo.detected = false;
                this.gpuInfo.count = 0;
                this.gpuInfo.devices = [];

                return false;
            }

            // GPU detected, get basic information
            this.gpuInfo.detected = true;
            this.gpuInfo.count = gpuCount;
            this.gpuInfo.devices = [];

            // Get details for each GPU
            for (let i = 0; i < gpuCount; i++) {
                const deviceInfo = this.getGpuDeviceInfo(i);
                this.gpuInfo.devices.push(deviceInfo);
            }

            this.config.logger.info({
                message: 'NVIDIA GPUs detected',
                count: this.gpuInfo.count,
                devices: this.gpuInfo.devices.map(d => d.name),
                totalMemory: this.gpuInfo.devices.reduce((sum, d) => sum + d.memoryTotal, 0) + ' MB',
                timestamp: new Date().toISOString()
            });

            return true;
        } catch (error) {
            this.config.logger.warn({
                message: 'Error checking GPU availability',
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });

            this.gpuInfo.detected = false;
            this.gpuInfo.count = 0;
            this.gpuInfo.devices = [];

            this.stats.errorsEncountered++;
            this.stats.lastErrorTime = Date.now();
            this.stats.lastErrorMessage = error.message;

            return false;
        }
    }

    /**
     * Get detailed information about a specific GPU device
     * @param {number} deviceIndex - Index of the GPU device
     * @returns {Object} GPU device information
     */
    getGpuDeviceInfo(deviceIndex) {
        try {
            // Query for detailed information about this GPU
            const infoCommand = `${this.config.nvidiaSmiPath} --query-gpu=name,memory.total,driver_version,pstate,compute_mode --format=csv,noheader -i ${deviceIndex}`;
            const infoOutput = this.child_process.execSync(infoCommand, { encoding: 'utf8' }).trim();
            const infoParts = infoOutput.split(',').map(part => part.trim());

            // Parse memory total (convert from MiB to MB)
            const memoryTotalStr = infoParts[1] || '0 MiB';
            const memoryTotal = parseInt(memoryTotalStr.replace(' MiB', ''), 10);

            return {
                index: deviceIndex,
                name: infoParts[0] || 'Unknown',
                memoryTotal,
                driverVersion: infoParts[2] || 'Unknown',
                performanceState: infoParts[3] || 'Unknown',
                computeMode: infoParts[4] || 'Unknown'
            };
        } catch (error) {
            this.config.logger.warn({
                message: 'Error getting GPU device information',
                deviceIndex,
                error: error.message,
                timestamp: new Date().toISOString()
            });

            return {
                index: deviceIndex,
                name: 'Unknown',
                memoryTotal: 0,
                driverVersion: 'Unknown',
                performanceState: 'Unknown',
                computeMode: 'Unknown'
            };
        }
    }

    /**
     * Start GPU monitoring
     * @returns {boolean} True if monitoring started, false if unavailable or already running
     */
    start() {
        if (!this.gpuInfo.detected) {
            this.config.logger.warn({
                message: 'Cannot start GPU monitoring - no GPUs detected',
                timestamp: new Date().toISOString()
            });
            return false;
        }

        if (this.isMonitoring) {
            this.config.logger.info({
                message: 'GPU monitoring already running',
                timestamp: new Date().toISOString()
            });
            return false;
        }

        // Take an initial sample immediately
        this.sampleMetrics();

        // Set up regular sampling interval
        this.monitoringInterval = setInterval(this.sampleMetrics, this.config.sampleInterval);
        this.isMonitoring = true;

        this.config.logger.info({
            message: 'GPU monitoring started',
            sampleInterval: `${this.config.sampleInterval}ms`,
            gpuCount: this.gpuInfo.count,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Stop GPU monitoring
     * @returns {boolean} True if monitoring stopped, false if not running
     */
    stop() {
        if (!this.isMonitoring) {
            return false;
        }

        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;
        this.isMonitoring = false;

        this.config.logger.info({
            message: 'GPU monitoring stopped',
            sampleCount: this.stats.samplesCollected,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Sample current GPU metrics
     * @returns {Object|null} Current GPU metrics or null if unavailable
     */
    sampleMetrics() {
        if (!this.gpuInfo.detected) {
            return null;
        }

        try {
            this.lastSampleTime = Date.now();

            // Query for current metrics across all GPUs
            const metricsCommand = `${this.config.nvidiaSmiPath} --query-gpu=index,utilization.gpu,utilization.memory,memory.used,memory.free,temperature.gpu,power.draw --format=csv,noheader`;
            const metricsOutput = this.child_process.execSync(metricsCommand, { encoding: 'utf8' });

            // Create metrics object
            const metrics = {
                timestamp: this.lastSampleTime,
                gpus: []
            };

            // Parse each GPU's metrics
            const lines = metricsOutput.trim().split('\n');

            for (const line of lines) {
                const parts = line.split(',').map(part => part.trim());

                // Parse index
                const index = parseInt(parts[0], 10);

                // Parse utilization (remove the % sign)
                const gpuUtilization = parseInt(parts[1].replace(' %', ''), 10);
                const memoryUtilization = parseInt(parts[2].replace(' %', ''), 10);

                // Parse memory usage (convert from MiB to MB)
                const memoryUsed = parseInt(parts[3].replace(' MiB', ''), 10);
                const memoryFree = parseInt(parts[4].replace(' MiB', ''), 10);

                // Parse temperature (remove the C sign)
                const temperature = parseInt(parts[5].replace(' C', ''), 10);

                // Parse power draw (remove the W sign)
                const powerDraw = parseFloat(parts[6].replace(' W', ''));

                // Get total memory for this device
                const deviceInfo = this.gpuInfo.devices.find(d => d.index === index);
                const memoryTotal = deviceInfo ? deviceInfo.memoryTotal : (memoryUsed + memoryFree);

                // Calculate memory utilization percentage
                const memoryUtilizationPercent = Math.round((memoryUsed / memoryTotal) * 100);

                metrics.gpus.push({
                    index,
                    name: deviceInfo ? deviceInfo.name : `GPU ${index}`,
                    utilization: {
                        gpu: gpuUtilization,
                        memory: memoryUtilization,
                        // Actual memory utilization percentage based on used/total
                        memoryPercent: memoryUtilizationPercent
                    },
                    memory: {
                        used: memoryUsed,
                        free: memoryFree,
                        total: memoryTotal
                    },
                    temperature,
                    powerDraw,
                    state: this.determineGpuState(gpuUtilization, memoryUtilizationPercent, temperature)
                });
            }

            // Update current metrics
            this.currentMetrics = metrics;

            // Add to history
            this.history.push(metrics);
            if (this.history.length > this.config.historyLength) {
                this.history.shift();
            }

            // Update stats
            this.stats.samplesCollected++;

            // Only log at debug level to avoid flooding logs
            this.config.logger.debug({
                message: 'GPU metrics sampled',
                gpuCount: metrics.gpus.length,
                timestamp: new Date(this.lastSampleTime).toISOString()
            });

            return metrics;
        } catch (error) {
            this.config.logger.error({
                message: 'Error sampling GPU metrics',
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });

            this.stats.errorsEncountered++;
            this.stats.lastErrorTime = Date.now();
            this.stats.lastErrorMessage = error.message;

            return null;
        }
    }

    /**
     * Determine GPU state based on utilization and temperature
     * @param {number} utilization - GPU utilization percentage
     * @param {number} memoryUtilization - Memory utilization percentage
     * @param {number} temperature - GPU temperature in Celsius
     * @returns {string} GPU state ('idle', 'normal', 'busy', 'overloaded', 'temperature_warning')
     */
    determineGpuState(utilization, memoryUtilization, temperature) {
        // Check temperature first (highest priority)
        if (temperature >= this.config.temperatureHighThreshold) {
            return 'temperature_critical';
        }

        if (temperature >= this.config.temperatureWarningThreshold) {
            return 'temperature_warning';
        }

        // Check utilization and memory
        if (utilization >= this.config.utilizationHighThreshold ||
            memoryUtilization >= this.config.memoryHighThreshold) {
            return 'overloaded';
        }

        if (utilization >= 50 || memoryUtilization >= 50) {
            return 'busy';
        }

        if (utilization <= this.config.utilizationLowThreshold &&
            memoryUtilization <= this.config.memoryLowThreshold) {
            return 'idle';
        }

        return 'normal';
    }

    /**
     * Get current GPU metrics
     * @returns {Object|null} Current GPU metrics or null if unavailable
     */
    getCurrentMetrics() {
        if (!this.gpuInfo.detected) {
            return null;
        }

        return this.currentMetrics;
    }

    /**
     * Get GPU metrics history
     * @param {number} limit - Maximum number of history entries to return
     * @returns {Array} GPU metrics history
     */
    getMetricsHistory(limit = this.config.historyLength) {
        return this.history.slice(-limit);
    }

    /**
     * Get average GPU metrics over a time period
     * @param {number} sampleCount - Number of recent samples to average
     * @returns {Object|null} Average GPU metrics or null if unavailable
     */
    getAverageMetrics(sampleCount = 10) {
        if (!this.gpuInfo.detected || this.history.length === 0) {
            return null;
        }

        // Get the most recent samples
        const recentSamples = this.history.slice(-Math.min(sampleCount, this.history.length));

        // Create result structure
        const result = {
            timestamp: Date.now(),
            samplesPeriod: {
                start: recentSamples[0].timestamp,
                end: recentSamples[recentSamples.length - 1].timestamp,
                count: recentSamples.length
            },
            gpus: []
        };

        // Initialize GPU entries
        for (let i = 0; i < this.gpuInfo.count; i++) {
            result.gpus[i] = {
                index: i,
                name: this.gpuInfo.devices[i].name,
                utilization: {
                    gpu: 0,
                    memory: 0,
                    memoryPercent: 0
                },
                memory: {
                    used: 0,
                    free: 0,
                    total: this.gpuInfo.devices[i].memoryTotal
                },
                temperature: 0,
                powerDraw: 0
            };
        }

        // Sum metrics for averaging
        for (const sample of recentSamples) {
            for (const gpu of sample.gpus) {
                const index = gpu.index;

                result.gpus[index].utilization.gpu += gpu.utilization.gpu;
                result.gpus[index].utilization.memory += gpu.utilization.memory;
                result.gpus[index].utilization.memoryPercent += gpu.utilization.memoryPercent;
                result.gpus[index].memory.used += gpu.memory.used;
                result.gpus[index].memory.free += gpu.memory.free;
                result.gpus[index].temperature += gpu.temperature;
                result.gpus[index].powerDraw += gpu.powerDraw;
            }
        }

        // Calculate averages
        for (const gpu of result.gpus) {
            gpu.utilization.gpu = Math.round(gpu.utilization.gpu / recentSamples.length);
            gpu.utilization.memory = Math.round(gpu.utilization.memory / recentSamples.length);
            gpu.utilization.memoryPercent = Math.round(gpu.utilization.memoryPercent / recentSamples.length);
            gpu.memory.used = Math.round(gpu.memory.used / recentSamples.length);
            gpu.memory.free = Math.round(gpu.memory.free / recentSamples.length);
            gpu.temperature = Math.round(gpu.temperature / recentSamples.length);
            gpu.powerDraw = parseFloat((gpu.powerDraw / recentSamples.length).toFixed(2));

            // Add state based on average metrics
            gpu.state = this.determineGpuState(
                gpu.utilization.gpu,
                gpu.utilization.memoryPercent,
                gpu.temperature
            );
        }

        return result;
    }

    /**
     * Check if any GPU is overloaded
     * @param {number} sampleCount - Number of recent samples to check
     * @returns {boolean} True if any GPU is overloaded
     */
    isAnyGpuOverloaded(sampleCount = 3) {
        if (!this.gpuInfo.detected) {
            return false;
        }

        const avgMetrics = this.getAverageMetrics(sampleCount);
        if (!avgMetrics) {
            return false;
        }

        return avgMetrics.gpus.some(gpu => {
            return gpu.state === 'overloaded' ||
                gpu.state === 'temperature_warning' ||
                gpu.state === 'temperature_critical';
        });
    }

    /**
     * Check if any GPU is underutilized
     * @param {number} sampleCount - Number of recent samples to check
     * @returns {boolean} True if any GPU is underutilized
     */
    isAnyGpuUnderutilized(sampleCount = 3) {
        if (!this.gpuInfo.detected) {
            return false;
        }

        const avgMetrics = this.getAverageMetrics(sampleCount);
        if (!avgMetrics) {
            return false;
        }

        return avgMetrics.gpus.some(gpu => gpu.state === 'idle');
    }

    /**
     * Get recommended concurrency adjustment based on GPU metrics
     * @param {string} modelId - Model ID for specific recommendations
     * @param {number} currentConcurrency - Current concurrency level
     * @returns {Object} Recommendation with direction and reason
     */
    getRecommendedConcurrency(modelId, currentConcurrency = 1) {
        if (!this.gpuInfo.detected) {
            return {
                direction: 'maintain',
                concurrency: currentConcurrency,
                reason: 'No GPU detected'
            };
        }

        // Get average metrics
        const avgMetrics = this.getAverageMetrics(5);
        if (!avgMetrics) {
            return {
                direction: 'maintain',
                concurrency: currentConcurrency,
                reason: 'Insufficient GPU metrics history'
            };
        }

        // Check for temperature issues first (highest priority)
        const temperatureIssue = avgMetrics.gpus.find(gpu =>
            gpu.state === 'temperature_critical' || gpu.state === 'temperature_warning'
        );

        if (temperatureIssue) {
            return {
                direction: 'decrease',
                concurrency: Math.max(1, currentConcurrency - 1),
                reason: `GPU temperature too high (${temperatureIssue.temperature}°C)`
            };
        }

        // Check for overloaded GPUs
        const overloadedGpu = avgMetrics.gpus.find(gpu => gpu.state === 'overloaded');
        if (overloadedGpu) {
            return {
                direction: 'decrease',
                concurrency: Math.max(1, currentConcurrency - 1),
                reason: `GPU overloaded (${overloadedGpu.utilization.gpu}% GPU, ${overloadedGpu.utilization.memoryPercent}% memory)`
            };
        }

        // Check for underutilized GPUs
        const allUnderutilized = avgMetrics.gpus.every(gpu => gpu.state === 'idle');
        if (allUnderutilized) {
            return {
                direction: 'increase',
                concurrency: currentConcurrency + 1,
                reason: 'All GPUs underutilized'
            };
        }

        // Calculate memory-based maximum concurrency for this model
        const maxConcurrencyByMemory = this.getMaxConcurrencyByMemory(modelId);

        if (currentConcurrency >= maxConcurrencyByMemory) {
            return {
                direction: 'maintain',
                concurrency: maxConcurrencyByMemory,
                reason: `Maximum safe concurrency for memory requirements (${modelId})`
            };
        }

        // Default case - maintain current level
        return {
            direction: 'maintain',
            concurrency: currentConcurrency,
            reason: 'GPU utilization within optimal range'
        };
    }

    /**
     * Calculate maximum concurrency based on available GPU memory
     * @param {string} modelId - Model ID to calculate for
     * @returns {number} Maximum safe concurrency
     */
    getMaxConcurrencyByMemory(modelId) {
        if (!this.gpuInfo.detected) {
            return 1;
        }

        // Get memory requirement for this model
        const memoryRequirement = this.getModelGpuMemoryRequirement(modelId);

        // Get current memory available
        const currentMetrics = this.getCurrentMetrics();
        if (!currentMetrics) {
            return 1;
        }

        // Find GPU with most available memory
        const bestGpu = currentMetrics.gpus.reduce((best, current) => {
            return (current.memory.free > best.memory.free) ? current : best;
        }, currentMetrics.gpus[0]);

        // Calculate safe concurrent instances based on available memory
        // Leave 10% buffer for system operations
        const safeBuffer = 0.1;
        const effectiveFreeMem = bestGpu.memory.free * (1 - safeBuffer);
        const maxInstances = Math.floor(effectiveFreeMem / memoryRequirement);

        // Ensure at least 1 instance is allowed
        return Math.max(1, maxInstances);
    }

    /**
     * Get memory requirement for a specific model
     * @param {string} modelId - Model identifier
     * @returns {number} Memory requirement in MB
     */
    getModelGpuMemoryRequirement(modelId) {
        // Look up model-specific memory requirement
        if (this.config.modelMemoryRequirements[modelId]) {
            return this.config.modelMemoryRequirements[modelId];
        }

        // Use default if not specified
        return this.config.modelMemoryRequirements.default;
    }

    /**
     * Get detailed GPU status for monitoring
     * @returns {Object} GPU status and statistics
     */
    getStatus() {
        if (!this.gpuInfo.detected) {
            return {
                available: false,
                reason: 'No GPU detected',
                lastDetectionAttempt: new Date(this.stats.startTime).toISOString()
            };
        }

        const status = {
            available: true,
            count: this.gpuInfo.count,
            isMonitoring: this.isMonitoring,
            devices: this.gpuInfo.devices.map(device => ({
                index: device.index,
                name: device.name,
                memoryTotal: `${device.memoryTotal} MB`,
                driverVersion: device.driverVersion,
                performanceState: device.performanceState
            })),
            currentMetrics: this.currentMetrics,
            averageMetrics: this.getAverageMetrics(5),
            stats: {
                samplesCollected: this.stats.samplesCollected,
                errorsEncountered: this.stats.errorsEncountered,
                lastSample: this.lastSampleTime ? new Date(this.lastSampleTime).toISOString() : null,
                uptime: Date.now() - this.stats.startTime
            },
            config: {
                sampleInterval: this.config.sampleInterval,
                historyLength: this.config.historyLength,
                thresholds: {
                    utilizationHigh: this.config.utilizationHighThreshold,
                    utilizationLow: this.config.utilizationLowThreshold,
                    memoryHigh: this.config.memoryHighThreshold,
                    memoryLow: this.config.memoryLowThreshold,
                    temperatureHigh: this.config.temperatureHighThreshold,
                    temperatureWarning: this.config.temperatureWarningThreshold
                }
            }
        };

        // Add per-model recommendations
        status.modelRecommendations = {};
        for (const modelId in this.config.modelMemoryRequirements) {
            status.modelRecommendations[modelId] = {
                memoryRequirement: `${this.getModelGpuMemoryRequirement(modelId)} MB`,
                maxConcurrency: this.getMaxConcurrencyByMemory(modelId)
            };
        }

        return status;
    }

    /**
     * Get concurrency recommendations for all models
     * @returns {Object} Concurrency recommendations by model
     */
    getAllModelConcurrencyRecommendations() {
        if (!this.gpuInfo.detected) {
            return {
                gpuAvailable: false,
                recommendations: {}
            };
        }

        const recommendations = {};

        for (const modelId in this.config.modelMemoryRequirements) {
            recommendations[modelId] = {
                maxConcurrency: this.getMaxConcurrencyByMemory(modelId),
                memoryRequirement: this.getModelGpuMemoryRequirement(modelId)
            };
        }

        return {
            gpuAvailable: true,
            gpuCount: this.gpuInfo.count,
            currentState: this.currentMetrics.gpus.map(gpu => gpu.state),
            recommendations
        };
    }

    /**
     * Update model memory requirements
     * @param {Object} requirements - New memory requirements by model ID
     * @returns {boolean} Success indicator
     */
    updateModelMemoryRequirements(requirements) {
        if (!requirements || typeof requirements !== 'object') {
            return false;
        }

        this.config.modelMemoryRequirements = {
            ...this.config.modelMemoryRequirements,
            ...requirements
        };

        this.config.logger.info({
            message: 'GPU model memory requirements updated',
            modelCount: Object.keys(requirements).length,
            timestamp: new Date().toISOString()
        });

        return true;
    }
}

module.exports = GpuMonitor;