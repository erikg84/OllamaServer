// src/config/server.config.js

/**
 * Server configuration for the application
 * Centralizes all server settings for consistent configuration
 */
const os = require('os');
const pkg = require('../../package.json');

// Get environment variables or use defaults
const port = process.env.PORT || 3000;
const environment = process.env.NODE_ENV || 'development';
const apiVersion = process.env.API_VERSION || 'v1';
const llamaApiUrl = process.env.LLAMA_API_URL || 'http://localhost:11434/api';

/**
 * Server configuration object
 */
const serverConfig = {
    // Basic server settings
    port,
    host: process.env.HOST || '0.0.0.0',

    // Environment information
    environment,
    isDevelopment: environment === 'development',
    isProduction: environment === 'production',
    isTest: environment === 'test',

    // API configuration
    apiVersion,
    apiPrefix: process.env.API_PREFIX || '',
    baseUrl: process.env.BASE_URL || `http://localhost:${port}`,

    // Version information
    version: pkg.version,
    name: pkg.name,

    // External service URLs
    llamaApiUrl,

    // Timeout settings (in milliseconds)
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT, 10) || 120000, // 2 minutes
    responseTimeout: parseInt(process.env.RESPONSE_TIMEOUT, 10) || 300000, // 5 minutes

    // Rate limiting settings
    rateLimit: {
        windowMs: 60 * 1000, // 1 minute
        max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 60, // 60 requests per minute
        standardHeaders: true,
        legacyHeaders: false
    },

    // CORS settings
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-ID']
    },

    // Queue settings
    queue: {
        concurrency: parseInt(process.env.QUEUE_CONCURRENCY, 10) || 5,
        autoStart: true,
        timeout: parseInt(process.env.QUEUE_TIMEOUT, 10) || 600000 // 10 minutes
    },

    // System resources
    system: {
        cpuCores: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem()
    },

    // Request body size limits
    bodyLimit: '50mb',

    // MAESTRO-specific settings
    maestro: {
        enableAgentOrchestration: process.env.ENABLE_AGENT_ORCHESTRATION === 'true' || false,
        maxAgentsPerTask: parseInt(process.env.MAX_AGENTS_PER_TASK, 10) || 5,
        defaultWorkflowTemplate: process.env.DEFAULT_WORKFLOW_TEMPLATE || 'sequential',
        agentCommunicationTimeout: parseInt(process.env.AGENT_COMMUNICATION_TIMEOUT, 10) || 30000
    }
};

module.exports = serverConfig;