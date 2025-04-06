/**
 * RequestCache - LRU cache implementation for LLM request responses
 *
 * This class provides a Least Recently Used (LRU) caching system
 * for storing and retrieving responses to common LLM requests,
 * with TTL management and size-based eviction.
 */
class RequestCache {
    /**
     * Constructor for RequestCache
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            // Maximum number of items to store in cache
            maxSize: config.maxSize || 1000,

            // Default TTL in milliseconds (30 minutes)
            defaultTTL: config.defaultTTL || 30 * 60 * 1000,

            // Maximum memory usage in MB (default: 512MB)
            maxMemoryMB: config.maxMemoryMB || 512,

            // Check interval for expired entries (default: 1 minute)
            cleanupInterval: config.cleanupInterval || 60 * 1000,

            // Model-specific TTL overrides
            modelTTL: config.modelTTL || {},

            // Models to exclude from caching
            excludedModels: config.excludedModels || [],

            // Whether to compress cached responses
            compressResponses: config.compressResponses !== undefined ?
                config.compressResponses : true,

            // Logger instance
            logger: config.logger || console,

            ...config
        };

        // Cache storage - using Map to maintain insertion order for LRU
        this.cache = new Map();

        // Cache statistics
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: {
                ttl: 0,
                size: 0,
                memory: 0
            },
            itemsAdded: 0,
            currentSize: 0,
            estimatedMemoryUsage: 0,
            bytesStored: 0
        };

        // Start TTL cleanup timer
        this.cleanupTimer = setInterval(() => {
            this.removeExpiredEntries();
        }, this.config.cleanupInterval);

        // Bind methods to maintain 'this' context
        this.get = this.get.bind(this);
        this.set = this.set.bind(this);
        this.remove = this.remove.bind(this);
        this.clear = this.clear.bind(this);

        this.config.logger.info({
            message: 'RequestCache initialized',
            maxSize: this.config.maxSize,
            defaultTTL: `${this.config.defaultTTL}ms`,
            maxMemoryMB: `${this.config.maxMemoryMB}MB`,
            compressResponses: this.config.compressResponses,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Generate a cache key from request data
     * @param {Object} requestData - Request data to generate key from
     * @returns {string} Cache key
     */
    generateKey(requestData) {
        // Create a normalized request object for consistent keys
        const normalizedRequest = this.normalizeRequest(requestData);

        // Use consistent serialization and hash for key
        const serialized = JSON.stringify(normalizedRequest);
        return this.hashString(serialized);
    }

    /**
     * Normalize request object to ensure consistent cache keys
     * @param {Object} requestData - Original request data
     * @returns {Object} Normalized request object
     */
    normalizeRequest(requestData) {
        // Create shallow copy of request
        const normalized = { ...requestData };

        // Remove fields that shouldn't affect caching
        delete normalized.node;
        delete normalized.requestId;
        delete normalized.timestamp;

        // Sort messages array if present (for chat)
        if (normalized.messages && Array.isArray(normalized.messages)) {
            // Ensure deterministic order of message objects
            normalized.messages = normalized.messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }));
        }

        // Sort options object keys for consistency
        if (normalized.options && typeof normalized.options === 'object') {
            const sortedOptions = {};
            Object.keys(normalized.options).sort().forEach(key => {
                sortedOptions[key] = normalized.options[key];
            });
            normalized.options = sortedOptions;
        }

        return normalized;
    }

    /**
     * Simple hash function for strings
     * @param {string} str - String to hash
     * @returns {string} Hashed string
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }

        // Convert to hex string and ensure positive
        return Math.abs(hash).toString(16);
    }

    /**
     * Get an item from the cache
     * @param {string} key - Cache key
     * @returns {Object|null} Cached item or null if not found/expired
     */
    get(key) {
        // Check if key exists in cache
        if (!this.cache.has(key)) {
            this.stats.misses++;
            return null;
        }

        const item = this.cache.get(key);

        // Check if item has expired
        if (item.expiry && item.expiry < Date.now()) {
            // Remove expired item
            this.cache.delete(key);
            this.stats.evictions.ttl++;
            this.stats.currentSize--;
            this.updateMemoryUsage();

            this.config.logger.debug({
                message: 'Cache item expired',
                key,
                storedAt: new Date(item.timestamp).toISOString(),
                expiredAt: new Date(item.expiry).toISOString(),
                timestamp: new Date().toISOString()
            });

            this.stats.misses++;
            return null;
        }

        // Update item position in LRU order (delete and re-add)
        this.cache.delete(key);
        this.cache.set(key, item);

        // Decompress if needed
        let value = item.value;
        if (item.compressed && this.config.compressResponses) {
            value = this.decompress(value);
        }

        this.stats.hits++;

        this.config.logger.debug({
            message: 'Cache hit',
            key,
            modelId: item.modelId,
            storedAt: new Date(item.timestamp).toISOString(),
            expiresAt: item.expiry ? new Date(item.expiry).toISOString() : 'never',
            timestamp: new Date().toISOString()
        });

        return value;
    }

    /**
     * Store an item in the cache
     * @param {string} key - Cache key
     * @param {Object} value - Value to store
     * @param {Object} metadata - Additional metadata about the cached item
     * @returns {boolean} True if item was stored successfully
     */
    set(key, value, metadata = {}) {
        // Check if model is excluded from caching
        if (metadata.modelId && this.config.excludedModels.includes(metadata.modelId)) {
            this.config.logger.debug({
                message: 'Skipping cache for excluded model',
                key,
                modelId: metadata.modelId,
                timestamp: new Date().toISOString()
            });
            return false;
        }

        // Determine TTL (time to live)
        let ttl = this.config.defaultTTL;

        // Apply model-specific TTL if available
        if (metadata.modelId && this.config.modelTTL[metadata.modelId]) {
            ttl = this.config.modelTTL[metadata.modelId];
        }

        // Allow override from metadata
        if (metadata.ttl) {
            ttl = metadata.ttl;
        }

        // Calculate expiry time
        const expiry = ttl > 0 ? Date.now() + ttl : null;

        // Compress value if configured
        let storedValue = value;
        let compressed = false;
        let originalSize = this.estimateSize(value);
        let storedSize = originalSize;

        if (this.config.compressResponses) {
            storedValue = this.compress(value);
            compressed = true;
            storedSize = this.estimateSize(storedValue);
        }

        // Create cache item
        const item = {
            value: storedValue,
            compressed,
            originalSize,
            storedSize,
            timestamp: Date.now(),
            expiry,
            modelId: metadata.modelId || 'unknown',
            requestType: metadata.requestType || 'unknown',
            hits: 0
        };

        // Enforce maximum size
        if (this.stats.currentSize >= this.config.maxSize) {
            this.evictOldest();
        }

        // Check memory usage before adding
        const estimatedNewMemory = this.stats.estimatedMemoryUsage + storedSize;
        const maxMemoryBytes = this.config.maxMemoryMB * 1024 * 1024;

        if (estimatedNewMemory > maxMemoryBytes) {
            // Need to free up memory
            this.evictForMemory(storedSize);
        }

        // Add to cache
        this.cache.set(key, item);
        this.stats.itemsAdded++;
        this.stats.currentSize++;
        this.stats.bytesStored += storedSize;
        this.updateMemoryUsage();

        this.config.logger.debug({
            message: 'Item added to cache',
            key,
            modelId: metadata.modelId,
            originalSize: `${Math.round(originalSize / 1024)} KB`,
            storedSize: `${Math.round(storedSize / 1024)} KB`,
            compressionRatio: compressed ? `${Math.round((1 - (storedSize / originalSize)) * 100)}%` : 'none',
            expiresAt: expiry ? new Date(expiry).toISOString() : 'never',
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Estimate size of an object in bytes
     * @param {Object} obj - Object to estimate size of
     * @returns {number} Estimated size in bytes
     */
    estimateSize(obj) {
        // Convert to JSON string and measure that
        const str = JSON.stringify(obj);

        // Approximate memory usage (2 bytes per character in strings)
        return str.length * 2;
    }

    /**
     * Remove an item from the cache
     * @param {string} key - Cache key to remove
     * @returns {boolean} True if item was removed, false if not found
     */
    remove(key) {
        if (!this.cache.has(key)) {
            return false;
        }

        const item = this.cache.get(key);
        this.cache.delete(key);
        this.stats.currentSize--;
        this.stats.bytesStored -= item.storedSize;
        this.updateMemoryUsage();

        this.config.logger.debug({
            message: 'Item removed from cache',
            key,
            modelId: item.modelId,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Clear all items from the cache
     * @returns {number} Number of items cleared
     */
    clear() {
        const count = this.cache.size;

        this.cache.clear();
        this.stats.currentSize = 0;
        this.stats.bytesStored = 0;
        this.updateMemoryUsage();

        this.config.logger.info({
            message: 'Cache cleared',
            itemsCleared: count,
            timestamp: new Date().toISOString()
        });

        return count;
    }

    /**
     * Update estimated memory usage
     */
    updateMemoryUsage() {
        this.stats.estimatedMemoryUsage = this.stats.bytesStored;
    }

    /**
     * Remove oldest item from cache (LRU eviction)
     * @returns {boolean} True if an item was evicted
     */
    evictOldest() {
        if (this.cache.size === 0) {
            return false;
        }

        // Get oldest key (first item in Map)
        const oldestKey = this.cache.keys().next().value;
        const oldestItem = this.cache.get(oldestKey);

        this.remove(oldestKey);
        this.stats.evictions.size++;

        this.config.logger.debug({
            message: 'Evicted oldest item from cache (LRU)',
            key: oldestKey,
            modelId: oldestItem.modelId,
            storedAt: new Date(oldestItem.timestamp).toISOString(),
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Evict items to free up at least the specified amount of memory
     * @param {number} bytesNeeded - Bytes to free up
     * @returns {number} Number of items evicted
     */
    evictForMemory(bytesNeeded) {
        let bytesFreed = 0;
        let evictionCount = 0;

        // Get iterator for cache keys (oldest first)
        const keyIterator = this.cache.keys();

        // Evict until we've freed enough space
        while (bytesFreed < bytesNeeded && this.cache.size > 0) {
            const key = keyIterator.next().value;
            if (!key) break;

            const item = this.cache.get(key);
            bytesFreed += item.storedSize;

            this.remove(key);
            evictionCount++;
            this.stats.evictions.memory++;
        }

        this.config.logger.debug({
            message: 'Memory-based cache eviction',
            bytesNeeded,
            bytesFreed,
            itemsEvicted: evictionCount,
            timestamp: new Date().toISOString()
        });

        return evictionCount;
    }

    /**
     * Remove expired entries from cache
     * @returns {number} Number of expired items removed
     */
    removeExpiredEntries() {
        const now = Date.now();
        let removedCount = 0;

        for (const [key, item] of this.cache.entries()) {
            if (item.expiry && item.expiry < now) {
                this.cache.delete(key);
                this.stats.evictions.ttl++;
                this.stats.currentSize--;
                this.stats.bytesStored -= item.storedSize;
                removedCount++;
            }
        }

        if (removedCount > 0) {
            this.updateMemoryUsage();

            this.config.logger.debug({
                message: 'Removed expired cache entries',
                removedCount,
                remainingItems: this.cache.size,
                timestamp: new Date().toISOString()
            });
        }

        return removedCount;
    }

    /**
     * Compress data to reduce memory usage
     * @param {Object} data - Data to compress
     * @returns {Buffer|Object} Compressed data or original if compression fails
     */
    compress(data) {
        // In a full implementation, this would use zlib or a similar library
        // For this example, we'll return the original data
        return data;
    }

    /**
     * Decompress data
     * @param {Buffer|Object} data - Data to decompress
     * @returns {Object} Decompressed data
     */
    decompress(data) {
        // In a full implementation, this would use zlib or a similar library
        // For this example, we'll return the original data
        return data;
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getStats() {
        const hitRate = (this.stats.hits + this.stats.misses) > 0 ?
            (this.stats.hits / (this.stats.hits + this.stats.misses)) * 100 : 0;

        return {
            size: {
                current: this.stats.currentSize,
                max: this.config.maxSize,
                percentage: (this.stats.currentSize / this.config.maxSize) * 100
            },
            memory: {
                estimatedUsageMB: Math.round(this.stats.estimatedMemoryUsage / (1024 * 1024) * 100) / 100,
                maxMB: this.config.maxMemoryMB,
                percentage: (this.stats.estimatedMemoryUsage / (this.config.maxMemoryMB * 1024 * 1024)) * 100
            },
            performance: {
                hits: this.stats.hits,
                misses: this.stats.misses,
                hitRate: `${hitRate.toFixed(2)}%`,
                itemsAdded: this.stats.itemsAdded
            },
            evictions: {
                ttl: this.stats.evictions.ttl,
                size: this.stats.evictions.size,
                memory: this.stats.evictions.memory,
                total: this.stats.evictions.ttl + this.stats.evictions.size + this.stats.evictions.memory
            },
            models: this.getModelStats(),
            config: {
                compressResponses: this.config.compressResponses,
                defaultTTL: this.config.defaultTTL,
                cleanupInterval: this.config.cleanupInterval,
                excludedModels: this.config.excludedModels
            }
        };
    }

    /**
     * Get per-model cache statistics
     * @returns {Object} Model statistics
     */
    getModelStats() {
        const modelStats = {};

        // Count items per model
        for (const item of this.cache.values()) {
            const modelId = item.modelId || 'unknown';

            if (!modelStats[modelId]) {
                modelStats[modelId] = {
                    count: 0,
                    totalSize: 0
                };
            }

            modelStats[modelId].count++;
            modelStats[modelId].totalSize += item.storedSize;
        }

        // Convert bytes to KB for readability
        Object.keys(modelStats).forEach(modelId => {
            modelStats[modelId].totalSizeKB = Math.round(modelStats[modelId].totalSize / 1024);
            modelStats[modelId].percentage = (modelStats[modelId].count / this.stats.currentSize) * 100;
        });

        return modelStats;
    }

    /**
     * Stop cache cleanup timer
     */
    stop() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        this.config.logger.info({
            message: 'RequestCache stopped',
            itemsInCache: this.cache.size,
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = RequestCache;