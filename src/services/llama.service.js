// src/services/llama.service.js
const axios = require('axios');
const logger = require('../logging/logger');
const { serverConfig } = require('../config');

// Llama API base URL
const LLAMA_BASE_URL = serverConfig.llamaApiUrl;

class LlamaService {
    async getTags() {
        try {
            logger.info({
                message: 'Making health check API call',
                endpoint: `${LLAMA_BASE_URL}/tags`,
                method: 'GET',
                timestamp: new Date().toISOString()
            });

            const response = await axios.get(`${LLAMA_BASE_URL}/tags`);

            logger.info({
                message: 'Health check API call successful',
                statusCode: response.status,
                responseSize: JSON.stringify(response.data).length,
                timestamp: new Date().toISOString()
            });

            return response;
        } catch (error) {
            logger.error({
                message: 'Health check API call failed',
                error: error.message,
                errorCode: error.code,
                errorResponse: error.response ? {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                } : 'No response',
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async generate(params) {
        try {
            logger.info({
                message: 'Making generate API call',
                endpoint: `${LLAMA_BASE_URL}/generate`,
                method: 'POST',
                model: params.model,
                timestamp: new Date().toISOString()
            });

            const response = await axios.post(`${LLAMA_BASE_URL}/generate`, params);

            logger.info({
                message: 'Generate API call successful',
                statusCode: response.status,
                responseSize: JSON.stringify(response.data).length,
                timestamp: new Date().toISOString()
            });

            return response;
        } catch (error) {
            logger.error({
                message: 'Generate API call failed',
                error: error.message,
                errorCode: error.code,
                errorResponse: error.response ? {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                } : 'No response',
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async chat(params) {
        try {
            logger.info({
                message: 'Making chat API call',
                endpoint: `${LLAMA_BASE_URL}/chat`,
                method: 'POST',
                model: params.model,
                timestamp: new Date().toISOString()
            });

            const response = await axios.post(`${LLAMA_BASE_URL}/chat`, params);

            logger.info({
                message: 'Chat API call successful',
                statusCode: response.status,
                responseSize: JSON.stringify(response.data).length,
                timestamp: new Date().toISOString()
            });

            return response;
        } catch (error) {
            logger.error({
                message: 'Chat API call failed',
                error: error.message,
                errorCode: error.code,
                errorResponse: error.response ? {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                } : 'No response',
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }
}

module.exports = {
    llamaService: new LlamaService()
};