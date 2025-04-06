/**
 * Cache Middleware for Express
 *
 * This middleware checks the cache before processing requests
 * and returns cached responses when available.
 */

/**
 * Create cache middleware with provided components
 * @param {Object} cache - RequestCache instance
 * @param {Object} keyGenerator - CacheKeyGenerator instance
 * @param {Object} metrics - CacheMetrics instance
 * @param {Object} logger - Winston logger instance
 * @returns {Function} Express middleware function
 */
function createCacheMiddleware(cache, keyGenerator, metrics, logger) {
    return function cacheMiddleware(req, res, next) {
        // Skip cache for non-cacheable endpoints
        if (req.path.startsWith('/health') ||
            req.path.startsWith('/admin') ||
            req.path === '/queue-status' ||
            req.path === '/models') {
            return next();
        }

        // Skip cache if disabled globally
        if (!global.cacheEnabled) {
            return next();
        }

        // Skip cache if client explicitly requests fresh response
        if (req.headers['cache-control'] === 'no-cache') {
            logger.debug({
                message: 'Cache skipped due to no-cache header',
                requestId: req.id,
                path: req.path,
                timestamp: new Date().toISOString()
            });
            return next();
        }

        // Get model ID from request
        const modelId = req.body.model || 'default';

        // Skip cache for excluded models
        if (global.cacheExcludedModels && global.cacheExcludedModels.includes(modelId)) {
            logger.debug({
                message: 'Cache skipped for excluded model',
                requestId: req.id,
                modelId,
                path: req.path,
                timestamp: new Date().toISOString()
            });
            return next();
        }

        // Determine request type based on endpoint
        let requestType = 'unknown';
        if (req.path === '/generate') {
            requestType = 'generate';
        } else if (req.path === '/chat') {
            requestType = 'chat';
        }

        // Start timer for cache operations
        const cacheStartTime = Date.now();

        // Generate cache key
        let key;
        try {
            key = keyGenerator.generateKey(req.body, requestType);
        } catch (error) {
            logger.warn({
                message: 'Error generating cache key',
                requestId: req.id,
                error: error.message,
                path: req.path,
                timestamp: new Date().toISOString()
            });
            metrics.recordError({
                errorType: 'keyGeneration',
                message: error.message
            });
            return next();
        }

        const keyGenTime = Date.now() - cacheStartTime;

        // Check cache for hit
        let cachedResponse;
        try {
            cachedResponse = cache.get(key);
        } catch (error) {
            logger.warn({
                message: 'Error retrieving from cache',
                requestId: req.id,
                error: error.message,
                path: req.path,
                timestamp: new Date().toISOString()
            });
            metrics.recordError({
                errorType: 'cacheGet',
                message: error.message
            });
            return next();
        }

        const cacheCheckDuration = Date.now() - cacheStartTime;

        // Store the generated key and timing info for later use
        req.cacheInfo = {
            key,
            requestType,
            modelId,
            keyGenTime,
            lookupStartTime: cacheStartTime
        };

        // If we have a cache hit
        if (cachedResponse) {
            // Record cache hit in metrics
            metrics.recordHit({
                duration: cacheCheckDuration,
                requestType,
                modelId,
                keyGenTime,
                avgMissDuration: metrics.current.avgMissDuration
            });

            logger.info({
                message: 'Cache hit',
                requestId: req.id,
                modelId,
                path: req.path,
                keyGenTime: `${keyGenTime}ms`,
                cacheCheckDuration: `${cacheCheckDuration}ms`,
                timestamp: new Date().toISOString()
            });

            // Add cache headers
            res.set('X-Cache', 'HIT');
            res.set('X-Cache-Key', key);

            // Return cached response
            return res.json(cachedResponse);
        }

        // Record cache miss in metrics
        metrics.recordMiss({
            duration: cacheCheckDuration,
            requestType,
            modelId,
            keyGenTime
        });

        logger.debug({
            message: 'Cache miss',
            requestId: req.id,
            modelId,
            path: req.path,
            keyGenTime: `${keyGenTime}ms`,
            cacheCheckDuration: `${cacheCheckDuration}ms`,
            timestamp: new Date().toISOString()
        });

        // Store original JSON method to intercept response
        const originalJson = res.json;

        // Override res.json to intercept the response
        res.json = function(data) {
            // Add cache headers
            res.set('X-Cache', 'MISS');

            // Store start time for this API call
            const apiStartTime = req.cacheInfo.lookupStartTime;
            const apiDuration = Date.now() - apiStartTime;

            // Check if response should be cached
            const shouldCache = !isError(data) &&
                (!req.body.stream) &&  // Don't cache streaming responses
                (requestType === 'generate' || requestType === 'chat');

            if (shouldCache) {
                try {
                    // Cache successful response
                    cache.set(req.cacheInfo.key, data, {
                        modelId: req.cacheInfo.modelId,
                        requestType: req.cacheInfo.requestType,
                        ttl: getModelTTL(req.cacheInfo.modelId)
                    });

                    // Record successful addition
                    metrics.recordAdd({
                        bytes: getApproximateSize(data),
                        modelId: req.cacheInfo.modelId,
                        requestType: req.cacheInfo.requestType
                    });

                    logger.debug({
                        message: 'Response added to cache',
                        requestId: req.id,
                        modelId: req.cacheInfo.modelId,
                        key: req.cacheInfo.key,
                        apiDuration: `${apiDuration}ms`,
                        timestamp: new Date().toISOString()
                    });
                } catch (error) {
                    logger.warn({
                        message: 'Error storing response in cache',
                        requestId: req.id,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                    metrics.recordError({
                        errorType: 'cacheSet',
                        message: error.message
                    });
                }
            } else if (isError(data)) {
                logger.debug({
                    message: 'Error response not cached',
                    requestId: req.id,
                    errorStatus: data.status || 'unknown',
                    timestamp: new Date().toISOString()
                });
            }

            // Call original json method
            return originalJson.call(this, data);
        };

        next();
    };
}

/**
 * Check if a response is an error
 * @param {Object} response - Response to check
 * @returns {boolean} True if response is an error
 */
function isError(response) {
    return (
        !response ||
        response.status === 'error' ||
        response.error ||
        response.message && response.message.toLowerCase().includes('error')
    );
}

/**
 * Get TTL for a specific model
 * @param {string} modelId - Model identifier
 * @returns {number} TTL in milliseconds
 */
function getModelTTL(modelId) {
    if (global.cacheModelTTL && global.cacheModelTTL[modelId]) {
        return global.cacheModelTTL[modelId];
    }
    return global.defaultCacheTTL || 30 * 60 * 1000; // Default: 30 minutes
}

/**
 * Get approximate size of an object in bytes
 * @param {Object} obj - Object to measure
 * @returns {number} Approximate size in bytes
 */
function getApproximateSize(obj) {
    const jsonString = JSON.stringify(obj);
    return jsonString.length * 2; // Approximation: 2 bytes per character
}

module.exports = createCacheMiddleware;