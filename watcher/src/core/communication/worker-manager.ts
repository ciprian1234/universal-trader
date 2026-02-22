// import { globalStore } from './global-store';
import type { BunMessageEvent } from 'bun';
import { createLogger } from '../../utils/logger.ts';
import type { EventMessage, Message, RequestMessage, ResponseMessage } from './types.ts';
import { broadcastEventToWebsocketClients } from '@/api-server/index..ts';

const logger = createLogger('[main.WorkerManager]');

let requestIdCounter = 0;

interface ManagedWorker {
  id: string;
  worker: Worker;
  scriptPath: string;
}

export class WorkerManager {
  private workers: Map<string, ManagedWorker> = new Map();
  private pendingRequests: Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  DEFAULT_TIMEOUT_MS = 10_000;

  constructor() {}

  /**
   * Spawn a new worker from a script file
   */
  spawnWorker(id: string, scriptPath: string): void {
    if (this.workers.has(id)) {
      return logger.error(`Worker "${id}" already exists. Terminate it first.`);
    }

    const worker = new Worker(scriptPath, { name: id });

    // Listen for messages FROM the worker
    worker.onmessage = (msg: BunMessageEvent<Message>) => {
      const message = msg.data; // actual message sent by the worker
      if (message.type === 'response') this.handleResponse(message as ResponseMessage);
      else if (message.type === 'event') this.handleEvent(message as EventMessage);
      else logger.warn(`Unknown message type from worker "${id}":`, message);
    };

    // Listen for errors
    worker.onerror = (event) => {
      logger.error(`Error in worker "${id}":`, event);
      // Reject ALL pending requests for this worker
      for (const [correlationId, pending] of this.pendingRequests) {
        if (correlationId.startsWith(`${id}-`)) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Worker "${id}" error: ${event.message}`));
          this.pendingRequests.delete(correlationId);
        }
      }
    };

    this.workers.set(id, { id, worker, scriptPath });
    logger.info(`Spawned worker "${id}" from ${scriptPath}`);
  }

  /**
   * Send a request to a specific worker and wait for the response
   * Returns a Promise that resolves with the response data or rejects on error/timeout
   */
  sendRequest<T = unknown>(workerId: string, requestName: string, requestData: any): Promise<T> {
    const managed = this.workers.get(workerId);
    if (!managed) throw new Error(`Worker "${workerId}" not found`);
    const correlationId = `${workerId}-${requestIdCounter++}`;

    // logger.info(`Sending request "${requestName}" to workerId: "${workerId}"`);

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        const errorMsg = `Request "${requestName}" to worker "${workerId}" timed out after ${this.DEFAULT_TIMEOUT_MS}ms`;
        reject(new Error(errorMsg));
      }, this.DEFAULT_TIMEOUT_MS);

      // Store the pending request
      this.pendingRequests.set(correlationId, { resolve, reject, timer });

      // Send the request to the worker
      const request: RequestMessage = {
        correlationId,
        type: 'request',
        name: requestName,
        data: requestData,
      };
      managed.worker.postMessage(request);
    });
  }

  // /**
  //  * Broadcast a command to ALL workers
  //  */
  broadcast(data: any): void {
    for (const [id] of this.workers) {
      this.sendRequest(id, data.name, data.data);
    }
  }

  private handleResponse(message: ResponseMessage): void {
    const pending = this.pendingRequests.get(message.correlationId);
    if (!pending) return logger.warn(`No pending request for correlationId: ${message.correlationId}`);

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.correlationId);

    if (message.error) pending.reject(message.error);
    else pending.resolve(message.data);
  }

  private handleEvent(message: EventMessage): void {
    // hook here GlobalDataStore and broadcast to WebSocket clients
    // broadcastEventToWebsocketClients(message.name, message.data);
    // for (const handler of this.eventHandlers) {
    //   handler(message);
    // }
  }

  /**
   * Terminate a specific worker
   */
  async terminateWorker(workerId: string): Promise<void> {
    const managed = this.workers.get(workerId);
    if (!managed) return logger.warn(`Worker "${workerId}" not found for termination`);

    // clear pending requests for this worker
    for (const [correlationId, pending] of this.pendingRequests) {
      if (correlationId.startsWith(`${workerId}-`)) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Worker "${workerId}" terminated`));
        this.pendingRequests.delete(correlationId);
      }
    }

    // send stop command to allow graceful cleanup in the worker
    await this.sendRequest(workerId, 'stop', null);
    managed.worker.terminate(); // Terminate the worker
    this.workers.delete(workerId);
    logger.info(`Terminated worker "${workerId}"`);
  }

  /**
   * Terminate all workers
   */
  async terminateAll(): Promise<void> {
    for (const [id] of this.workers) await this.terminateWorker(id);
  }

  getWorkerIds(): string[] {
    return [...this.workers.keys()];
  }

  /**
   * Listen for unsolicited events from the worker
   */
  // onEvent(handler: (event: WorkerEvent) => void): () => void {
  //   this.eventHandlers.push(handler);
  //   return () => {
  //     this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
  //   };
  // }
}
