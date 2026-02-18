// ================================================================================================
// UNIVERSAL TRADER — Entry Point
//
// Multi-chain DEX arbitrage orchestrator.
// Main thread owns GlobalDataStore, ApiServer, Cross-chain detector, EventBus.
// Spawns Bun workers for each chain (I/O only).
//
// Usage:
//   ENABLED_CHAINS=1,42161 ETH_MAINNET_RPC=wss://... bun run index.ts
// ================================================================================================

import path from 'path';
import { resolveConfig, getChainRpcUrl } from './config/index.ts';
import { EventBus } from './core/event-bus.ts';
import { WorkerManager } from './core/communication/worker-manager.ts';
// import { CrossChainDetector } from './orchestrator/cross-chain-detector.ts';
import { startApiServer, broadcastEvent } from './api-server/index..ts';
import { createLogger } from './utils';
import { GlobalDataStore } from './core/global-data-store.ts';

const log = createLogger('[Main]');

async function main(): Promise<void> {
  // === 1. Load config ===
  const config = resolveConfig();
  log.info(`Enabled chains: ${config.enabledChainIds.join(', ')}`);

  // === 2. Create core components (all on main thread) ===
  const store = new GlobalDataStore();
  const eventBus = new EventBus();
  const workerManager = new WorkerManager();
  // const crossChainDetector = new CrossChainDetector(store, {
  //   minSpreadBps: 20,
  //   estimatedCostBps: 10,
  //   scanIntervalMs: 2000,
  //   freshnessMs: 30_000,
  // });

  // === 3. Start API Server ===
  const { server } = startApiServer(config.adminPort, {
    store,
    workerManager,
    // crossChainDetector,
  });

  workerManager.spawnWorker('basic', path.resolve(__dirname, './workers/basic/index.ts'));

  // === 5. Wire up EventBus → WebSocket broadcast ===
  // eventBus.on('pool-update', (pool) => {
  //   broadcastEvent('pool-update', {
  //     address: pool.address,
  //     chainId: pool.chainId,
  //     dexName: pool.dexName,
  //   });
  // });

  // eventBus.on('newBlock', (block) => {
  //   broadcastEvent('new-block', block);
  // });

  // eventBus.on('arbitrage-opportunity', (opp) => {
  //   broadcastEvent('arbitrage-opportunity', opp);
  //   log.info(`💰 Opportunity: ${opp.profitUSD.toFixed(2)} USD on chain ${opp.chainId}`);
  // });

  // === 6. Wire up cross-chain detector ===
  // crossChainDetector.onDetect((opp) => {
  //   broadcastEvent('cross-chain-opportunity', opp);
  //   log.info(
  //     `🌐 Cross-chain: ${opp.pair} buy@${opp.buyChain} sell@${opp.sellChain} spread=${opp.spreadBps.toFixed(1)}bps`,
  //   );
  // });

  // === 7. Wire up PoolStateStore → EventBus ===
  // store.onChange((pool, changeType) => {
  //   if (changeType === 'update') {
  //     eventBus.emit('pool-update', pool);
  //   }
  // });

  // === 8. Spawn watcher workers ===
  // for (const chainConfig of Object.values(config.chains)) {
  //   const rpcUrl = getChainRpcUrl(chainConfig);
  //   const pools = workerManager.getRegisteredPools(chainConfig.chainId);

  //   log.info(`Spawning watcher for ${chainConfig.chainName}...`);
  //   workerManager.spawnWatcher(chainConfig, rpcUrl, pools);
  // }

  // === 9. Start cross-chain detector (after workers are up) ===
  // Delay slightly so workers have time to fetch initial states
  // setTimeout(() => {
  //   // crossChainDetector.start();
  //   log.info('🌐 Cross-chain detector started');
  // }, 10_000);

  // ── 10. Signal handling ──
  const shutdown = async () => {
    log.info('Shutting down...');
    // crossChainDetector.stop();
    // workerManager.stopAll();
    server.stop();
    log.info('Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // log.info('═══════════════════════════════════════════════');
  // log.info('   Universal Trader — Running');
  // log.info(`   Admin API: http://localhost:${config.adminPort}`);
  // log.info(`   Chains: ${config.enabledChainIds.join(', ')}`);
  // log.info(`   Pools: ${store.size}`);
  // log.info('═══════════════════════════════════════════════');
}

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
