/**
 * CacheKeyGenerator - Utility for creating consistent, unique cache keys
 *
 * This class provides methods for normalizing request data and generating
 * unique cache keys for LLM requests to ensure consistent caching behavior.
 */
class CacheKeyGenerator {
    /**
     * Constructor for CacheKeyGenerator
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            // Hashing algorithm to use ('sha256', 'md5', etc.)
            hashAlgorithm: config.hashAlgorithm || 'sha256',

            // Fields to ignore when generating cache keys
            ignoredFields: config.ignoredFields || [
                'node', 'requestId', 'timestamp', 'stream', 'client_id', 'user_id'
            ],

            // Fields that should affect the key but don't need exact values
            sensitiveFields: config.sensitiveFields || ['api_key', 'authorization'],

            // Whether to normalize whitespace in text
            normalizeWhitespace: config.normalizeWhitespace !== undefined ?
                config.normalizeWhitespace : true,

            // Whether to sort arrays of objects by their content
            sortObjectArrays: config.sortObjectArrays !== undefined ?
                config.sortObjectArrays : true,

            // Logger instance
            logger: config.logger || console,

            ...config
        };

        // Load crypto module if using a hash algorithm
        if (this.config.hashAlgorithm !== 'simple') {
            this.crypto = require('crypto');
        }

        this.config.logger.debug({
            message: 'CacheKeyGenerator initialized',
            hashAlgorithm: this.config.hashAlgorithm,
            ignoredFields: this.config.ignoredFields,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Generate a cache key from request data
     * @param {Object} requestData - Original request data
     * @param {string} requestType - Type of request (e.g., 'generate', 'chat')
     * @returns {string} Cache key
     */
    generateKey(requestData, requestType = 'unknown') {
        // Create a normalized copy of the request for consistent keys
        const normalizedRequest = this.normalizeRequest(requestData, requestType);

        // Add request type to the normalized request for different endpoints
        normalizedRequest._requestType = requestType;

        // Generate hash from normalized request
        const key = this.hashObject(normalizedRequest);

        this.config.logger.debug({
            message: 'Cache key generated',
            requestType,
            keyLength: key.length,
            timestamp: new Date().toISOString()
        });

        return key;
    }

    /**
     * Create a normalized copy of request data for consistent key generation
     * @param {Object} requestData - Original request data
     * @param {string} requestType - Type of request
     * @returns {Object} Normalized request data
     */
    normalizeRequest(requestData, requestType) {
        // Start with a fresh object
        const normalized = {};

        // Handle different request types differently
        if (requestType === 'generate') {
            this.normalizeGenerateRequest(requestData, normalized);
        } else if (requestType === 'chat') {
            this.normalizeChatRequest(requestData, normalized);
        } else {
            // For unknown request types, do generic normalization
            this.normalizeGenericRequest(requestData, normalized);
        }

        return normalized;
    }

    /**
     * Normalize a generate request
     * @param {Object} requestData - Original generate request
     * @param {Object} normalized - Target for normalized data
     */
    normalizeGenerateRequest(requestData, normalized) {
        // Most important field for generate requests is the prompt
        if (requestData.prompt) {
            normalized.prompt = this.normalizeText(requestData.prompt);
        }

        // Include model identifier
        if (requestData.model) {
            normalized.model = requestData.model;
        }

        // Add normalized options that affect the response
        if (requestData.options) {
            normalized.options = this.normalizeOptions(requestData.options);
        }

        // Include format if specified
        if (requestData.format) {
            normalized.format = requestData.format;
        }
    }

    /**
     * Normalize a chat request
     * @param {Object} requestData - Original chat request
     * @param {Object} normalized - Target for normalized data
     */
    normalizeChatRequest(requestData, normalized) {
        // Include model identifier
        if (requestData.model) {
            normalized.model = requestData.model;
        }

        // Normalize system prompt if present
        if (requestData.system) {
            normalized.system = this.normalizeText(requestData.system);
        }

        // Normalize messages array (most important part)
        if (requestData.messages && Array.isArray(requestData.messages)) {
            normalized.messages = this.normalizeMessages(requestData.messages);
        }

        // Add normalized options that affect the response
        if (requestData.options) {
            normalized.options = this.normalizeOptions(requestData.options);
        }
    }

    /**
     * Normalize a generic request
     * @param {Object} requestData - Original request
     * @param {Object} normalized - Target for normalized data
     */
    normalizeGenericRequest(requestData, normalized) {
        // Clone the request, excluding ignored fields
        for (const [key, value] of Object.entries(requestData)) {
            // Skip ignored fields
            if (this.config.ignoredFields.includes(key)) {
                continue;
            }

            // Handle sensitive fields
            if (this.config.sensitiveFields.includes(key)) {
                // Just indicate presence, not actual value
                normalized[key] = '[present]';
                continue;
            }

            // Handle special field types
            if (typeof value === 'string') {
                normalized[key] = this.normalizeText(value);
            } else if (Array.isArray(value)) {
                normalized[key] = this.normalizeArray(value);
            } else if (value && typeof value === 'object') {
                normalized[key] = this.normalizeObject(value);
            } else {
                // Keep primitive values as-is
                normalized[key] = value;
            }
        }
    }

    /**
     * Normalize text content by trimming and optionally normalizing whitespace
     * @param {string} text - Text to normalize
     * @returns {string} Normalized text
     */
    normalizeText(text) {
        if (typeof text !== 'string') return text;

        let normalized = text.trim();

        // Normalize whitespace if configured
        if (this.config.normalizeWhitespace) {
            // Replace sequences of whitespace with single space
            normalized = normalized.replace(/\s+/g, ' ');
        }

        return normalized;
    }

    /**
     * Normalize an array by processing its elements
     * @param {Array} array - Array to normalize
     * @returns {Array} Normalized array
     */
    normalizeArray(array) {
        if (!Array.isArray(array)) return array;

        // Map each element through appropriate normalization
        const normalized = array.map(item => {
            if (typeof item === 'string') {
                return this.normalizeText(item);
            } else if (Array.isArray(item)) {
                return this.normalizeArray(item);
            } else if (item && typeof item === 'object') {
                return this.normalizeObject(item);
            } else {
                return item;
            }
        });

        // Sort arrays of objects if configured to do so
        if (this.config.sortObjectArrays && normalized.length > 0 &&
            normalized[0] && typeof normalized[0] === 'object') {
            return this.sortObjectArray(normalized);
        }

        return normalized;
    }

    /**
     * Normalize chat messages array
     * @param {Array} messages - Chat messages to normalize
     * @returns {Array} Normalized messages
     */
    normalizeMessages(messages) {
        if (!Array.isArray(messages)) return [];

        // Process each message object
        const normalized = messages.map(msg => {
            // Create a new object with only relevant fields
            const normalizedMsg = {};

            // Always include role
            if (msg.role) {
                normalizedMsg.role = msg.role;
            }

            // Normalize content
            if (msg.content) {
                normalizedMsg.content = this.normalizeText(msg.content);
            }

            return normalizedMsg;
        });

        return normalized;
    }

    /**
     * Normalize options object by keeping only fields that affect generation
     * @param {Object} options - Options object
     * @returns {Object} Normalized options
     */
    normalizeOptions(options) {
        if (!options || typeof options !== 'object') return {};

        // Fields that affect generation results
        const relevantOptions = [
            'temperature', 'top_p', 'top_k', 'max_tokens', 'presence_penalty',
            'frequency_penalty', 'stop', 'seed', 'grammar', 'n'
        ];

        const normalized = {};

        // Only keep relevant options
        for (const key of relevantOptions) {
            if (options[key] !== undefined) {
                normalized[key] = options[key];
            }
        }

        return normalized;
    }

    /**
     * Normalize an object by processing its properties
     * @param {Object} obj - Object to normalize
     * @returns {Object} Normalized object
     */
    normalizeObject(obj) {
        if (!obj || typeof obj !== 'object') return obj;

        const normalized = {};

        // Get sorted keys for consistent order
        const keys = Object.keys(obj).sort();

        for (const key of keys) {
            // Skip ignored fields
            if (this.config.ignoredFields.includes(key)) {
                continue;
            }

            // Handle sensitive fields
            if (this.config.sensitiveFields.includes(key)) {
                normalized[key] = '[present]';
                continue;
            }

            const value = obj[key];

            // Process values by type
            if (typeof value === 'string') {
                normalized[key] = this.normalizeText(value);
            } else if (Array.isArray(value)) {
                normalized[key] = this.normalizeArray(value);
            } else if (value && typeof value === 'object') {
                normalized[key] = this.normalizeObject(value);
            } else {
                normalized[key] = value;
            }
        }

        return normalized;
    }

    /**
     * Sort an array of objects by serializing and comparing them
     * @param {Array} array - Array of objects to sort
     * @returns {Array} Sorted array
     */
    sortObjectArray(array) {
        return [...array].sort((a, b) => {
            const aStr = JSON.stringify(a);
            const bStr = JSON.stringify(b);
            return aStr.localeCompare(bStr);
        });
    }

    /**
     * Hash an object to create a unique key
     * @param {Object} obj - Object to hash
     * @returns {string} Hash string
     */
    hashObject(obj) {
        // Serialize the object deterministically
        const serialized = JSON.stringify(obj);

        // Apply hashing algorithm
        if (this.config.hashAlgorithm === 'simple') {
            return this.simpleHash(serialized);
        } else {
            // Use crypto for more sophisticated hashing
            return this.cryptoHash(serialized);
        }
    }

    /**
     * Create a simple hash for a string (for environments without crypto)
     * @param {string} str - String to hash
     * @returns {string} Simple hash value
     */
    simpleHash(str) {
        let hash = 0;

        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }

        // Convert to hex string (ensure positive)
        return Math.abs(hash).toString(16);
    }

    /**
     * Create a cryptographic hash for a string
     * @param {string} str - String to hash
     * @returns {string} Cryptographic hash value
     */
    cryptoHash(str) {
        const hash = this.crypto.createHash(this.config.hashAlgorithm);
        hash.update(str);
        return hash.digest('hex');
    }

    /**
     * Generate a cache key from a chat request
     * @param {Object} chatRequest - Chat request object
     * @returns {string} Cache key
     */
    chatKey(chatRequest) {
        return this.generateKey(chatRequest, 'chat');
    }

    /**
     * Generate a cache key from a generate request
     * @param {Object} generateRequest - Generate request object
     * @returns {string} Cache key
     */
    generateKey(generateRequest) {
        return this.generateKey(generateRequest, 'generate');
    }
}

module.exports = CacheKeyGenerator;