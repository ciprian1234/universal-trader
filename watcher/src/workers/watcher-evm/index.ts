import { BaseWorker } from '../common/base-worker';
import type { EventMessage, RequestMessage } from '@/core/communication/types';

class EVMWorker extends BaseWorker {
  async handleRequest(message: RequestMessage) {
    this.sendResponseMessage({
      correlationId: message.correlationId,
      data: { success: true, timestamp: Date.now() },
    });
  }

  async handleEvent(event: EventMessage) {
    throw new Error(`EVMWorker does not handle events yet. Received event: ${event.name}`);
  }

  async init(config: any) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.sendEventMessage('worker-initialized', { timestamp: Date.now() });
  }
}

new EVMWorker();
