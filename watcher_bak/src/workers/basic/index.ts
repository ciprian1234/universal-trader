import { createLogger } from '@/utils';
import type { EventMessage, Message, RequestMessage } from '@/core/communication/types';
import type { BunMessageEvent } from 'bun';

// Each worker has its own isolated scope. (`self` refers to the worker's global scope)
declare const self: Worker;

let WORKER_ID = 'unnamed-worker';
const logger = createLogger(`[${WORKER_ID}]`);
let isPaused = false;
let isInitialized = false;
let isConfigured = false;

/**
 * Helper to send ResponseMessage to main thread
 */
function sendResponseToMain(message: {
  correlationId: string;
  data?: unknown;
  error?: unknown;
}): void {
  self.postMessage({ type: 'response', ...message });
}

/**
 * Listen for messages FROM main thread
 */
self.onmessage = (msg: BunMessageEvent<Message>) => {
  const message = msg.data; // the actual message its inside BunMessageEvent.data
  if (message.type === 'request') handleRequestMessage(message as RequestMessage);
  else if (message.type === 'event') handleEventMessage(message as EventMessage);
  else logger.warn(`Unknown message type: ${message.type}`);
};

/**
 * Handle incoming RequestMessage commands from main thread
 */
function handleRequestMessage(message: RequestMessage): void {
  const { name, data, correlationId } = message;
  if (!isConfigured && name !== 'config') {
    logger.warn(`Worker not initialized. Ignoring command: ${name}`);
    sendResponseToMain({ correlationId, error: { message: `Worker not configured` } });
  } else if (name == 'config') {
    logger.info('Configured worker with payload:', data);
    sendResponseToMain({ correlationId, data: { success: true } });
    isConfigured = true;
  } else if (name == 'init') {
    sendResponseToMain({ correlationId, data: { success: true } });
  } else logger.warn(`Unknown command: ${name}`);
}

/**
 * Handle incoming EventMessage from main thread
 */
function handleEventMessage(event: EventMessage): void {
  const { name, data } = event;
  logger.info(`Received event: ${name}`, data);
  // Handle any events from main thread if needed
}
