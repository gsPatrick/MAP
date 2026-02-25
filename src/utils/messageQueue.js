const logger = require('./logger');

/**
 * Robust Message Queue for safe sending of WhatsApp messages.
 * Features:
 * - FIFO Queue
 * - Rate Limiting (min/max delay)
 * - Jitter (random variation)
 * - Retry Logic (for network errors)
 * - Concurrency Control (1 at a time)
 */
class MessageQueue {
    constructor(options = {}) {
        this.queue = [];
        this.isProcessing = false;
        this.options = {
            minDelayMs: options.minDelayMs || 500,  // Reduced to 0.5s for responsiveness
            maxDelayMs: options.maxDelayMs || 2500, // Reduced to 2.5s
            maxRetries: options.maxRetries || 3,
            ...options
        };
    }

    /**
     * Adds a task to the queue.
     * @param {Function} taskFunction - Async function to execute (e.g., () => axios.post(...))
     * @param {Object} context - Metadata for logging (e.g., { phone: '...', type: 'text' })
     */
    enqueue(taskFunction, context = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                task: taskFunction,
                context,
                resolve,
                reject,
                retries: 0
            });
            logger.info(`[MessageQueue] Task added. Queue size: ${this.queue.length}. Context: ${JSON.stringify(context)}`);
            this.processQueue();
        });
    }

    /**
     * Processes the queue sequentially.
     */
    async processQueue() {
        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const item = this.queue[0]; // Peek
            const { task, context, resolve, reject, retries } = item;

            try {
                // Calculate random delay (Jitter)
                const delay = Math.floor(Math.random() * (this.options.maxDelayMs - this.options.minDelayMs + 1)) + this.options.minDelayMs;
                logger.info(`[MessageQueue] Processing task for ${context.phone || 'unknown'}. Waiting ${delay}ms before sending...`);

                await new Promise(r => setTimeout(r, delay));

                const result = await task();

                logger.info(`[MessageQueue] Task completed successfully for ${context.phone || 'unknown'}.`);
                resolve(result);
                this.queue.shift(); // Remove from queue only after success

            } catch (error) {
                logger.error(`[MessageQueue] Error processing task for ${context.phone || 'unknown'}: ${error.message}`);

                if (retries < this.options.maxRetries) {
                    logger.warn(`[MessageQueue] Retrying task (${retries + 1}/${this.options.maxRetries})...`);
                    item.retries++;
                    // Wait a bit before retrying immediately? 
                    // For simplicity, we just loop back. The existing delay logic will apply to the retry or we can add extra backoff.
                    // Let's perform a small backoff for retries.
                    await new Promise(r => setTimeout(r, 5000));
                } else {
                    logger.error(`[MessageQueue] Max retries reached. Task failed permanently.`);
                    reject(error);
                    this.queue.shift(); // Remove failed task
                }
            }
        }

        this.isProcessing = false;
        logger.info('[MessageQueue] Queue drained. Idle.');
    }
}

// Singleton instance
const messageQueue = new MessageQueue();

module.exports = messageQueue;
