// src/config/logging.config.js

/**
 * Logging configuration for the application
 * Centralizes all logging settings for consistent configuration
 */
const os = require('os');
const path = require('path');

// Get environment variables or use defaults
const logLevel = process.env.LOG_LEVEL || 'info';
const logDirPath = process.env.LOG_DIR_PATH || 'logs';
const mongoDbUrl = process.env.MONGODB_LOGS_URL || 'mongodb://localhost:27017/logs';
const appName = process.env.APP_NAME || 'maestro-server';
const appVersion = process.env.APP_VERSION || '1.0.0';

// Generate a unique server ID based on hostname, IP, and process ID
const serverId = `${os.hostname()}-${require('ip').address()}-${process.pid}`;

/**
 * Logging configuration object
 */
const loggingConfig = {
    // Log level: error, warn, info, verbose, debug, silly
    level: logLevel,

    // Server identifier for distributed setups
    serverId,

    // Application information
    appName,
    appVersion,

    // Log file paths
    logFilePath: path.join(logDirPath, 'server.log'),
    exceptionsFilePath: path.join(logDirPath, 'exceptions.log'),

    // MongoDB connection for centralized logging
    mongoDbUrl,

    // Collection names for different log types
    logCollection: 'logs',
    exceptionCollection: 'exceptions',
    requestCollection: 'requests',

    // Log rotation settings
    maxSize: 10485760, // 10MB
    maxFiles: 10,

    // Console logging settings
    console: {
        enabled: true,
        colorize: true,
        prettyPrint: process.env.NODE_ENV !== 'production'
    },

    // Log sanitization options
    sanitize: {
        // Fields to sanitize
        sensitiveFields: ['password', 'token', 'apiKey', 'secret', 'authorization'],

        // Maximum length of fields before truncation
        maxFieldLength: 100,

        // Replacement text for sensitive fields
        redactionText: '[REDACTED]',

        // Replacement text for truncated content
        truncationSuffix: '... [TRUNCATED]'
    }
};

module.exports = loggingConfig;