import type { EventMessage, Message, RequestMessage } from '@/core/communication/types';
import { createLogger } from '@/utils';
import type { BunMessageEvent } from 'bun';
import type { PlatformConfig } from '@/config/models.ts';

// Each worker has its own isolated scope. (`self` refers to the worker's global scope)
declare const self: Worker;

export abstract class BaseWorker {
  isInitialized = false;
  workerId = 'unidentified-worker';
  log = createLogger(`worker`);

  constructor() {
    // Listen for messages FROM the main thread
    self.onmessage = (msg: BunMessageEvent<Message>) => {
      const message = msg.data; // the actual message its inside BunMessageEvent.data
      if (message.type === 'request') this.handleRequestMessage(message as RequestMessage);
      else if (message.type === 'event') this.handleEventMessage(message as EventMessage);
      else this.log.warn(`Unknown message type: ${message.type}`);
    };
  }

  /**
   * Handle incoming RequestMessage commands from main thread
   */
  handleRequestMessage(message: RequestMessage): void {
    const { name, data, correlationId } = message;
    if (!this.isInitialized && name !== 'init') {
      this.log.warn(`Worker not initialized. Ignoring request: ${name}`);
      this.sendResponseMessage({ correlationId, error: { message: `Worker not initialized` } });
    } else if (name == 'init') {
      // base init logic (e.g. set worker name in context, setup logger)
      const config = data as PlatformConfig;
      if (!config.id) throw new Error(`Missing "id" from init config`);
      this.workerId = config.id;
      this.log = createLogger(`[${config.id}]`); // Update logger with worker name

      // call init from the concrete worker class
      this.init(data)
        .then(async () => {
          this.isInitialized = true;
          this.sendResponseMessage({ correlationId, data: { success: true } });
        })
        .catch((error) => {
          this.log.error(`init`, error);
          this.sendResponseMessage({ correlationId, error: { message: error.message } });
        });
    } else {
      // call the concrete worker's request handler
      this.handleRequest(message).catch((error) => {
        this.log.error(`handleRequest <${name}>:`, error);
        this.sendResponseMessage({ correlationId, error: { message: error.message } });
      });
    }
  }

  /**
   * Handle incoming EventMessage from main thread
   */
  handleEventMessage(event: EventMessage): void {
    this.handleEvent(event).catch((error) => {
      this.log.error(`handleEvent <${event.name}>:`, error);
    });
  }

  /**
   * Helper to send ResponseMessage to main thread
   */
  sendResponseMessage(message: { correlationId: string; data?: unknown; error?: unknown }): void {
    self.postMessage({ type: 'response', ...message });
  }

  /**
   * Helper to send EventMessage to main thread
   */
  sendEventMessage(name: string, data: unknown): void {
    self.postMessage({ type: 'event', name, data });
  }

  // abstract methods that concrete workers must implement
  abstract handleRequest(message: RequestMessage): Promise<void>;
  abstract handleEvent(event: EventMessage): Promise<void>;
  abstract init(config: unknown): Promise<void>;
}
