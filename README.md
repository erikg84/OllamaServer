# OllamaServer
LLM Orchestration System
Project Overview
An advanced LLM orchestration system designed to coordinate multiple language models running locally and on remote machines. The system intelligently distributes tasks across CPU and GPU resources, optimizing performance through parallel execution.
Architecture
Components

Node Server (Express.js)

Interfaces with local Ollama API
Manages local request queuing
Provides standardized REST endpoints
Collects performance metrics
Handles errors and logging


Backend Service (Kotlin/Vert.x)

Central coordinator for the system
Maintains inventory of nodes and capabilities
Implements intelligent load balancing
Provides centralized queuing


Frontend Application

User interface for system interaction
Displays system status
Offers administrative controls



Enhancements
Completed

✅ Memory Management

MemoryManager.js: Monitors system memory and manages request memory allocation
memory-manager-middleware.js: Express middleware for memory-based request filtering



In Progress

🔄 Caching Layer

Implements LRU caching system for frequently used prompts
Manages TTL for cached entries
Provides metrics on cache performance



Planned

⏳ Circuit Breaking

Monitors API call failures and error rates
Automatically opens/closes circuit based on error thresholds
Implements cooldown periods for recovery


⏳ Request Prioritization

Extends queue implementation with priority levels
Allows higher priority tasks to be processed first
Prevents starvation of low-priority tasks


⏳ GPU Metrics

Monitors GPU utilization and memory
Tracks per-model GPU performance metrics
Provides GPU-aware recommendations for concurrency


⏳ Auto-restart Capability

Monitors Ollama service health
Detects hung or degraded instances
Manages automated restart procedures


⏳ Request Timeouts

Manages per-model timeout settings
Enforces timeout policies for requests
Tracks timeout statistics for models



Current Implementation
The system currently includes:

Robust request queue management with adaptive concurrency
Comprehensive memory management system
Performance monitoring and metrics collection
Detailed logging with MongoDB integration
Health monitoring and administrative endpoints

Usage
[Usage instructions will be added here]
Configuration
[Configuration details will be added here]
API Endpoints
[API documentation will be added here]
Contributing
[Contribution guidelines will be added here]
License
[License information will be added here]