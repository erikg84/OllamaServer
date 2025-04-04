// src/utils/system-info.util.js
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

/**
 * Utility for gathering system information
 * Provides methods to collect various system metrics
 */

/**
 * Get basic system information
 * @returns {Object} Basic system information
 */
function getBasicInfo() {
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        type: os.type(),
        nodeVersion: process.version,
        uptime: os.uptime(),
        uptimeFormatted: formatUptime(os.uptime())
    };
}

/**
 * Get CPU information
 * @returns {Object} CPU information
 */
function getCpuInfo() {
    const cpus = os.cpus();
    const cpuCount = cpus.length;
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
    const cpuSpeed = cpus.length > 0 ? cpus[0].speed : 0;
    const loadAvg = os.loadavg();

    // Calculate CPU usage
    let cpuUsage = 0;
    try {
        const startUsage = process.cpuUsage();
        // Measure over 100ms
        const startTime = Date.now();
        while (Date.now() - startTime < 100) {
            // Busy wait to measure CPU usage
        }
        const endUsage = process.cpuUsage(startUsage);
        cpuUsage = (endUsage.user + endUsage.system) / 1000; // Convert to ms
    } catch (error) {
        cpuUsage = -1; // Unable to measure
    }

    return {
        count: cpuCount,
        model: cpuModel,
        speed: cpuSpeed,
        loadAvg,
        usage: cpuUsage
    };
}

/**
 * Get memory information
 * @returns {Object} Memory information
 */
function getMemoryInfo() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryUsage = process.memoryUsage();

    return {
        total: totalMemory,
        totalFormatted: formatBytes(totalMemory),
        free: freeMemory,
        freeFormatted: formatBytes(freeMemory),
        used: usedMemory,
        usedFormatted: formatBytes(usedMemory),
        usedPercent: Math.round((usedMemory / totalMemory) * 100),
        process: {
            rss: memoryUsage.rss,
            rssFormatted: formatBytes(memoryUsage.rss),
            heapTotal: memoryUsage.heapTotal,
            heapTotalFormatted: formatBytes(memoryUsage.heapTotal),
            heapUsed: memoryUsage.heapUsed,
            heapUsedFormatted: formatBytes(memoryUsage.heapUsed),
            external: memoryUsage.external,
            externalFormatted: formatBytes(memoryUsage.external)
        }
    };
}

/**
 * Get network information
 * @returns {Object} Network information
 */
function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const result = {};

    Object.keys(interfaces).forEach(ifaceName => {
        const addresses = interfaces[ifaceName].filter(iface => !iface.internal);

        if (addresses.length > 0) {
            result[ifaceName] = addresses.map(iface => ({
                address: iface.address,
                family: iface.family,
                netmask: iface.netmask,
                mac: iface.mac,
                cidr: iface.cidr
            }));
        }
    });

    return result;
}

/**
 * Get disk information
 * @returns {Promise<Object>} Disk information
 */
async function getDiskInfo() {
    let diskInfo = {
        error: null,
        total: 0,
        totalFormatted: 'Unknown',
        free: 0,
        freeFormatted: 'Unknown',
        used: 0,
        usedFormatted: 'Unknown',
        usedPercent: 0
    };

    try {
        // Different commands based on OS
        if (os.platform() === 'win32') {
            const output = execSync('wmic logicaldisk get size,freespace,caption').toString();
            const lines = output.trim().split('\n');
            let totalSize = 0;
            let totalFree = 0;

            // Skip header line
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].trim().split(/\s+/);
                if (parts.length >= 3) {
                    const freeSpace = parseInt(parts[1], 10);
                    const size = parseInt(parts[2], 10);
                    if (!isNaN(freeSpace) && !isNaN(size)) {
                        totalFree += freeSpace;
                        totalSize += size;
                    }
                }
            }

            const totalUsed = totalSize - totalFree;

            diskInfo = {
                error: null,
                total: totalSize,
                totalFormatted: formatBytes(totalSize),
                free: totalFree,
                freeFormatted: formatBytes(totalFree),
                used: totalUsed,
                usedFormatted: formatBytes(totalUsed),
                usedPercent: Math.round((totalUsed / totalSize) * 100)
            };
        } else if (os.platform() === 'linux' || os.platform() === 'darwin') {
            const output = execSync('df -k / | tail -1').toString();
            const parts = output.trim().split(/\s+/);

            if (parts.length >= 5) {
                const total = parseInt(parts[1], 10) * 1024; // Convert KB to bytes
                const used = parseInt(parts[2], 10) * 1024;
                const free = parseInt(parts[3], 10) * 1024;
                const usedPercent = parseInt(parts[4], 10);

                diskInfo = {
                    error: null,
                    total,
                    totalFormatted: formatBytes(total),
                    free,
                    freeFormatted: formatBytes(free),
                    used,
                    usedFormatted: formatBytes(used),
                    usedPercent
                };
            }
        } else {
            diskInfo.error = `Unsupported platform: ${os.platform()}`;
        }
    } catch (error) {
        diskInfo.error = error.message;
    }

    return diskInfo;
}

/**
 * Get process information
 * @returns {Object} Process information
 */
function getProcessInfo() {
    return {
        pid: process.pid,
        ppid: process.ppid,
        title: process.title,
        argv: process.argv,
        execPath: process.execPath,
        cwd: process.cwd(),
        env: {
            NODE_ENV: process.env.NODE_ENV,
            PORT: process.env.PORT,
            // Add other non-sensitive environment variables as needed
        },
        uptime: process.uptime(),
        uptimeFormatted: formatUptime(process.uptime()),
        resourceUsage: process.resourceUsage()
    };
}

/**
 * Get comprehensive system information
 * @param {boolean} includeDisk - Whether to include disk information
 * @returns {Promise<Object>} Comprehensive system information
 */
async function getSystemInfo(includeDisk = true) {
    const info = {
        timestamp: new Date().toISOString(),
        system: getBasicInfo(),
        cpu: getCpuInfo(),
        memory: getMemoryInfo(),
        network: getNetworkInfo(),
        process: getProcessInfo()
    };

    if (includeDisk) {
        info.disk = await getDiskInfo();
    }

    return info;
}

/**
 * Format bytes into human-readable string
 * @param {number} bytes - Bytes to format
 * @param {number} decimals - Decimal places
 * @returns {string} Formatted string
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
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
 * Get server identity information
 * @returns {Object} Server identity
 */
function getServerIdentity() {
    const ip = require('ip');

    return {
        hostname: os.hostname(),
        ipAddress: ip.address(),
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        serverId: `${os.hostname()}-${ip.address()}-${process.pid}`
    };
}

module.exports = {
    getBasicInfo,
    getCpuInfo,
    getMemoryInfo,
    getNetworkInfo,
    getDiskInfo,
    getProcessInfo,
    getSystemInfo,
    getServerIdentity,
    formatBytes,
    formatUptime
};