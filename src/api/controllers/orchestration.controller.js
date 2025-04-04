/**
 * @file orchestration.controller.js
 * @description Controller for the multi-agent orchestration system (MAESTRO).
 * Handles the coordination of specialized AI agents, manages workflows,
 * and synthesizes results from collaborative agent interactions.
 *
 * This controller serves as the central command for the MAESTRO architecture
 * (Multi-Agent Ensemble for Strategic Text Response Orchestration).
 *
 * @module controllers/orchestration
 * @requires services/llama.service
 * @requires services/queue.service
 * @requires agents/agent-manager
 * @requires orchestration/workflow-engine
 * @requires orchestration/task-decomposer
 * @requires orchestration/result-synthesizer
 * @requires knowledge/shared-workspace
 * @requires communication/message-broker
 * @requires logging/logger
 */

const { v4: uuidv4 } = require('uuid');
const llamaService = require('../services/llama.service');
const queueService = require('../services/queue.service');
const agentManager = require('../agents/agent-manager');
const workflowEngine = require('../orchestration/workflow-engine');
const taskDecomposer = require('../orchestration/task-decomposer');
const resultSynthesizer = require('../orchestration/result-synthesizer');
const sharedWorkspace = require('../knowledge/shared-workspace');
const messageBroker = require('../communication/message-broker');
const logger = require('../logging/logger');

/**
 * Initiates an orchestrated response using the MAESTRO system
 *
 * @async
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>} - Resolves when the response is sent
 */
exports.orchestrate = async (req, res, next) => {
    const requestId = req.id || uuidv4();
    const startTime = Date.now();

    logger.info({
        message: 'Orchestration request received',
        requestId,
        endpoint: '/api/orchestrate',
        timestamp: new Date().toISOString()
    });

    try {
        const { query, options = {} } = req.body;

        if (!query) {
            logger.warn({
                message: 'Orchestration request missing query',
                requestId,
                timestamp: new Date().toISOString()
            });

            return res.status(400).json({
                status: 'error',
                message: 'Query is required'
            });
        }

        logger.info({
            message: 'Orchestration request details',
            requestId,
            queryLength: query.length,
            options,
            timestamp: new Date().toISOString()
        });

        // Create a session ID for this orchestration
        const sessionId = uuidv4();

        // Initialize shared workspace for this session
        await sharedWorkspace.initializeSession(sessionId, {
            query,
            options,
            requestId,
            startTime
        });

        logger.info({
            message: 'Shared workspace initialized',
            requestId,
            sessionId,
            timestamp: new Date().toISOString()
        });

        // Add orchestration task to queue
        const orchestrationResult = await queueService.add(async () => {
            logger.info({
                message: 'Starting orchestration workflow',
                requestId,
                sessionId,
                timestamp: new Date().toISOString()
            });

            try {
                // 1. Analyze query using coordinator agent
                const coordinator = await agentManager.getAgent('coordinator');

                logger.info({
                    message: 'Coordinator agent initialized',
                    requestId,
                    sessionId,
                    agentId: coordinator.id,
                    timestamp: new Date().toISOString()
                });

                const analysisMessage = await coordinator.analyze(query, options);

                logger.info({
                    message: 'Query analyzed by coordinator',
                    requestId,
                    sessionId,
                    analysisType: analysisMessage.analysisType,
                    confidence: analysisMessage.confidence,
                    timestamp: new Date().toISOString()
                });

                // 2. Decompose task into subtasks
                const subtasks = await taskDecomposer.decompose(query, analysisMessage);

                logger.info({
                    message: 'Task decomposed into subtasks',
                    requestId,
                    sessionId,
                    subtaskCount: subtasks.length,
                    timestamp: new Date().toISOString()
                });

                // Store subtasks in shared workspace
                await sharedWorkspace.storeResource(sessionId, 'subtasks', subtasks);

                // 3. Determine the most appropriate workflow pattern based on analysis
                const workflowPattern = workflowEngine.determineWorkflowPattern(analysisMessage);

                logger.info({
                    message: 'Workflow pattern determined',
                    requestId,
                    sessionId,
                    workflowPattern,
                    timestamp: new Date().toISOString()
                });

                // 4. Execute the workflow
                const agentsToInvolve = analysisMessage.recommendedAgents || ['research', 'reasoning', 'creative'];

                logger.info({
                    message: 'Executing workflow with agents',
                    requestId,
                    sessionId,
                    workflowPattern,
                    agentsToInvolve,
                    timestamp: new Date().toISOString()
                });

                const workflowResults = await workflowEngine.executeWorkflow({
                    pattern: workflowPattern,
                    sessionId,
                    agents: agentsToInvolve,
                    subtasks,
                    options
                });

                logger.info({
                    message: 'Workflow execution completed',
                    requestId,
                    sessionId,
                    resultCount: workflowResults.length,
                    timestamp: new Date().toISOString()
                });

                // 5. Synthesize results
                const synthesizedResult = await resultSynthesizer.synthesize(sessionId, workflowResults);

                logger.info({
                    message: 'Results synthesized',
                    requestId,
                    sessionId,
                    synthesizedResultLength: synthesizedResult.content.length,
                    timestamp: new Date().toISOString()
                });

                // 6. Quality control using critic agent
                const critic = await agentManager.getAgent('critic');
                const qualityReport = await critic.evaluate(synthesizedResult, {
                    sessionId,
                    query,
                    options
                });

                logger.info({
                    message: 'Quality evaluation completed',
                    requestId,
                    sessionId,
                    qualityScore: qualityReport.overallScore,
                    recommendations: qualityReport.recommendations.length,
                    timestamp: new Date().toISOString()
                });

                // 7. Final refinement if needed
                let finalResult = synthesizedResult;

                if (qualityReport.needsRefinement) {
                    logger.info({
                        message: 'Refining result based on quality evaluation',
                        requestId,
                        sessionId,
                        timestamp: new Date().toISOString()
                    });

                    finalResult = await coordinator.refine(synthesizedResult, qualityReport);

                    logger.info({
                        message: 'Result refinement completed',
                        requestId,
                        sessionId,
                        finalResultLength: finalResult.content.length,
                        timestamp: new Date().toISOString()
                    });
                }

                // 8. Prepare response with additional metadata
                const response = {
                    content: finalResult.content,
                    metadata: {
                        sessionId,
                        processingTime: Date.now() - startTime,
                        workflowPattern,
                        agentsInvolved: agentsToInvolve,
                        qualityScore: qualityReport.overallScore,
                        confidence: finalResult.confidence || 0.9
                    }
                };

                // 9. Return the final response
                logger.info({
                    message: 'Orchestration completed successfully',
                    requestId,
                    sessionId,
                    processingTime: `${Date.now() - startTime}ms`,
                    timestamp: new Date().toISOString()
                });

                return response;
            } catch (error) {
                logger.error({
                    message: 'Error during orchestration workflow',
                    requestId,
                    sessionId,
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });

                throw error;
            }
        });

        // Send response to client
        res.json({
            status: 'success',
            result: orchestrationResult,
            processingTime: Date.now() - startTime
        });

        // Clean up workspace after sending response
        setTimeout(async () => {
            try {
                await sharedWorkspace.cleanupSession(sessionId);

                logger.info({
                    message: 'Shared workspace cleaned up',
                    requestId,
                    sessionId,
                    timestamp: new Date().toISOString()
                });
            } catch (cleanupError) {
                logger.error({
                    message: 'Error cleaning up shared workspace',
                    requestId,
                    sessionId,
                    error: cleanupError.message,
                    timestamp: new Date().toISOString()
                });
            }
        }, 5000); // Delay cleanup to ensure all processes are complete
    } catch (error) {
        logger.error({
            message: 'Orchestration request failed',
            requestId,
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
};

/**
 * Retrieves the details of a specific orchestration session
 *
 * @async
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>} - Resolves when the response is sent
 */
exports.getSessionDetails = async (req, res, next) => {
    const requestId = req.id || uuidv4();
    const { sessionId } = req.params;

    logger.info({
        message: 'Session details requested',
        requestId,
        sessionId,
        endpoint: `/api/orchestrate/session/${sessionId}`,
        timestamp: new Date().toISOString()
    });

    try {
        const sessionExists = await sharedWorkspace.sessionExists(sessionId);

        if (!sessionExists) {
            logger.warn({
                message: 'Session not found',
                requestId,
                sessionId,
                timestamp: new Date().toISOString()
            });

            return res.status(404).json({
                status: 'error',
                message: 'Session not found'
            });
        }

        const sessionData = await sharedWorkspace.getSessionData(sessionId);

        logger.info({
            message: 'Session details retrieved',
            requestId,
            sessionId,
            dataSize: JSON.stringify(sessionData).length,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'success',
            sessionData
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving session details',
            requestId,
            sessionId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
};

/**
 * Retrieves logs of agent communication for a specific session
 *
 * @async
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>} - Resolves when the response is sent
 */
exports.getSessionCommunicationLogs = async (req, res, next) => {
    const requestId = req.id || uuidv4();
    const { sessionId } = req.params;

    logger.info({
        message: 'Session communication logs requested',
        requestId,
        sessionId,
        endpoint: `/api/orchestrate/session/${sessionId}/communication`,
        timestamp: new Date().toISOString()
    });

    try {
        const sessionExists = await sharedWorkspace.sessionExists(sessionId);

        if (!sessionExists) {
            logger.warn({
                message: 'Session not found for communication logs',
                requestId,
                sessionId,
                timestamp: new Date().toISOString()
            });

            return res.status(404).json({
                status: 'error',
                message: 'Session not found'
            });
        }

        const communicationLogs = await messageBroker.getSessionMessages(sessionId);

        logger.info({
            message: 'Session communication logs retrieved',
            requestId,
            sessionId,
            messageCount: communicationLogs.length,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'success',
            communicationLogs
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving session communication logs',
            requestId,
            sessionId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
};

/**
 * Enables debugging mode for a specific session, which increases log verbosity
 * and stores additional debugging information
 *
 * @async
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>} - Resolves when the response is sent
 */
exports.setSessionDebugMode = async (req, res, next) => {
    const requestId = req.id || uuidv4();
    const { sessionId } = req.params;
    const { enabled = true } = req.body;

    logger.info({
        message: 'Session debug mode update requested',
        requestId,
        sessionId,
        debugModeEnabled: enabled,
        endpoint: `/api/orchestrate/session/${sessionId}/debug`,
        timestamp: new Date().toISOString()
    });

    try {
        const sessionExists = await sharedWorkspace.sessionExists(sessionId);

        if (!sessionExists) {
            logger.warn({
                message: 'Session not found for debug mode update',
                requestId,
                sessionId,
                timestamp: new Date().toISOString()
            });

            return res.status(404).json({
                status: 'error',
                message: 'Session not found'
            });
        }

        await sharedWorkspace.setSessionDebugMode(sessionId, enabled);

        logger.info({
            message: 'Session debug mode updated',
            requestId,
            sessionId,
            debugModeEnabled: enabled,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'success',
            sessionId,
            debugModeEnabled: enabled
        });
    } catch (error) {
        logger.error({
            message: 'Error updating session debug mode',
            requestId,
            sessionId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
};

/**
 * Gets the configuration and capabilities of the MAESTRO system
 *
 * @async
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>} - Resolves when the response is sent
 */
exports.getSystemCapabilities = async (req, res, next) => {
    const requestId = req.id || uuidv4();

    logger.info({
        message: 'System capabilities requested',
        requestId,
        endpoint: '/api/orchestrate/capabilities',
        timestamp: new Date().toISOString()
    });

    try {
        // Get available agents
        const availableAgents = await agentManager.getAvailableAgents();

        // Get supported workflow patterns
        const workflowPatterns = workflowEngine.getSupportedWorkflowPatterns();

        // Get system capabilities
        const capabilities = {
            agents: availableAgents,
            workflowPatterns,
            maxSubtasks: taskDecomposer.getMaxSubtasks(),
            supportedModels: await llamaService.getSupportedModels(),
            version: '1.0.0'
        };

        logger.info({
            message: 'System capabilities retrieved',
            requestId,
            agentCount: availableAgents.length,
            workflowPatternCount: workflowPatterns.length,
            supportedModelCount: capabilities.supportedModels.length,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'success',
            capabilities
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving system capabilities',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
};

/**
 * Sends a direct message to a specific agent for testing or debugging purposes
 *
 * @async
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>} - Resolves when the response is sent
 */
exports.sendDirectAgentMessage = async (req, res, next) => {
    const requestId = req.id || uuidv4();
    const { agentId } = req.params;
    const { message, options = {} } = req.body;

    logger.info({
        message: 'Direct agent message requested',
        requestId,
        agentId,
        messageLength: message ? message.length : 0,
        options,
        endpoint: `/api/orchestrate/agent/${agentId}/message`,
        timestamp: new Date().toISOString()
    });

    try {
        // Check if agent exists
        const agentExists = await agentManager.agentExists(agentId);

        if (!agentExists) {
            logger.warn({
                message: 'Agent not found for direct message',
                requestId,
                agentId,
                timestamp: new Date().toISOString()
            });

            return res.status(404).json({
                status: 'error',
                message: `Agent '${agentId}' not found`
            });
        }

        // Get agent instance
        const agent = await agentManager.getAgent(agentId);

        // Create a temporary session for direct communication
        const sessionId = uuidv4();
        await sharedWorkspace.initializeSession(sessionId, {
            directAgentCommunication: true,
            requestId,
            options
        });

        logger.info({
            message: 'Temporary session created for direct agent communication',
            requestId,
            sessionId,
            agentId,
            timestamp: new Date().toISOString()
        });

        // Create agent message
        const agentMessage = {
            messageId: uuidv4(),
            sessionId,
            senderId: 'user',
            recipientId: agentId,
            messageType: 'direct',
            content: message,
            timestamp: new Date().toISOString()
        };

        // Send message to agent through message broker
        await messageBroker.sendMessage(agentMessage);

        logger.info({
            message: 'Message sent to agent',
            requestId,
            sessionId,
            messageId: agentMessage.messageId,
            agentId,
            timestamp: new Date().toISOString()
        });

        // Process message with agent
        const response = await agent.processDirectMessage(agentMessage);

        logger.info({
            message: 'Agent response received',
            requestId,
            sessionId,
            agentId,
            responseLength: response.content ? response.content.length : 0,
            processingTime: response.processingTime,
            timestamp: new Date().toISOString()
        });

        // Clean up temporary session
        setTimeout(async () => {
            try {
                await sharedWorkspace.cleanupSession(sessionId);

                logger.info({
                    message: 'Temporary session cleaned up',
                    requestId,
                    sessionId,
                    timestamp: new Date().toISOString()
                });
            } catch (cleanupError) {
                logger.error({
                    message: 'Error cleaning up temporary session',
                    requestId,
                    sessionId,
                    error: cleanupError.message,
                    timestamp: new Date().toISOString()
                });
            }
        }, 5000);

        res.json({
            status: 'success',
            agentId,
            response
        });
    } catch (error) {
        logger.error({
            message: 'Error sending direct message to agent',
            requestId,
            agentId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
};

/**
 * Gets the current status and metrics of the orchestration system
 *
 * @async
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>} - Resolves when the response is sent
 */
exports.getOrchestrationStatus = async (req, res, next) => {
    const requestId = req.id || uuidv4();

    logger.info({
        message: 'Orchestration status requested',
        requestId,
        endpoint: '/api/orchestrate/status',
        timestamp: new Date().toISOString()
    });

    try {
        // Get active sessions
        const activeSessions = await sharedWorkspace.getActiveSessions();

        // Get agent status
        const agentStatus = await agentManager.getAgentStatus();

        // Get queue status
        const queueStatus = queueService.getStatus();

        // Get workflow engine status
        const workflowStatus = workflowEngine.getStatus();

        // Compile status
        const status = {
            activeSessions: activeSessions.length,
            agents: agentStatus,
            queue: queueStatus,
            workflow: workflowStatus,
            timestamp: new Date().toISOString()
        };

        logger.info({
            message: 'Orchestration status retrieved',
            requestId,
            activeSessions: status.activeSessions,
            activeAgents: Object.keys(agentStatus).filter(key => agentStatus[key].active).length,
            queueSize: queueStatus.size,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: 'success',
            orchestrationStatus: status
        });
    } catch (error) {
        logger.error({
            message: 'Error retrieving orchestration status',
            requestId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        next(error);
    }
};