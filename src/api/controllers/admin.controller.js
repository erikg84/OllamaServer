// src/api/controllers/admin.controller.js
const logger = require('../../logging/logger');
const os = require('os');

/**
 * Get system metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function getMetrics(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Metrics requested',
        requestId,
        endpoint: '/admin/metrics',
        timestamp: new Date().toISOString()
    });

    try {
        const metricsManager = req.app.locals.metricsManager;

        if (!metricsManager) {
            logger.error({
                message: 'Metrics manager not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        // Add memory and CPU stats to metrics response
        const systemStats = {
            cpuUsage: process.cpuUsage().user / 1000000,
            memoryUsage: {
                rss: Math.round(process.memoryUsage().rss / (1024 * 1024)),
                heapTotal: Math.round(process.memoryUsage().heapTotal / (1024 * 1024)),
                heapUsed: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
                external: Math.round(process.memoryUsage().external / (1024 * 1024))
            },
            uptime: Math.floor((Date.now() - metricsManager.getStartTime()) / 1000)
        };

        const metrics = metricsManager.getMetrics();

        res.json({
            status: 'ok',
            data: {
                ...metrics,
                system: systemStats
            }
        });

        logger.info({
            message: 'Metrics request successful',
            requestId,
            metricTypes: Object.keys(metrics),
            nodeCount: Object.keys(metrics.nodePerformance || {}).length,
            modelCount: Object.keys(metrics.modelPerformance || {}).length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving metrics',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Get system information
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function getSystemInfo(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'System info requested',
        requestId,
        endpoint: '/admin/system',
        timestamp: new Date().toISOString()
    });

    try {
        const metricsManager = req.app.locals.metricsManager;

        if (!metricsManager) {
            logger.error({
                message: 'Metrics manager not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        const uptime = Math.floor((Date.now() - metricsManager.getStartTime()) / 1000);
        const memoryUsage = process.memoryUsage();
        const cpuInfo = os.cpus();
        const serverConfig = req.app.locals.serverConfig;

        const systemInfo = {
            apiVersion: serverConfig.version,
            uptime: uptime,
            uptimeFormatted: formatUptime(uptime),
            cpuUsage: process.cpuUsage().user / 1000000,
            cpuInfo: {
                cores: cpuInfo.length,
                model: cpuInfo[0].model,
                speed: cpuInfo[0].speed
            },
            memoryUsage: {
                used: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
                total: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
                rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
                heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
                heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
                external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
            },
            diskUsage: {
                used: 'N/A',
                total: 'N/A'
            },
            platform: os.platform(),
            arch: os.arch(),
            hostname: os.hostname(),
            networkInterfaces: getNetworkInfo(),
            nodeJsVersion: process.version,
            expressVersion: require('express/package.json').version,
            environment: process.env.NODE_ENV || 'development',
            serverId: req.app.locals.serverId
        };

        res.json({
            status: 'ok',
            data: systemInfo
        });

        logger.info({
            message: 'System info request successful',
            requestId,
            uptime: systemInfo.uptimeFormatted,
            memory: systemInfo.memoryUsage.used,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving system info',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Reset metrics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function resetStats(req, res, next) {
    const requestId = req.id;

    logger.info({
        message: 'Stats reset requested',
        requestId,
        endpoint: '/admin/reset-stats',
        timestamp: new Date().toISOString()
    });

    try {
        const metricsManager = req.app.locals.metricsManager;

        if (!metricsManager) {
            logger.error({
                message: 'Metrics manager not initialized',
                requestId,
                reason: 'Server still initializing',
                timestamp: new Date().toISOString()
            });
            return res.status(503).json({ status: 'error', message: 'Server initializing' });
        }

        // Get current metrics summary before reset for logging
        const metrics = metricsManager.getMetrics();
        const nodeCount = Object.keys(metrics.nodePerformance || {}).length;
        const modelCount = Object.keys(metrics.modelPerformance || {}).length;

        // Reset metrics
        metricsManager.resetMetrics();

        logger.info({
            message: 'Stats reset successful',
            requestId,
            previousNodeCount: nodeCount,
            previousModelCount: modelCount,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'ok',
            message: 'Statistics reset successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error({
            message: 'Error resetting stats',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Get logs
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function getLogs(req, res, next) {
    const requestId = req.id;
    const { level, limit = 100, page = 1, startDate, endDate } = req.query;

    logger.info({
        message: 'Logs requested',
        requestId,
        level,
        limit,
        page,
        startDate,
        endDate,
        endpoint: '/admin/logs',
        timestamp: new Date().toISOString()
    });

    try {
        // In a production environment, this would query the MongoDB database
        // For now, we'll just return a placeholder response

        logger.info({
            message: 'Log query complete',
            requestId,
            level,
            limit,
            page,
            timestamp: new Date().toISOString()
        });

        // Example response - in production this would be actual log data
        const exampleLogs = [
            {
                timestamp: new Date().toISOString(),
                level: 'info',
                message: 'Server started',
                source: 'server.js',
                serverId: req.app.locals.serverId.ipAddress
            }
        ];

        res.json({
            status: 'ok',
            data: level ? exampleLogs.filter(entry => entry.level === level) : exampleLogs
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving logs',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        next(error);
    }
}

/**
 * Format uptime in a human-readable format
 * @param {number} seconds - Uptime in seconds
 * @returns {string} Formatted uptime string
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

/**
 * Get network interface information
 * @returns {Object} Network interface information
 */
function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const result = {};

    Object.keys(interfaces).forEach(iface => {
        const addresses = interfaces[iface]
            .filter(addr => !addr.internal)
            .map(addr => ({
                address: addr.address,
                family: addr.family,
                netmask: addr.netmask
            }));

        if (addresses.length > 0) {
            result[iface] = addresses;
        }
    });

    return result;
}

module.exports = {
    getMetrics,
    getSystemInfo,
    resetStats,
    getLogs
};