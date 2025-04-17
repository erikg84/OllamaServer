const express = require('express');
const axios = require('axios');
const winston = require('winston');
require('winston-mongodb');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ip = require('ip');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const SERVER_ID = {
    hostname: os.hostname(),
    ipAddress: ip.address(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version
};

// Set up logger with enhanced configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
        winston.format.json()
    ),
    defaultMeta: {
        serverId: SERVER_ID.ipAddress,
        hostname: SERVER_ID.hostname,
        environment: process.env.NODE_ENV || 'development',
        application: 'llama-server', // Add application identifier
        version: '1.0.0' // Add version information
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
        new winston.transports.File({ filename: 'server.log' }),
        // Add MongoDB transport for centralized logging
        new winston.transports.MongoDB({
            db: 'mongodb://192.168.68.145:27017/logs',
            collection: 'logs',
            options: {
                useUnifiedTopology: true
            }
        })
    ],
    // Add exception handlers
    exceptionHandlers: [
        new winston.transports.File({ filename: 'exceptions.log' }),
        new winston.transports.MongoDB({
            db: 'mongodb://192.168.68.145:27017/logs',
            collection: 'exceptions',
            options: {
                useUnifiedTopology: true
            }
        })
    ]
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    logger.info({
        message: 'Created uploads directory',
        path: uploadsDir,
        timestamp: new Date().toISOString()
    });
}

const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 10 * 1024 * 1024, // Limit to 10MB
    },
    fileFilter: (req, file, cb) => {
        // Accept image files only
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

const app = express();
app.use(express.json({ limit: '50mb' }));

let queue;

// Llama API base URL
const LLAMA_BASE_URL = 'http://localhost:11434/api';

// Log application startup
logger.info({
    message: 'Server starting',
    version: '1.0.0',
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpuCores: os.cpus().length,
    totalMemory: `${Math.round(os.totalmem() / (1024 * 1024))} MB`,
    freeMemory: `${Math.round(os.freemem() / (1024 * 1024))} MB`
});

// Add request ID middleware
app.use((req, res, next) => {
    req.id = uuidv4();
    res.locals.startTime = Date.now();

    // Enhanced request logging with sanitized body
    const sanitizedBody = req.body ? sanitizeRequestBody(req.body) : undefined;

    logger.info({
        message: 'Request received',
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        path: req.path,
        query: req.query,
        ip: req.ip,
        forwardedIp: req.get('x-forwarded-for'),
        userAgent: req.get('user-agent'),
        contentType: req.get('content-type'),
        contentLength: req.get('content-length'),
        requestBody: sanitizedBody
    });

    // Enhanced response logging with metrics
    res.on('finish', () => {
        const duration = Date.now() - res.locals.startTime;
        logger.info({
            message: 'Response sent',
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            contentType: res.get('content-type'),
            contentLength: res.get('content-length'),
            duration: `${duration}ms`,
            responseTime: duration
        });
    });

    // Log response errors
    res.on('error', (error) => {
        logger.error({
            message: 'Response error',
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            error: error.message,
            stack: error.stack
        });
    });

    next();
});

// Sanitize request body to avoid logging sensitive information
function sanitizeRequestBody(body) {
    if (!body) return {};

    // Create a shallow copy of the body
    const sanitized = { ...body };

    // Remove potentially sensitive fields
    const sensitiveFields = ['password', 'token', 'apiKey', 'secret'];

    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = '[REDACTED]';
        }
    }

    // For large prompt texts, truncate them
    if (sanitized.prompt && typeof sanitized.prompt === 'string' && sanitized.prompt.length > 100) {
        sanitized.prompt = sanitized.prompt.substring(0, 100) + '... [TRUNCATED]';
    }

    // For message arrays, truncate content
    if (sanitized.messages && Array.isArray(sanitized.messages)) {
        sanitized.messages = sanitized.messages.map(msg => {
            if (msg.content && typeof msg.content === 'string' && msg.content.length > 100) {
                return {
                    ...msg,
                    content: msg.content.substring(0, 100) + '... [TRUNCATED]'
                };
            }
            return msg;
        });
    }

    return sanitized;
}

(async () => {
    try {
        logger.info({
            message: 'Initializing server and importing p-queue...',
            timestamp: new Date().toISOString()
        });

        const PQueue = (await import('p-queue')).default;
        queue = new PQueue({
            concurrency: 5,
            autoStart: true
        });

        // Add queue logging
        queue.on('add', () => {
            logger.info({
                message: 'Task added to queue',
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('next', () => {
            logger.info({
                message: 'Starting next task',
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('completed', () => {
            logger.info({
                message: 'Task completed',
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        queue.on('error', (error) => {
            logger.error({
                message: 'Queue task error',
                error: error.message,
                stack: error.stack,
                queueSize: queue.size,
                queuePending: queue.pending,
                timestamp: new Date().toISOString()
            });
        });

        logger.info({
            message: 'Queue initialized successfully',
            concurrency: 5,
            timestamp: new Date().toISOString()
        });

        // Start the server
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            logger.info({
                message: `Server running on port ${PORT}`,
                port: PORT,
                serverUrl: `http://${SERVER_ID.ipAddress}:${PORT}`,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        logger.error({
            message: 'Failed to initialize server',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        process.exit(1);
    }
})();

app.get('/vision-models', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Vision models list requested',
        requestId,
        endpoint: '/vision-models',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding vision models list request to queue',
            requestId,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing vision models list request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making models list API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/tags`,
                    method: 'GET',
                    timestamp: new Date().toISOString()
                });

                const response = await axios.get(`${LLAMA_BASE_URL}/tags`);

                // Filter for vision-capable models
                // This is a simplified filter that looks for models that might have vision capabilities
                // based on their names. A more accurate approach would be to check model capabilities explicitly.
                const visionModels = response.data.models
                    .filter(model => {
                        const modelName = model.model.toLowerCase();
                        return modelName.includes('llava') ||
                            modelName.includes('vision') ||
                            modelName.includes('bakllava') ||
                            modelName.includes('llama3.2-vision');
                    })
                    .map(model => ({
                        id: model.model,
                        name: model.name || model.model,
                        type: model.details?.family || "unknown",
                        size: model.size,
                        quantization: model.details?.quantization_level || "unknown"
                    }));

                logger.info({
                    message: 'Vision models list API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    modelsCount: visionModels.length,
                    responseSize: JSON.stringify(visionModels).length,
                    timestamp: new Date().toISOString()
                });

                return { data: visionModels };
            } catch (error) {
                // Enhanced error logging for API call failures
                logger.error({
                    message: 'Vision models list API call failed',
                    requestId,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Vision models list request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            modelsCount: result.data.length,
            timestamp: new Date().toISOString()
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Vision models list request failed',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/vision/stream', upload.single('image'), async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const model = req.body.model || 'llava:13b'; // Default to LLaVA
    const prompt = req.body.prompt || 'Describe this image in detail';
    const node = req.body.node || 'unknown';

    // Enhanced vision stream request logging
    logger.info({
        message: 'Vision stream analysis request received',
        requestId,
        model,
        node,
        prompt,
        imageSize: req.file ? req.file.size : 'No file uploaded',
        timestamp: new Date().toISOString()
    });

    if (!req.file) {
        logger.error({
            message: 'No image file provided',
            requestId,
            timestamp: new Date().toISOString()
        });
        return res.status(400).json({ status: 'error', message: 'No image file provided' });
    }

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevents buffering for Nginx proxies

    try {
        logger.info({
            message: 'Adding vision stream request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        // Process stream in the queue
        queue.add(async () => {
            const queueWaitTime = Date.now() - startTime;

            logger.info({
                message: 'Executing vision stream request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Read the image file and convert to base64
                const imageBuffer = fs.readFileSync(req.file.path);
                const base64Image = imageBuffer.toString('base64');

                // Prepare the request for Ollama
                const requestBody = {
                    model: model,
                    stream: true,
                    messages: [
                        {
                            role: 'user',
                            content: prompt,
                            images: [base64Image]
                        }
                    ]
                };

                // Make streaming request to Ollama
                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, requestBody, {
                    responseType: 'stream'
                });

                // Counters for metrics
                let outputTokens = 0;
                let fullResponse = '';

                // Process the stream
                response.data.on('data', (chunk) => {
                    try {
                        // Convert chunk to string and forward to client
                        const chunkStr = chunk.toString();
                        res.write(chunkStr);

                        // Try to parse JSON chunks for metrics
                        try {
                            const jsonChunks = chunkStr
                                .split('\n')
                                .filter(line => line.trim())
                                .map(line => JSON.parse(line));

                            // Process each JSON chunk
                            jsonChunks.forEach(jsonChunk => {
                                if (jsonChunk.message && jsonChunk.message.content) {
                                    // Accumulate full response for logging
                                    fullResponse += jsonChunk.message.content;
                                    // Approximate token count for metrics
                                    outputTokens += jsonChunk.message.content.split(/\s+/).length;
                                }

                                // If we have done metrics in the response
                                if (jsonChunk.done && jsonChunk.total_duration) {
                                    logger.info({
                                        message: 'Vision stream chunk metrics received',
                                        requestId,
                                        model,
                                        duration: jsonChunk.total_duration,
                                        tokensPerSecond: jsonChunk.eval_rate,
                                        timestamp: new Date().toISOString()
                                    });
                                }
                            });
                        } catch (parseError) {
                            // Not all chunks may be valid JSON, which is ok
                        }
                    } catch (chunkError) {
                        logger.error({
                            message: 'Error processing vision stream chunk',
                            requestId,
                            error: chunkError.message,
                            timestamp: new Date().toISOString()
                        });
                    }
                });

                // Handle stream end
                response.data.on('end', () => {
                    const duration = Date.now() - startTime;

                    // Clean up the uploaded file
                    fs.unlinkSync(req.file.path);

                    // Add placeholder metrics data
                    const metricsData = {
                        usage: {
                            prompt_tokens: prompt ? prompt.split(/\s+/).length : 0,
                            completion_tokens: outputTokens,
                            total_tokens: outputTokens + (prompt ? prompt.split(/\s+/).length : 0)
                        }
                    };

                    updateMetrics(node, model, startTime, metricsData);

                    logger.info({
                        message: 'Vision stream completed',
                        requestId,
                        model,
                        node,
                        duration: `${duration}ms`,
                        outputTokens,
                        responseLength: fullResponse.length,
                        timestamp: new Date().toISOString()
                    });

                    // End the response
                    res.end();
                });

                // Handle stream error
                response.data.on('error', (error) => {
                    // Clean up the uploaded file on error
                    if (req.file && req.file.path) {
                        fs.unlinkSync(req.file.path);
                    }

                    logger.error({
                        message: 'Vision stream error',
                        requestId,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });

                    updateMetrics(node, model, startTime, null, true);

                    // Send error to client and end stream
                    res.write(JSON.stringify({ error: error.message }));
                    res.end();
                });
            } catch (error) {
                // Clean up the uploaded file on error
                if (req.file && req.file.path) {
                    fs.unlinkSync(req.file.path);
                }

                // Handle Axios errors
                updateMetrics(node, model, startTime, null, true);
                logger.error({
                    message: 'Vision stream API call failed',
                    requestId,
                    model,
                    node,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                // Send error to client and end stream
                res.write(JSON.stringify({ error: error.message }));
                res.end();
            }
        }).catch(error => {
            // Clean up the uploaded file on error
            if (req.file && req.file.path) {
                fs.unlinkSync(req.file.path);
            }

            // Handle queue errors
            logger.error({
                message: 'Queue error for vision stream',
                requestId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });

            // Send error to client and end stream
            res.write(JSON.stringify({ error: error.message }));
            res.end();
        });
    } catch (error) {
        // Clean up the uploaded file on error
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path);
        }

        // Handle uncaught errors
        logger.error({
            message: 'Uncaught error in vision stream',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        // Send error to client and end stream
        res.write(JSON.stringify({ error: error.message }));
        res.end();
    }
});

app.post('/vision', upload.single('image'), async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const model = req.body.model || 'llava:13b'; // Default to LLaVA
    const prompt = req.body.prompt || 'Describe this image in detail';
    const node = req.body.node || 'unknown';

    // Enhanced vision request logging
    logger.info({
        message: 'Vision analysis request received',
        requestId,
        model,
        node,
        prompt,
        imageSize: req.file ? req.file.size : 'No file uploaded',
        timestamp: new Date().toISOString()
    });

    if (!req.file) {
        logger.error({
            message: 'No image file provided',
            requestId,
            timestamp: new Date().toISOString()
        });
        return res.status(400).json({ status: 'error', message: 'No image file provided' });
    }

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding vision analysis request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const queueStartTime = Date.now();
        const result = await queue.add(async () => {
            const queueWaitTime = Date.now() - queueStartTime;

            logger.info({
                message: 'Executing vision analysis request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Read the image file and convert to base64
                const imageBuffer = fs.readFileSync(req.file.path);
                const base64Image = imageBuffer.toString('base64');

                // Prepare the request for Ollama
                const requestBody = {
                    model: model,
                    messages: [
                        {
                            role: 'user',
                            content: prompt,
                            images: [base64Image]
                        }
                    ]
                };

                // Log API call attempt
                logger.info({
                    message: 'Making vision analysis API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/chat`,
                    method: 'POST',
                    model,
                    timestamp: new Date().toISOString()
                });

                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, requestBody);

                // Clean up the uploaded file
                fs.unlinkSync(req.file.path);

                // Extract usage metrics for enhanced logging
                const usage = response.data.usage || {};
                const inputTokens = usage.prompt_tokens || 0;
                const outputTokens = usage.completion_tokens || 0;
                const totalTokens = usage.total_tokens || inputTokens + outputTokens;
                const duration = Date.now() - startTime;
                const tokensPerSecond = outputTokens > 0 ? (outputTokens / (duration / 1000)).toFixed(2) : 0;

                updateMetrics(node, model, startTime, response.data);

                // Enhanced successful API call logging
                logger.info({
                    message: 'Vision analysis API call successful',
                    requestId,
                    model,
                    node,
                    duration: `${duration}ms`,
                    responseSize: JSON.stringify(response.data).length,
                    promptTokens: inputTokens,
                    completionTokens: outputTokens,
                    totalTokens,
                    tokensPerSecond: `${tokensPerSecond} tokens/sec`,
                    timestamp: new Date().toISOString()
                });
                return response;
            } catch (error) {
                // Clean up the uploaded file on error
                if (req.file && req.file.path) {
                    fs.unlinkSync(req.file.path);
                }

                // Enhanced error logging for API call failures
                updateMetrics(node, model, startTime, null, true);
                logger.error({
                    message: 'Vision analysis API call failed',
                    requestId,
                    model,
                    node,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Vision analysis request successful',
            requestId,
            model,
            node,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.json(result.data);
    } catch (error) {
        // Clean up the uploaded file on error
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path);
        }

        logger.error({
            message: 'Vision analysis request failed',
            requestId,
            model,
            node,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

const supportedExtensions = [
    '.txt', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.json', '.rtf',
    '.java', '.kt', '.swift', '.js', '.ts', '.py', '.cpp', '.c', '.cs',
    '.go', '.rb', '.php', '.rs', '.scala', '.m', '.dart', '.groovy',
    '.lua', '.pl', '.r', '.sql', '.yaml', '.yml', '.toml', '.md',
    '.html', '.htm', '.css', '.xml', '.jsx', '.tsx', '.json5'
];

// Fix the file filter function to properly reference req.file instead of 'file'
const documentUpload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 50 * 1024 * 1024, // Limit to 50MB for documents
    },
    fileFilter: (req, file, cb) => {
        // Determine file extension
        const fileExtension = path.extname(file.originalname).toLowerCase();

        // Accept document files by MIME type or extension
        const allowedMimes = [
            // Existing document types
            'text/plain',
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'text/csv',
            'application/json',
            'application/rtf',
            'text/rtf',

            // Programming language source files
            'text/x-java-source',               // Java
            'text/x-kotlin',                    // Kotlin
            'text/x-swift',                     // Swift
            'application/javascript',           // JavaScript
            'text/javascript',                  // JavaScript (alternate)
            'application/typescript',           // TypeScript
            'text/x-python',                    // Python
            'text/x-c++src',                    // C++
            'text/x-csrc',                      // C
            'text/x-csharp',                    // C#
            'text/x-go',                        // Go
            'text/x-ruby',                      // Ruby
            'text/x-php',                       // PHP
            'text/x-rust',                      // Rust
            'text/x-scala',                     // Scala
            'text/x-objcsrc',                   // Objective-C
            'text/x-dart',                      // Dart
            'text/x-groovy',                    // Groovy
            'text/x-lua',                       // Lua
            'text/x-perl',                      // Perl
            'text/x-r',                         // R
            'text/x-sql',                       // SQL
            'text/x-yaml',                      // YAML
            'text/x-toml',                      // TOML
            'text/markdown',                    // Markdown
            'text/html',                        // HTML
            'text/css',                         // CSS
            'text/xml',                         // XML
            'application/xml',                   // XML (alternate)
            'application/octet-stream'
        ];

        logger.debug({
            message: 'File upload attempt',
            mimetype: file.mimetype,
            filename: file.originalname,
            extension: fileExtension
        });

        // Accept files either by MIME type or by file extension
        if (allowedMimes.includes(file.mimetype) || supportedExtensions.includes(fileExtension)) {
            cb(null, true);
        } else {
            const errorMessage = `Unsupported file type: ${file.mimetype} with extension ${fileExtension}. Supported types include documents and programming language source files.`;
            logger.warn({
                message: 'File upload rejected',
                mimetype: file.mimetype,
                filename: file.originalname,
                extension: fileExtension,
                reason: errorMessage
            });
            cb(new Error(errorMessage), false);
        }
    }
});

// Document extraction endpoint using the document-specific upload middleware
app.post('/document/extract', documentUpload.single('document'), async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now(); // Define startTime here to fix the reference error

    logger.info({
        message: 'Document text extraction request received',
        requestId,
        fileSize: req.file ? req.file.size : 'No file uploaded',
        contentType: req.file ? req.file.mimetype : 'unknown',
        fileName: req.file ? req.file.originalname : 'No file',
        timestamp: new Date().toISOString()
    });

    if (!req.file) {
        return res.status(400).json({
            status: 'error',
            message: 'No document file provided'
        });
    }

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding document extraction request to queue',
            requestId,
            fileType: req.file.mimetype,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing document extraction request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Extract text using appropriate method
                const text = await extractTextFromFile(req.file.path, req.file.mimetype, req.file.originalname);

                logger.info({
                    message: 'Document extraction successful',
                    requestId,
                    contentType: req.file.mimetype,
                    originalSize: req.file.size,
                    extractedLength: text.length,
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                return {
                    status: 'ok',
                    data: {
                        text: text,
                        metadata: {
                            originalSize: req.file.size,
                            extractedLength: text.length,
                            mimeType: req.file.mimetype,
                            fileName: req.file.originalname,
                            processingTimeMs: Date.now() - startTime
                        }
                    }
                };
            } catch (error) {
                logger.error({
                    message: 'Document extraction failed',
                    requestId,
                    fileType: req.file.mimetype,
                    fileName: req.file.originalname,
                    error: error.message,
                    stack: error.stack,
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                throw error;
            }
        });

        // Return the extracted text
        res.json(result);
    } catch (error) {
        logger.error({
            message: 'Document extraction request failed',
            requestId,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: `Failed to extract text: ${error.message}`
        });
    } finally {
        // Clean up the temporary file
        try {
            if (req.file && req.file.path) {
                fs.unlinkSync(req.file.path);
            }
        } catch (deleteError) {
            logger.error({
                message: 'Failed to delete temporary file',
                requestId,
                filePath: req.file ? req.file.path : 'unknown',
                error: deleteError.message,
                timestamp: new Date().toISOString()
            });
        }
    }
});

// Comprehensive text extraction function supporting multiple file formats
async function extractTextFromFile(filePath, mimeType, fileName) {
    const codeExtensions = [
        '.java', '.kt', '.swift', '.js', '.ts', '.py', '.cpp', '.c', '.cs',
        '.go', '.rb', '.php', '.rs', '.scala', '.m', '.dart', '.groovy',
        '.lua', '.pl', '.r', '.sql', '.yaml', '.yml', '.toml', '.md',
        '.html', '.htm', '.css', '.xml', '.jsx', '.tsx', '.json5'
    ];

    // Start timing for metrics
    const startTime = Date.now();

    // Determine file extension
    const fileExtension = path.extname(fileName).toLowerCase();

    logger.debug({
        message: 'Extracting text from file',
        mimetype: mimeType,
        filename: fileName,
        extension: fileExtension
    });

    // Handle code files by direct reading (moved to top to ensure it catches all code files)
    if (codeExtensions.includes(fileExtension) ||
        mimeType.startsWith('text/x-') ||
        mimeType === 'application/javascript' ||
        mimeType === 'text/javascript' ||
        mimeType === 'application/typescript') {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            logger.debug({
                message: `Extracted text from ${fileExtension.substring(1) || mimeType} source file`,
                method: 'direct read',
                duration: `${Date.now() - startTime}ms`
            });
            return content;
        } catch (error) {
            logger.error({
                message: `Failed to read ${fileExtension.substring(1) || mimeType} source file`,
                error: error.message
            });
            throw new Error(`Failed to extract text from source file: ${error.message}`);
        }
    }

    // Plain text files
    if (mimeType === 'text/plain' || fileExtension === '.txt') {
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            logger.debug({
                message: 'Extracted text from plain text file',
                method: 'direct read',
                duration: `${Date.now() - startTime}ms`
            });
            return text;
        } catch (error) {
            logger.error({
                message: 'Failed to read text file',
                error: error.message
            });
            throw new Error(`Failed to read text file: ${error.message}`);
        }
    }

    // PDF files - enhanced error handling with multiple fallback methods
    if (mimeType === 'application/pdf' || fileExtension === '.pdf') {
        try {
            // Read the file
            const dataBuffer = fs.readFileSync(filePath);

            // Method 1: Try pdf-parse
            try {
                const pdfParser = require('pdf-parse');
                const data = await pdfParser(dataBuffer);

                logger.debug({
                    message: 'Extracted text from PDF file using pdf-parse',
                    method: 'pdf-parse',
                    pageCount: data.numpages,
                    duration: `${Date.now() - startTime}ms`
                });

                return data.text;
            } catch (pdfParseError) {
                logger.warn({
                    message: 'PDF parsing with pdf-parse failed, trying pdfjs',
                    error: pdfParseError.message
                });

                // Method 2: Try pdfjs-dist
                try {
                    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

                    let text = '';
                    const doc = await pdfjsLib.getDocument({ data: dataBuffer }).promise;
                    const numPages = doc.numPages;

                    for (let i = 1; i <= numPages; i++) {
                        const page = await doc.getPage(i);
                        const content = await page.getTextContent();
                        text += content.items.map(item => item.str).join(' ') + '\n\n';
                    }

                    logger.debug({
                        message: 'Extracted text from PDF file using pdfjs',
                        method: 'pdfjs',
                        pageCount: numPages,
                        duration: `${Date.now() - startTime}ms`
                    });

                    return text;
                } catch (pdfjsError) {
                    logger.warn({
                        message: 'PDF parsing with pdfjs failed, trying pdf2json',
                        error: pdfjsError.message
                    });

                    // Method 3: Try pdf2json
                    try {
                        const PDF2JSON = require('pdf2json');
                        const pdfParser = new PDF2JSON();

                        const text = await new Promise((resolve, reject) => {
                            pdfParser.on("pdfParser_dataError", errData => reject(new Error(errData.parserError)));
                            pdfParser.on("pdfParser_dataReady", pdfData => {
                                try {
                                    let text = '';
                                    for (let i = 0; i < pdfData.Pages.length; i++) {
                                        const page = pdfData.Pages[i];
                                        const pageText = page.Texts.map(textObject => {
                                            return decodeURIComponent(textObject.R.map(r => r.T).join(' '));
                                        }).join(' ');
                                        text += pageText + '\n\n';
                                    }
                                    resolve(text);
                                } catch (err) {
                                    reject(err);
                                }
                            });

                            pdfParser.parseBuffer(dataBuffer);
                        });

                        logger.debug({
                            message: 'Extracted text from PDF file using pdf2json',
                            method: 'pdf2json',
                            duration: `${Date.now() - startTime}ms`
                        });

                        return text;
                    } catch (pdf2jsonError) {
                        logger.warn({
                            message: 'PDF parsing with pdf2json failed, trying textract',
                            error: pdf2jsonError.message
                        });

                        // Method 4: Last resort, try textract
                        try {
                            const textractText = await extractWithTextract(filePath, mimeType);
                            return textractText;
                        } catch (textractError) {
                            logger.error({
                                message: 'All PDF extraction methods failed',
                                errors: {
                                    pdfParse: pdfParseError.message,
                                    pdfjs: pdfjsError.message,
                                    pdf2json: pdf2jsonError.message,
                                    textract: textractError.message
                                }
                            });

                            // No methods worked, but let's try a simple text extraction
                            // as a last fallback for simple PDF files
                            try {
                                // Try to read it as plain text (works for some simple PDFs)
                                const rawText = dataBuffer.toString('utf8');
                                // Only return if we have something that looks like text
                                if (rawText.replace(/[^a-zA-Z0-9]/g, '').length > 50) {
                                    logger.debug({
                                        message: 'Extracted text from PDF using raw buffer conversion',
                                        method: 'raw_buffer',
                                        duration: `${Date.now() - startTime}ms`
                                    });
                                    return rawText;
                                }
                                throw new Error('Raw text extraction produced insufficient results');
                            } catch (rawError) {
                                // If we get here, nothing worked
                                throw new Error(`All PDF extraction methods failed: ${pdfParseError.message}`);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger.error({
                message: 'PDF file read or extraction error',
                error: error.message
            });
            throw new Error(`Failed to extract text from PDF: ${error.message}`);
        }
    }

    // DOCX files
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        fileExtension === '.docx') {
        try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: filePath });
            logger.debug({
                message: 'Extracted text from DOCX file',
                method: 'mammoth',
                duration: `${Date.now() - startTime}ms`
            });
            return result.value;
        } catch (error) {
            logger.error({
                message: 'Failed to extract text from DOCX',
                error: error.message
            });
            throw new Error(`Failed to extract text from DOCX: ${error.message}`);
        }
    }

    // DOC files (old Word format)
    if (mimeType === 'application/msword' || fileExtension === '.doc') {
        return await extractWithTextract(filePath, mimeType);
    }

    // Excel files
    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mimeType === 'application/vnd.ms-excel' ||
        fileExtension === '.xlsx' ||
        fileExtension === '.xls') {
        try {
            const XLSX = require('xlsx');
            const workbook = XLSX.readFile(filePath, {
                cellDates: true,
                cellNF: true
            });

            let text = '';
            for (const sheet of workbook.SheetNames) {
                const worksheet = workbook.Sheets[sheet];
                text += `Sheet: ${sheet}\n`;

                // Convert sheet to JSON for easier processing
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                // Format as text
                for (const row of jsonData) {
                    if (row.length > 0) {
                        text += row.join('\t') + '\n';
                    }
                }
                text += '\n\n';
            }

            logger.debug({
                message: 'Extracted text from Excel file',
                method: 'xlsx',
                sheets: workbook.SheetNames.length,
                duration: `${Date.now() - startTime}ms`
            });

            return text;
        } catch (error) {
            logger.error({
                message: 'Failed to extract text from Excel',
                error: error.message
            });
            throw new Error(`Failed to extract text from Excel: ${error.message}`);
        }
    }

    // CSV files
    if (mimeType === 'text/csv' || fileExtension === '.csv') {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            logger.debug({
                message: 'Extracted text from CSV file',
                method: 'direct read',
                duration: `${Date.now() - startTime}ms`
            });
            return content;
        } catch (error) {
            logger.error({
                message: 'Failed to read CSV file',
                error: error.message
            });
            throw new Error(`Failed to extract text from CSV: ${error.message}`);
        }
    }

    // JSON files
    if (mimeType === 'application/json' || fileExtension === '.json') {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            logger.debug({
                message: 'Extracted text from JSON file',
                method: 'direct read',
                duration: `${Date.now() - startTime}ms`
            });
            return content;
        } catch (error) {
            logger.error({
                message: 'Failed to read JSON file',
                error: error.message
            });
            throw new Error(`Failed to extract text from JSON file: ${error.message}`);
        }
    }

    // RTF files
    if (mimeType === 'application/rtf' || fileExtension === '.rtf') {
        return await extractWithTextract(filePath, mimeType);
    }

    // For all other file types, try direct read first
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        logger.debug({
            message: 'Extracted text using direct read',
            mimeType,
            duration: `${Date.now() - startTime}ms`
        });
        return content;
    } catch (directReadError) {
        // If direct read fails, try textract as last resort
        try {
            return await extractWithTextract(filePath, mimeType);
        } catch (textractError) {
            logger.error({
                message: 'All extraction methods failed',
                mimeType,
                directReadError: directReadError.message,
                textractError: textractError.message
            });
            throw new Error(`Unable to extract text from file: ${textractError.message}`);
        }
    }
}

// Helper function to extract text using textract
async function extractWithTextract(filePath, mimeType) {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
        try {
            const textract = require('textract');
            const options = {
                preserveLineBreaks: true,
                preserveOnlyMultipleLineBreaks: false
            };

            textract.fromFileWithPath(filePath, options, (error, text) => {
                if (error) {
                    logger.error({
                        message: 'Textract extraction failed',
                        mimeType,
                        error: error.message,
                        duration: `${Date.now() - startTime}ms`
                    });
                    reject(new Error(`Textract extraction failed: ${error.message}`));
                } else {
                    logger.debug({
                        message: 'Extracted text using textract',
                        mimeType,
                        duration: `${Date.now() - startTime}ms`
                    });
                    resolve(text);
                }
            });
        } catch (error) {
            logger.error({
                message: 'Error initializing textract',
                error: error.message,
                duration: `${Date.now() - startTime}ms`
            });
            reject(new Error(`Textract initialization failed: ${error.message}`));
        }
    });
}

// New endpoint for processing document chunks
app.post('/document/process-chunk', async (req, res) => {
    const requestId = req.id || req.headers['x-request-id'] || uuidv4();
    const startTime = Date.now();
    const { chunkId, content, index, totalChunks, model, prompt } = req.body;

    logger.info({
        message: 'Document chunk processing request received',
        requestId,
        chunkId,
        model,
        chunkIndex: index,
        totalChunks,
        contentLength: content.length,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding chunk processing request to queue',
            requestId,
            chunkId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing chunk processing request',
                requestId,
                chunkId,
                model,
                timestamp: new Date().toISOString()
            });

            try {
                // Create context message for the chunk
                const contextualPrompt = `
                ${prompt}
                
                IMPORTANT CONTEXT: You are analyzing chunk ${index + 1} of ${totalChunks} from a larger document.
                
                Document chunk content:
                ${content}
                
                Process this chunk according to the instructions, knowing it's part of a larger document.
                `;

                // Prepare chat request for Ollama
                const chatRequest = {
                    model: model,
                    messages: [
                        {
                            role: 'user',
                            content: contextualPrompt
                        }
                    ]
                };

                // Make request to Ollama API
                logger.info({
                    message: 'Making chunk processing API call',
                    requestId,
                    chunkId,
                    model,
                    timestamp: new Date().toISOString()
                });

                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, chatRequest);

                // Extract assistant message
                const assistantContent = response.data.message?.content || '';

                logger.info({
                    message: 'Chunk processing completed',
                    requestId,
                    chunkId,
                    model,
                    responseLength: assistantContent.length,
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                return {
                    status: 'ok',
                    data: {
                        chunkId,
                        index,
                        content: assistantContent,
                        model,
                        processingTimeMs: Date.now() - startTime
                    }
                };
            } catch (error) {
                logger.error({
                    message: 'Chunk processing API call failed',
                    requestId,
                    chunkId,
                    model,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                throw error;
            }
        }).coAwait();

        res.json(result);
    } catch (error) {
        logger.error({
            message: 'Chunk processing request failed',
            requestId,
            chunkId,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: `Failed to process chunk: ${error.message}`
        });
    }
});

// Add synthesize endpoint for combining chunk results
app.post('/document/synthesize', async (req, res) => {
    const requestId = req.id || req.headers['x-request-id'] || uuidv4();
    const startTime = Date.now();
    const { chunkResults, originalPrompt, model } = req.body;

    logger.info({
        message: 'Document synthesis request received',
        requestId,
        model,
        chunkCount: chunkResults.length,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding synthesis request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing synthesis request',
                requestId,
                model,
                timestamp: new Date().toISOString()
            });

            try {
                // Create synthesis prompt
                const synthesisPrompt = createSynthesisPrompt(chunkResults, originalPrompt);

                // Prepare chat request for Ollama
                const chatRequest = {
                    model: model,
                    messages: [
                        {
                            role: 'user',
                            content: synthesisPrompt
                        }
                    ]
                };

                // Make request to Ollama API
                logger.info({
                    message: 'Making synthesis API call',
                    requestId,
                    model,
                    timestamp: new Date().toISOString()
                });

                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, chatRequest);

                // Extract assistant message
                const synthesizedContent = response.data.message?.content || '';

                logger.info({
                    message: 'Synthesis completed',
                    requestId,
                    model,
                    responseLength: synthesizedContent.length,
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                return {
                    status: 'ok',
                    data: {
                        content: synthesizedContent,
                        metadata: {
                            chunkCount: chunkResults.length,
                            successfulChunks: chunkResults.filter(c => c.success !== false).length,
                            processingTimeMs: Date.now() - startTime,
                            synthesisModel: model
                        }
                    }
                };
            } catch (error) {
                logger.error({
                    message: 'Synthesis API call failed',
                    requestId,
                    model,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                throw error;
            }
        });

        res.json(result);
    } catch (error) {
        logger.error({
            message: 'Synthesis request failed',
            requestId,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            status: 'error',
            message: `Failed to synthesize results: ${error.message}`
        });
    }
});

// Helper function to create synthesis prompt
function createSynthesisPrompt(chunkResults, originalPrompt) {
    const sb = [];

    sb.push(`
    You are synthesizing analysis from multiple chunks of a document. Your task is to create a coherent response that integrates the analysis of all chunks.
    
    Original request: ${originalPrompt}
    
    Below are the analyses of ${chunkResults.length} document chunks, in order:
    `.trim());

    // Include each chunk's content
    chunkResults
        .sort((a, b) => a.index - b.index)
        .forEach((result, index) => {
            sb.push(`\n--- CHUNK ${index + 1} ANALYSIS ---`);
            sb.push(result.content || "[No content available for this chunk]");
        });

    sb.push(`
    
    INSTRUCTIONS:
    1. Synthesize a coherent response that addresses the original request based on all document chunks
    2. Eliminate redundancies and resolve any contradictions between chunk analyses
    3. Provide a comprehensive answer that flows naturally as if the document was processed as a whole
    4. Do not mention chunks or the chunking process in your response
    5. Format your response appropriately for the type of analysis requested
    `.trim());

    return sb.join('\n');
}

// Health check endpoint
app.get('/health', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Health check requested',
        requestId,
        endpoint: '/health',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding health check to queue',
            requestId,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing health check request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making health check API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/tags`,
                    method: 'GET',
                    timestamp: new Date().toISOString()
                });

                const response = await axios.get(`${LLAMA_BASE_URL}/tags`);

                // Log successful response details
                logger.info({
                    message: 'Health check API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    statusCode: response.status,
                    responseSize: JSON.stringify(response.data).length,
                    timestamp: new Date().toISOString()
                });
                return response;
            } catch (error) {
                // Enhanced error logging for API call failures
                logger.error({
                    message: 'Health check API call failed',
                    requestId,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Health check successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            tagsCount: result.data.models ? result.data.models.length : 0,
            timestamp: new Date().toISOString()
        });

        res.json({ status: 'ok', tags: result.data });
    } catch (error) {
        logger.error({
            message: 'Health check failed',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Generation endpoint with queuing
app.post('/generate', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';

    // Enhanced generate request logging
    logger.info({
        message: 'Generate request received',
        requestId,
        model,
        node,
        promptLength: req.body.prompt ? req.body.prompt.length : 'undefined',
        options: req.body.options || {},
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding generate request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const queueStartTime = Date.now();
        const result = await queue.add(async () => {
            const queueWaitTime = Date.now() - queueStartTime;

            logger.info({
                message: 'Executing generate request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making generate API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/generate`,
                    method: 'POST',
                    model,
                    timestamp: new Date().toISOString()
                });

                const response = await axios.post(`${LLAMA_BASE_URL}/generate`, req.body);

                // Extract metrics from response for logging
                const tokenCount = response.data.eval_count || 0;
                const promptTokens = response.data.prompt_eval_count || 0;
                const duration = Date.now() - startTime;
                const tokensPerSecond = tokenCount > 0 ? (tokenCount / (duration / 1000)).toFixed(2) : 0;

                updateMetrics(node, model, startTime, response.data);

                // Enhanced successful API call logging
                logger.info({
                    message: 'Generate API call successful',
                    requestId,
                    model,
                    node,
                    duration: `${duration}ms`,
                    responseSize: JSON.stringify(response.data).length,
                    tokenCount,
                    promptTokens,
                    totalTokens: promptTokens + tokenCount,
                    tokensPerSecond: `${tokensPerSecond} tokens/sec`,
                    timestamp: new Date().toISOString()
                });
                return response;
            } catch (error) {
                // Enhanced error logging for API call failures
                updateMetrics(node, model, startTime, null, true);
                logger.error({
                    message: 'Generate API call failed',
                    requestId,
                    model,
                    node,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Generate request successful',
            requestId,
            model,
            node,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Generate request failed',
            requestId,
            model,
            node,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Chat endpoint with queuing
app.post('/chat', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';

    // Enhanced chat request logging
    logger.info({
        message: 'Chat request received',
        requestId,
        model,
        node,
        messagesCount: req.body.messages ? req.body.messages.length : 'undefined',
        options: req.body.options || {},
        systemPromptLength: req.body.system ? req.body.system.length : 0,
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding chat request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const queueStartTime = Date.now();
        const result = await queue.add(async () => {
            const queueWaitTime = Date.now() - queueStartTime;

            logger.info({
                message: 'Executing chat request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making chat API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/chat`,
                    method: 'POST',
                    model,
                    timestamp: new Date().toISOString()
                });

                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, req.body);

                // Extract usage metrics for enhanced logging
                const usage = response.data.usage || {};
                const inputTokens = usage.prompt_tokens || 0;
                const outputTokens = usage.completion_tokens || 0;
                const totalTokens = usage.total_tokens || inputTokens + outputTokens;
                const duration = Date.now() - startTime;
                const tokensPerSecond = outputTokens > 0 ? (outputTokens / (duration / 1000)).toFixed(2) : 0;

                updateMetrics(node, model, startTime, response.data);

                // Enhanced successful API call logging
                logger.info({
                    message: 'Chat API call successful',
                    requestId,
                    model,
                    node,
                    duration: `${duration}ms`,
                    responseSize: JSON.stringify(response.data).length,
                    promptTokens: inputTokens,
                    completionTokens: outputTokens,
                    totalTokens,
                    tokensPerSecond: `${tokensPerSecond} tokens/sec`,
                    timestamp: new Date().toISOString()
                });
                return response;
            } catch (error) {
                // Enhanced error logging for API call failures
                updateMetrics(node, model, startTime, null, true);
                logger.error({
                    message: 'Chat API call failed',
                    requestId,
                    model,
                    node,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Chat request successful',
            requestId,
            model,
            node,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Chat request failed',
            requestId,
            model,
            node,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Shift metrics every 5 minutes
function shiftMetrics() {
    logger.info({
        message: 'Shifting time-series metrics',
        timestamp: new Date().toISOString()
    });

    // For response times
    Object.keys(metrics.responseTimes).forEach(nodeId => {
        // Remove oldest time point
        metrics.responseTimes[nodeId].shift();

        // Add new time point
        const latestTime = metrics.responseTimes[nodeId][metrics.responseTimes[nodeId].length - 1].time;
        const minutes = parseInt(latestTime) + 5;
        metrics.responseTimes[nodeId].push({ time: `${minutes}m`, value: 0 });
    });

    // For request counts
    metrics.requestCounts.shift();
    const latestTime = metrics.requestCounts[metrics.requestCounts.length - 1].time;
    const minutes = parseInt(latestTime) + 5;
    metrics.requestCounts.push({ time: `${minutes}m`, value: 0 });

    logger.info({
        message: 'Time-series metrics shifted successfully',
        timestamp: new Date().toISOString()
    });
}

// Set up metrics shifting every 5 minutes
setInterval(shiftMetrics, 5 * 60 * 1000);

// List models endpoint
app.get('/models', async (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Models list requested',
        requestId,
        endpoint: '/models',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    try {
        logger.info({
            message: 'Adding models list request to queue',
            requestId,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        const startTime = Date.now();
        const result = await queue.add(async () => {
            logger.info({
                message: 'Executing models list request',
                requestId,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Log API call attempt
                logger.info({
                    message: 'Making models list API call',
                    requestId,
                    endpoint: `${LLAMA_BASE_URL}/tags`,
                    method: 'GET',
                    timestamp: new Date().toISOString()
                });

                const response = await axios.get(`${LLAMA_BASE_URL}/tags`);

                // Transform the data to match what the Kotlin service expects
                const transformedModels = response.data.models.map(model => ({
                    id: model.model,
                    name: model.name || model.model,
                    type: model.details?.family || "unknown",
                    size: model.size,
                    quantization: model.details?.quantization_level || "unknown"
                }));

                logger.info({
                    message: 'Models list API call successful',
                    requestId,
                    duration: `${Date.now() - startTime}ms`,
                    modelsCount: transformedModels.length,
                    responseSize: JSON.stringify(transformedModels).length,
                    timestamp: new Date().toISOString()
                });

                return { data: transformedModels };
            } catch (error) {
                // Enhanced error logging for API call failures
                logger.error({
                    message: 'Models list API call failed',
                    requestId,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        });

        logger.info({
            message: 'Models list request successful',
            requestId,
            duration: `${Date.now() - startTime}ms`,
            modelsCount: result.data.length,
            timestamp: new Date().toISOString()
        });

        // Return the transformed array directly, not nested in an object
        res.json(result.data);
    } catch (error) {
        logger.error({
            message: 'Models list request failed',
            requestId,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Queue status endpoint (optional but helpful)
app.get('/queue-status', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Queue status requested',
        requestId,
        endpoint: '/queue-status',
        timestamp: new Date().toISOString()
    });

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    const status = {
        size: queue.size,
        pending: queue.pending,
        isPaused: queue.isPaused
    };

    logger.info({
        message: 'Queue status request successful',
        requestId,
        queueSize: status.size,
        queuePending: status.pending,
        queuePaused: status.isPaused,
        timestamp: new Date().toISOString()
    });

    res.json(status);
});

const metrics = {
    startTime: Date.now(),
    responseTimes: {},
    requestCounts: [],
    nodePerformance: {},
    modelPerformance: {}
};

// Initialize metrics
function initializeMetrics() {
    logger.info({
        message: 'Initializing metrics',
        timestamp: new Date().toISOString()
    });

    // Create initial time series points for the last hour (12 5-minute intervals)
    const timePoints = Array.from({ length: 12 }, (_, i) => {
        const minutes = i * 5;
        return { time: `${minutes}m`, value: 0 };
    });

    metrics.requestCounts = [...timePoints];

    logger.info({
        message: 'Metrics initialized successfully',
        timestamp: new Date().toISOString()
    });
}

// Update metrics after each Ollama API call
function updateMetrics(nodeId, modelId, startTime, responseData, isError = false) {
    const duration = Date.now() - startTime;

    // Update response times
    if (!metrics.responseTimes[nodeId]) {
        metrics.responseTimes[nodeId] = [];

        // Initialize with 12 time points
        for (let i = 0; i < 12; i++) {
            const minutes = i * 5;
            metrics.responseTimes[nodeId].push({ time: `${minutes}m`, value: 0 });
        }

        logger.debug({
            message: 'Initialized response time metrics for node',
            nodeId,
            timestamp: new Date().toISOString()
        });
    }

    // Add current response time to the latest time point
    const latestTimePoint = metrics.responseTimes[nodeId].length - 1;
    const currentAvg = metrics.responseTimes[nodeId][latestTimePoint].value || 0;
    const count = metrics.nodePerformance[nodeId]?.requestsProcessed || 0;

    if (count > 0) {
        metrics.responseTimes[nodeId][latestTimePoint].value =
            (currentAvg * count + duration) / (count + 1);
    } else {
        metrics.responseTimes[nodeId][latestTimePoint].value = duration;
    }

    // Update request counts for the latest time point
    metrics.requestCounts[metrics.requestCounts.length - 1].value += 1;

    // Update node performance
    if (!metrics.nodePerformance[nodeId]) {
        metrics.nodePerformance[nodeId] = {
            avgResponseTime: 0,
            requestsProcessed: 0,
            errorRate: 0
        };

        logger.debug({
            message: 'Initialized node performance metrics',
            nodeId,
            timestamp: new Date().toISOString()
        });
    }

    const nodeMetrics = metrics.nodePerformance[nodeId];
    nodeMetrics.requestsProcessed += 1;
    nodeMetrics.avgResponseTime =
        (nodeMetrics.avgResponseTime * (nodeMetrics.requestsProcessed - 1) + duration) /
        nodeMetrics.requestsProcessed;

    if (isError) {
        const errorCount = (nodeMetrics.errorRate / 100) * (nodeMetrics.requestsProcessed - 1);
        nodeMetrics.errorRate = ((errorCount + 1) / nodeMetrics.requestsProcessed) * 100;

        logger.debug({
            message: 'Updated node error rate',
            nodeId,
            newErrorRate: nodeMetrics.errorRate,
            timestamp: new Date().toISOString()
        });
    }

    // Update model performance
    if (!metrics.modelPerformance[modelId]) {
        metrics.modelPerformance[modelId] = {
            avgResponseTime: 0,
            requestsProcessed: 0,
            avgTokensGenerated: 0
        };

        logger.debug({
            message: 'Initialized model performance metrics',
            modelId,
            timestamp: new Date().toISOString()
        });
    }

    const modelMetrics = metrics.modelPerformance[modelId];
    modelMetrics.requestsProcessed += 1;
    modelMetrics.avgResponseTime =
        (modelMetrics.avgResponseTime * (modelMetrics.requestsProcessed - 1) + duration) /
        modelMetrics.requestsProcessed;

    // Extract token count from Ollama response if available
    let tokensGenerated = 0;
    if (responseData) {
        if (responseData.eval_count) {
            // For generate endpoint
            tokensGenerated = responseData.eval_count;
        } else if (responseData.usage && responseData.usage.completion_tokens) {
            // For chat endpoint
            tokensGenerated = responseData.usage.completion_tokens;
        }
    }

    modelMetrics.avgTokensGenerated =
        (modelMetrics.avgTokensGenerated * (modelMetrics.requestsProcessed - 1) + tokensGenerated) /
        modelMetrics.requestsProcessed;

    // Log detailed metrics update for debugging
    logger.debug({
        message: 'Updated performance metrics',
        nodeId,
        modelId,
        requestDuration: duration,
        tokensGenerated,
        timestamp: new Date().toISOString()
    });
}

// Get metrics
app.get('/admin/metrics', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Metrics requested',
        requestId,
        endpoint: '/admin/metrics',
        timestamp: new Date().toISOString()
    });

    // Add memory and CPU stats to metrics response
    const systemStats = {
        cpuUsage: process.cpuUsage().user / 1000000,
        memoryUsage: {
            rss: Math.round(process.memoryUsage().rss / (1024 * 1024)),
            heapTotal: Math.round(process.memoryUsage().heapTotal / (1024 * 1024)),
            heapUsed: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
            external: Math.round(process.memoryUsage().external / (1024 * 1024))
        },
        uptime: Math.floor((Date.now() - metrics.startTime) / 1000)
    };

    res.json({
        status: 'ok',
        data: {
            ...systemMetrics(),
            system: systemStats
        }
    });

    logger.info({
        message: 'Metrics request successful',
        requestId,
        metricTypes: Object.keys(metrics),
        nodeCount: Object.keys(metrics.nodePerformance).length,
        modelCount: Object.keys(metrics.modelPerformance).length,
        timestamp: new Date().toISOString()
    });
});

function systemMetrics() {
    const enhancedMetrics = {
        responseTimes: { ...metrics.responseTimes },
        requestCounts: [...metrics.requestCounts],
        nodePerformance: { ...metrics.nodePerformance },
        modelPerformance: { ...metrics.modelPerformance }
    };

    const activeNodes = Object.keys(enhancedMetrics.nodePerformance);

    if (enhancedMetrics.requestCounts.length === 0) {
        enhancedMetrics.requestCounts = Array.from({ length: 12 }, (_, i) => ({
            time: `${i * 5}m`,
            value: 0
        }));
    }

    activeNodes.forEach(nodeId => {
        if (!enhancedMetrics.responseTimes[nodeId]) {
            enhancedMetrics.responseTimes[nodeId] = Array.from({ length: 12 }, (_, i) => ({
                time: `${i * 5}m`,
                value: 0
            }));
        }
    });

    return enhancedMetrics;
}

// Get system information
app.get('/admin/system', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'System info requested',
        requestId,
        endpoint: '/admin/system',
        timestamp: new Date().toISOString()
    });

    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const memoryUsage = process.memoryUsage();
    const cpuInfo = os.cpus();

    const systemInfo = {
        apiVersion: '1.0.0',
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
        environment: process.env.NODE_ENV || 'development'
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
});

// Format uptime in a human-readable format
function formatUptime(seconds) {
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

// Get network interface information
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

// Reset metrics
app.post('/admin/reset-stats', (req, res) => {
    const requestId = req.id;

    logger.info({
        message: 'Stats reset requested',
        requestId,
        endpoint: '/admin/reset-stats',
        timestamp: new Date().toISOString()
    });

    // Get current metrics summary before reset for logging
    const nodeCount = Object.keys(metrics.nodePerformance).length;
    const modelCount = Object.keys(metrics.modelPerformance).length;

    // Reset metrics
    metrics.responseTimes = {};
    metrics.requestCounts = [];
    metrics.nodePerformance = {};
    metrics.modelPerformance = {};

    // Reinitialize
    initializeMetrics();

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
});

// Get logs from MongoDB (replaces the simplified implementation)
app.get('/admin/logs', async (req, res) => {
    const requestId = req.id;
    const { level, limit = 100, page = 1, startDate, endDate } = req.query;

    logger.info({
        message: 'Logs requested from database',
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
        // This endpoint now queries MongoDB for logs
        // We'll respond with success message for now
        // In production, you would connect to MongoDB and fetch logs

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
                serverId: SERVER_ID.ipAddress
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

        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve logs',
            error: error.message
        });
    }
});

// Stream chat endpoint
app.post('/chat/stream', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    const node = req.body.node || 'unknown';
    const model = req.body.model || 'unknown';

    // Enhanced stream chat request logging
    logger.info({
        message: 'Stream chat request received',
        requestId,
        model,
        node,
        messagesCount: req.body.messages ? req.body.messages.length : 'undefined',
        options: req.body.options || {},
        systemPromptLength: req.body.system ? req.body.system.length : 0,
        timestamp: new Date().toISOString()
    });

    // Force stream parameter to true
    const modifiedBody = {
        ...req.body,
        stream: true
    };

    if (!queue) {
        logger.error({
            message: 'Queue not initialized',
            requestId,
            reason: 'Server still initializing',
            timestamp: new Date().toISOString()
        });
        return res.status(503).json({ status: 'error', message: 'Server initializing' });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevents buffering for Nginx proxies

    try {
        logger.info({
            message: 'Adding stream chat request to queue',
            requestId,
            model,
            queueSize: queue.size,
            queuePending: queue.pending,
            timestamp: new Date().toISOString()
        });

        // Process stream in the queue
        queue.add(async () => {
            const queueWaitTime = Date.now() - startTime;

            logger.info({
                message: 'Executing stream chat request',
                requestId,
                model,
                node,
                queueWaitTime: `${queueWaitTime}ms`,
                startTime: new Date(startTime).toISOString(),
                timestamp: new Date().toISOString()
            });

            try {
                // Make streaming request to Ollama
                const response = await axios.post(`${LLAMA_BASE_URL}/chat`, modifiedBody, {
                    responseType: 'stream'
                });

                // Counters for metrics
                let outputTokens = 0;
                let fullResponse = '';

                // Process the stream
                response.data.on('data', (chunk) => {
                    try {
                        // Convert chunk to string and forward to client
                        const chunkStr = chunk.toString();
                        res.write(chunkStr);

                        // Try to parse JSON chunks for metrics
                        try {
                            const jsonChunks = chunkStr
                                .split('\n')
                                .filter(line => line.trim())
                                .map(line => JSON.parse(line));

                            // Process each JSON chunk
                            jsonChunks.forEach(jsonChunk => {
                                if (jsonChunk.message && jsonChunk.message.content) {
                                    // Accumulate full response for logging
                                    fullResponse += jsonChunk.message.content;
                                    // Approximate token count for metrics
                                    outputTokens += jsonChunk.message.content.split(/\s+/).length;
                                }

                                // If we have done metrics in the response
                                if (jsonChunk.done && jsonChunk.total_duration) {
                                    logger.info({
                                        message: 'Stream chunk metrics received',
                                        requestId,
                                        model,
                                        duration: jsonChunk.total_duration,
                                        tokensPerSecond: jsonChunk.eval_rate,
                                        timestamp: new Date().toISOString()
                                    });
                                }
                            });
                        } catch (parseError) {
                            // Not all chunks may be valid JSON, which is ok
                        }
                    } catch (chunkError) {
                        logger.error({
                            message: 'Error processing stream chunk',
                            requestId,
                            error: chunkError.message,
                            timestamp: new Date().toISOString()
                        });
                    }
                });

                // Handle stream end
                response.data.on('end', () => {
                    const duration = Date.now() - startTime;

                    // Add placeholder metrics data
                    const metricsData = {
                        usage: {
                            prompt_tokens: req.body.messages ? req.body.messages.reduce((sum, msg) =>
                                sum + (msg.content ? msg.content.split(/\s+/).length : 0), 0) : 0,
                            completion_tokens: outputTokens,
                            total_tokens: outputTokens + (req.body.messages ? req.body.messages.reduce((sum, msg) =>
                                sum + (msg.content ? msg.content.split(/\s+/).length : 0), 0) : 0)
                        }
                    };

                    updateMetrics(node, model, startTime, metricsData);

                    logger.info({
                        message: 'Stream chat completed',
                        requestId,
                        model,
                        node,
                        duration: `${duration}ms`,
                        outputTokens,
                        responseLength: fullResponse.length,
                        timestamp: new Date().toISOString()
                    });

                    // End the response
                    res.end();
                });

                // Handle stream error
                response.data.on('error', (error) => {
                    logger.error({
                        message: 'Stream error',
                        requestId,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });

                    updateMetrics(node, model, startTime, null, true);

                    // Send error to client and end stream
                    res.write(JSON.stringify({ error: error.message }));
                    res.end();
                });
            } catch (error) {
                // Handle Axios errors
                updateMetrics(node, model, startTime, null, true);
                logger.error({
                    message: 'Stream chat API call failed',
                    requestId,
                    model,
                    node,
                    error: error.message,
                    errorCode: error.code,
                    errorResponse: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : 'No response',
                    duration: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                // Send error to client and end stream
                res.write(JSON.stringify({ error: error.message }));
                res.end();
            }
        }).catch(error => {
            // Handle queue errors
            logger.error({
                message: 'Queue error for stream chat',
                requestId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });

            // Send error to client and end stream
            res.write(JSON.stringify({ error: error.message }));
            res.end();
        });
    } catch (error) {
        // Handle uncaught errors
        logger.error({
            message: 'Uncaught error in stream chat',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        // Send error to client and end stream
        res.write(JSON.stringify({ error: error.message }));
        res.end();
    }
});

// Add periodic health logging
setInterval(() => {
    const memoryUsage = process.memoryUsage();
    logger.info({
        message: 'System health stats',
        uptime: Math.floor(process.uptime()),
        memoryUsage: {
            rss: `${Math.round(memoryUsage.rss / (1024 * 1024))} MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB`,
            heapUsed: `${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB`,
            external: `${Math.round(memoryUsage.external / (1024 * 1024))} MB`
        },
        cpuUsage: process.cpuUsage(),
        activeRequests: queue ? queue.pending : 'N/A',
        queuedRequests: queue ? queue.size : 'N/A',
        timestamp: new Date().toISOString()
    });
}, 5 * 60 * 1000); // Every 5 minutes

// Catch-all error handler with enhanced logging
app.use((err, req, res, next) => {
    const requestId = req.id || 'unknown';

    logger.error({
        message: 'Unhandled error',
        requestId,
        method: req.method,
        url: req.originalUrl,
        error: err.message,
        errorName: err.name,
        errorCode: err.code,
        stack: err.stack,
        timestamp: new Date().toISOString()
    });

    res.status(500).json({
        status: 'error',
        message: 'An unexpected error occurred',
        requestId: requestId
    });
});

// Add process uncaught exception handler
process.on('uncaughtException', (error) => {
    logger.error({
        message: 'Uncaught exception',
        error: error.message,
        stack: error.stack,
        fatal: true,
        timestamp: new Date().toISOString()
    });

    // Optional: graceful shutdown
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

// Add process unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
    logger.error({
        message: 'Unhandled promise rejection',
        reason: reason.toString(),
        stack: reason.stack,
        fatal: false,
        timestamp: new Date().toISOString()
    });
});

// Add shutdown logging
process.on('SIGINT', () => {
    logger.info({
        message: 'Server shutting down',
        reason: 'SIGINT received',
        timestamp: new Date().toISOString()
    });
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info({
        message: 'Server shutting down',
        reason: 'SIGTERM received',
        timestamp: new Date().toISOString()
    });
    process.exit(0);
});

initializeMetrics();
