// ================================================================================================
// ADMIN SERVER — REST API + WebSocket for runtime control
//
// Uses Hono (lightweight, native Bun support) instead of Express.
// Reads pool state directly from PoolStateStore (same JS objects, zero overhead).
// Sends commands to workers via WorkerManager.
// ================================================================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from '../utils/logger.ts';
import { bigIntReplacer } from '../utils/serialization.ts';
import type { GlobalDataStore } from '@/core/global-data-store.ts';
import type { WorkerManager } from '../core/communication/worker-manager.ts';
// import type { CrossChainDetector } from '../../orchestrator/cross-chain-detector.ts';

const log = createLogger('[main.server]');

interface ApiServerInput {
  store: GlobalDataStore;
  workerManager: WorkerManager;
  // crossChainDetector: CrossChainDetector;
}

// Connected WebSocket clients
const wsClients = new Set<any>();

/** Broadcast to all connected WebSocket clients */
export function broadcastEventToWebsocketClients(event: string, data: unknown): void {
  const msg = JSON.stringify({ type: 'event', event, data, timestamp: Date.now() }, bigIntReplacer);
  for (const ws of wsClients) {
    try {
      ws.send(msg);
    } catch {
      wsClients.delete(ws);
    }
  }
}

// Global pause state
let paused = false;

export function isPaused(): boolean {
  return paused;
}

export function createApiServer(input: ApiServerInput): Hono {
  const { store, workerManager } = input;
  const app = new Hono();

  app.use('*', cors());

  // ── Helper: JSON with BigInt support ──
  const json = (c: any, data: unknown, status = 200) => {
    return c.json(JSON.parse(JSON.stringify(data, bigIntReplacer)), status);
  };

  // ════════════════════════════════════════════════════════════
  // HEALTH
  // ════════════════════════════════════════════════════════════

  app.get('/health', (c) =>
    json(c, {
      status: 'ok',
      paused,
      uptime: process.uptime(),
      // poolCount: store.size,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    }),
  );

  // ════════════════════════════════════════════════════════════
  // HEALTH
  // ════════════════════════════════════════════════════════════
  app.get('/playground', async (c) => {
    try {
      const response = await workerManager.sendRequest('worker-eth', 'pause', null);
      return c.json({ response });
    } catch (error: any) {
      log.error('Error sending request to worker:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // ════════════════════════════════════════════════════════════
  // CONTROL (pause / resume / status)
  // ════════════════════════════════════════════════════════════

  app.post('/control/pause', (c) => {
    paused = true;
    workerManager.pauseAll();
    broadcastEvent('status', { paused: true });
    log.info('⏸️  Arbitrage PAUSED');
    return json(c, { paused: true });
  });

  app.post('/control/resume', (c) => {
    paused = false;
    workerManager.resumeAll();
    broadcastEvent('status', { paused: false });
    log.info('▶️  Arbitrage RESUMED');
    return json(c, { paused: false });
  });

  app.get('/control/status', (c) =>
    json(c, {
      paused,
      workers: workerManager.getStatus(),
      // store: store.getStats(),
    }),
  );

  // ════════════════════════════════════════════════════════════
  // POOLS — reads directly from PoolStateStore (instant, sync)
  // ════════════════════════════════════════════════════════════

  // app.get('/pools', (c) => {
  //   const chainId = c.req.query('chainId');
  //   const dex = c.req.query('dex');
  //   const symbol = c.req.query('symbol');

  //   let pools = chainId ? store.getByChain(parseInt(chainId, 10)) : store.getActive();

  //   if (dex) {
  //     pools = pools.filter((p) => p.dexName === dex);
  //   }

  //   if (symbol) {
  //     const sym = symbol.toUpperCase();
  //     pools = pools.filter(
  //       (p) => p.tokenPair.token0.symbol === sym || p.tokenPair.token1.symbol === sym,
  //     );
  //   }

  //   // Return lightweight summaries, not full tick data
  //   const summaries = pools.map((p) => ({
  //     address: p.address,
  //     chainId: p.chainId,
  //     dexName: p.dexName,
  //     dexType: p.dexType,
  //     token0: p.tokenPair.token0.symbol,
  //     token1: p.tokenPair.token1.symbol,
  //     fee: p.fee,
  //     liquidityUSD: p.totalLiquidityUSD,
  //     disabled: p.disabled,
  //     lastUpdatedBlock: p.lastUpdatedBlock,
  //     ageMs: Date.now() - p.lastUpdatedAt,
  //     // Include type-specific data
  //     ...('reserve0' in p
  //       ? { reserve0: p.reserve0.toString(), reserve1: p.reserve1.toString() }
  //       : {}),
  //     ...('sqrtPriceX96' in p
  //       ? {
  //           sqrtPriceX96: p.sqrtPriceX96.toString(),
  //           tick: p.tick,
  //           liquidity: p.liquidity.toString(),
  //         }
  //       : {}),
  //     ...('spotPrice0to1' in p
  //       ? { spotPrice0to1: p.spotPrice0to1, spotPrice1to0: p.spotPrice1to0 }
  //       : {}),
  //   }));

  //   return json(c, { count: summaries.length, pools: summaries });
  // });

  app.get('/pools/:address', (c) => {
    // const pool = store.get(c.req.param('address'));
    const pool = null;
    if (!pool) return c.json({ error: 'Pool not found' }, 404);
    return json(c, pool);
  });

  app.post('/pools/:address/disable', (c) => {
    const addr = c.req.param('address');
    // if (!store.setDisabled(addr, true)) return c.json({ error: 'Pool not found' }, 404);
    log.info(`🚫 Pool ${addr} DISABLED`);
    return json(c, { disabled: true, address: addr });
  });

  app.post('/pools/:address/enable', (c) => {
    const addr = c.req.param('address');
    // if (!store.setDisabled(addr, false)) return c.json({ error: 'Pool not found' }, 404);
    log.info(`✅ Pool ${addr} ENABLED`);
    return json(c, { disabled: false, address: addr });
  });

  // app.post('/pools/:address/refresh', (c) => {
  //   const addr = c.req.param('address');
  //   const pool = store.get(addr);
  //   if (!pool) return c.json({ error: 'Pool not found' }, 404);

  //   workerManager.sendToWatcher(pool.chainId, MSG.CMD_FETCH_POOL, {
  //     address: pool.address,
  //     dexType: pool.dexType,
  //     fetchTicks: pool.dexType === 'uniswap-v3',
  //   });

  //   return json(c, { refreshing: true, address: addr });
  // });

  // ════════════════════════════════════════════════════════════
  // TOKENS / PRICES
  // ════════════════════════════════════════════════════════════

  app.get('/prices/:symbol', (c) => {
    const symbol = c.req.param('symbol').toUpperCase();
    // const prices = store.getBestPrices(symbol);
    const prices = 0;
    return json(c, { symbol, prices });
  });

  // ════════════════════════════════════════════════════════════
  // WORKERS
  // ════════════════════════════════════════════════════════════

  app.get('/workers', (c) => json(c, workerManager.getStatus()));

  app.post('/workers/:chainId/refresh', (c) => {
    const chainId = parseInt(c.req.param('chainId'), 10);
    workerManager.refreshChain(chainId);
    return json(c, { refreshing: true, chainId });
  });

  // ════════════════════════════════════════════════════════════
  // CROSS-CHAIN
  // ════════════════════════════════════════════════════════════

  // app.get('/cross-chain', (c) => json(c, crossChainDetector.getStatus()));

  // ════════════════════════════════════════════════════════════
  // SYSTEM
  // ════════════════════════════════════════════════════════════

  app.get('/system/memory', (c) => {
    const mem = process.memoryUsage();
    return json(c, {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
    });
  });

  // app.get('/system/store-stats', (c) => json(c, store.getStats()));

  return app;
}

// ════════════════════════════════════════════════════════════════
// START API SERVER (Bun native HTTP + WebSocket)
// ════════════════════════════════════════════════════════════════

export function startApiServer(
  port: number,
  deps: ApiServerInput,
): { server: ReturnType<typeof Bun.serve>; app: Hono } {
  const app = createApiServer(deps);

  const server = Bun.serve({
    port,
    fetch(req, server) {
      // Upgrade WebSocket connections
      if (req.headers.get('upgrade') === 'websocket') {
        const success = server.upgrade(req);
        if (success) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // Handle HTTP with Hono
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        log.info('🔌 Admin WS client connected');

        // Send current status on connect
        ws.send(
          JSON.stringify(
            {
              type: 'snapshot',
              paused,
              // poolCount: deps.store.size,
              workers: deps.workerManager.getStatus(),
            },
            bigIntReplacer,
          ),
        );
      },
      message(_ws, _message) {
        // Could handle client commands here if needed
      },
      close(ws) {
        wsClients.delete(ws);
        log.info('🔌 Admin WS client disconnected');
      },
    },
  });

  log.info(`🖥️  Admin API on http://localhost:${port}`);
  log.info(`🔌 Admin WS on ws://localhost:${port}`);

  return { server, app };
}
