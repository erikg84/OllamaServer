const axios = require('axios');
const { exec } = require('child_process');

class OllamaHealthMonitor {
    constructor(options) {
        this.apiUrl = options.apiUrl || 'http://127.0.0.1:11434';
        this.checkInterval = options.checkInterval || 30000; // 30 seconds default
        this.timeoutThreshold = options.timeoutThreshold || 10000; // 10 seconds response timeout
        this.maxFailedChecks = options.maxFailedChecks || 3;
        this.restartCommand = options.restartCommand || 'systemctl restart ollama';
        this.logger = options.logger;

        this.failedChecks = 0;
        this.healthCheckTimer = null;
    }

    start() {
        this.logger.info({ message: 'OllamaHealthMonitor started', timestamp: new Date().toISOString() });
        this.healthCheckTimer = setInterval(() => this.checkHealth(), this.checkInterval);
    }

    stop() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
            this.logger.info({ message: 'OllamaHealthMonitor stopped', timestamp: new Date().toISOString() });
        }
    }

    async checkHealth() {
        const startTime = Date.now();
        try {
            const response = await axios.get(`${this.apiUrl}/tags`, { timeout: this.timeoutThreshold });

            const responseTime = Date.now() - startTime;
            if (responseTime > this.timeoutThreshold) {
                this.logger.warn({
                    message: 'Ollama service response slow',
                    responseTime,
                    timestamp: new Date().toISOString()
                });
                this.failedChecks += 1;
            } else {
                this.failedChecks = 0; // Reset on success
                this.logger.info({
                    message: 'Ollama service healthy',
                    responseTime,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            this.failedChecks += 1;
            this.logger.error({
                message: 'Ollama service health check failed',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }

        if (this.failedChecks >= this.maxFailedChecks) {
            this.logger.error({
                message: 'Ollama service considered unhealthy. Initiating restart.',
                failedChecks: this.failedChecks,
                timestamp: new Date().toISOString()
            });
            this.restartService();
            this.failedChecks = 0; // Reset counter after attempting restart
        }
    }

    restartService() {
        this.logger.warn({ message: 'Restarting Ollama service', timestamp: new Date().toISOString() });
        exec(this.restartCommand, (error, stdout, stderr) => {
            if (error) {
                this.logger.error({
                    message: 'Ollama restart failed',
                    error: error.message,
                    stderr,
                    timestamp: new Date().toISOString()
                });
                return;
            }
            this.logger.info({
                message: 'Ollama restarted successfully',
                stdout,
                timestamp: new Date().toISOString()
            });
        });
    }
}

module.exports = OllamaHealthMonitor;
