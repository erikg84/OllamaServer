// src/config/index.js

/**
 * Central configuration module
 * Exports all configurations from a single point
 */
const serverConfig = require('./server.config');
const loggingConfig = require('./logging.config');

// Export all configuration objects
module.exports = {
    serverConfig,
    loggingConfig
};