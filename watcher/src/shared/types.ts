// // Commands sent FROM main thread TO workers
// export type WorkerCommand =
//   | { type: 'start'; config?: Record<string, unknown> }
//   | { type: 'stop' }
//   | { type: 'pause' }
//   | { type: 'resume' }
//   | { type: 'config'; payload: Record<string, unknown> };

// // Messages sent FROM workers TO main thread
// export type WorkerMessage =
//   | { type: 'status'; workerId: string; status: 'running' | 'paused' | 'stopped' | 'error' }
//   | { type: 'data'; workerId: string; payload: unknown; timestamp: number }
//   | { type: 'error'; workerId: string; error: string; timestamp: number }
//   | { type: 'ready'; workerId: string };

// export const MSG = {
//   // Watcher → Orchestrator
//   WATCHER_READY: 'watcher:ready',
//   WATCHER_ERROR: 'watcher:error',
//   BLOCK_UPDATE: 'watcher:block',
//   POOL_BATCH_UPDATE: 'watcher:pool-batch',
//   POOL_UPDATE: 'watcher:pool-update',
//   POOL_EVENTS: 'watcher:pool-events',
//   OPPORTUNITY_FOUND: 'watcher:opportunity',
//   HEALTH_STATUS: 'watcher:health',

//   // Orchestrator → Watcher
//   CMD_PAUSE: 'cmd:pause',
//   CMD_RESUME: 'cmd:resume',
//   CMD_FETCH_POOL: 'cmd:fetch-pool',
//   CMD_FETCH_ALL: 'cmd:fetch-all',
//   CMD_ADD_POOL: 'cmd:add-pool',
//   CMD_REMOVE_POOL: 'cmd:remove-pool',
//   CMD_UPDATE_CONFIG: 'cmd:update-config',

//   // Orchestrator → Executor
//   EXECUTE_OPPORTUNITY: 'exec:opportunity',
//   CANCEL_EXECUTION: 'exec:cancel',

//   // Executor → Orchestrator
//   EXECUTOR_READY: 'exec:ready',
//   EXECUTION_RESULT: 'exec:result',
//   EXECUTION_ERROR: 'exec:error',
// } as const;

// // Every message (both directions) carries a correlationId
// export interface RequestMessage {
//   id: string;
//   type: 'command';
//   command: string;
//   payload?: unknown;
// }

// export interface ResponseMessage {
//   id: string;
//   type: 'response';
//   success: boolean;
//   data?: unknown;
//   error?: string;
// }

// // Workers can also emit unsolicited events (no correlationId needed)
// export interface WorkerEvent {
//   type: 'event';
//   eventName: string;
//   payload: unknown;
//   timestamp: number;
// }
