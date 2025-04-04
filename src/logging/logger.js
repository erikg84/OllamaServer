// src/logging/logger.js
const winston = require('winston');
require('winston-mongodb');
const { loggingConfig } = require('../config');
const os = require('os');

// Logger setup
const logger = winston.createLogger({
    level: loggingConfig.level,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
        winston.format.json()
    ),
    defaultMeta: {
        serverId: loggingConfig.serverId,
        hostname: os.hostname(),
        environment: process.env.NODE_ENV || 'development',
        application: loggingConfig.appName,
        version: loggingConfig.appVersion
    },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ level, message, timestamp, metadata }) => {
                    return `${timestamp} ${level}: ${message} ${JSON.stringify(metadata)}`;
                })
            )
        }),
        new winston.transports.File({ filename: loggingConfig.logFilePath }),
        new winston.transports.MongoDB({
            db: loggingConfig.mongoDbUrl,
            collection: 'logs',
            options: {
                useUnifiedTopology: true
            }
        })
    ],
    exceptionHandlers: [
        new winston.transports.File({ filename: loggingConfig.exceptionsFilePath }),
        new winston.transports.MongoDB({
            db: loggingConfig.mongoDbUrl,
            collection: 'exceptions',
            options: {
                useUnifiedTopology: true
            }
        })
    ]
});

module.exports = logger;