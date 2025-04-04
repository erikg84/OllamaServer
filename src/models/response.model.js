// src/models/response.model.js

/**
 * Model for standardized API responses
 * Ensures consistent response format across endpoints
 */

/**
 * Create a successful response object
 * @param {*} data - Response data
 * @param {string} message - Success message
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Success response object
 */
function createSuccessResponse(data, message = 'Success', metadata = {}) {
    return {
        status: 'success',
        message,
        data,
        metadata: {
            timestamp: new Date().toISOString(),
            ...metadata
        }
    };
}

/**
 * Create an error response object
 * @param {string} message - Error message
 * @param {string} code - Error code
 * @param {Object} details - Additional error details
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Error response object
 */
function createErrorResponse(message = 'An error occurred', code = 'internal_error', details = {}, metadata = {}) {
    return {
        status: 'error',
        message,
        code,
        details,
        metadata: {
            timestamp: new Date().toISOString(),
            ...metadata
        }
    };
}

/**
 * Create a validation error response object
 * @param {string} message - Error message
 * @param {Array} validationErrors - Validation errors
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Validation error response object
 */
function createValidationErrorResponse(message = 'Validation failed', validationErrors = [], metadata = {}) {
    return createErrorResponse(message, 'validation_error', { validationErrors }, metadata);
}

/**
 * Create a not found error response object
 * @param {string} resource - Resource that was not found
 * @param {string} identifier - Resource identifier
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Not found error response object
 */
function createNotFoundResponse(resource = 'Resource', identifier = '', metadata = {}) {
    const message = identifier
        ? `${resource} not found with identifier: ${identifier}`
        : `${resource} not found`;

    return createErrorResponse(message, 'not_found', { resource, identifier }, metadata);
}

/**
 * Create a response object for MAESTRO agent collaboration
 * @param {*} data - Response data
 * @param {Array} collaborationSteps - Steps in the collaboration process
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Agent collaboration response object
 */
function createAgentCollaborationResponse(data, collaborationSteps = [], metadata = {}) {
    return {
        status: 'success',
        message: 'Agent collaboration completed',
        data,
        collaboration: {
            steps: collaborationSteps,
            agentCount: collaborationSteps.length > 0
                ? [...new Set(collaborationSteps.map(step => step.agentId))].length
                : 0,
            stepCount: collaborationSteps.length
        },
        metadata: {
            timestamp: new Date().toISOString(),
            ...metadata
        }
    };
}

/**
 * Create a paginated response object
 * @param {Array} data - Page data
 * @param {number} page - Current page number
 * @param {number} pageSize - Page size
 * @param {number} total - Total number of items
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Paginated response object
 */
function createPaginatedResponse(data, page = 1, pageSize = 10, total = 0, metadata = {}) {
    const totalPages = Math.ceil(total / pageSize);

    return {
        status: 'success',
        data,
        pagination: {
            page,
            pageSize,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1
        },
        metadata: {
            timestamp: new Date().toISOString(),
            ...metadata
        }
    };
}

/**
 * Create a stream initialization response
 * @param {string} streamId - Stream identifier
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Stream initialization response
 */
function createStreamInitResponse(streamId, metadata = {}) {
    return {
        status: 'success',
        message: 'Stream initialized',
        streamId,
        metadata: {
            timestamp: new Date().toISOString(),
            ...metadata
        }
    };
}

module.exports = {
    createSuccessResponse,
    createErrorResponse,
    createValidationErrorResponse,
    createNotFoundResponse,
    createAgentCollaborationResponse,
    createPaginatedResponse,
    createStreamInitResponse
};