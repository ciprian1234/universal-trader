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
import { appConfig } from './config/index.ts';
import { EventBus } from './core/event-bus.ts';
import { WorkerManager } from './core/communication/worker-manager.ts';
import { startApiServer } from './api-server/index..ts';
import { GlobalDataStore } from './core/global-data-store.ts';
import { logger } from './utils/index.ts';

async function main(): Promise<void> {
  const store = new GlobalDataStore();
  const eventBus = new EventBus();
  const workerManager = new WorkerManager({ eventBus });

  // === 3. Start API Server ===
  const { server } = startApiServer(appConfig.apiServerPort, {
    store,
    workerManager,
    // crossChainDetector,
  });

  // go through each enabled platform and spawn corresponding workers
  for (const [_, platformConfig] of Object.entries(appConfig.platforms)) {
    if (!platformConfig.enabled) continue;
    workerManager.spawnWorker(platformConfig.name, path.resolve(__dirname, './workers/watcher-evm/index.ts'));
    await workerManager.sendRequest(platformConfig.name, 'init', platformConfig);
    logger.info(`✅ Worker "${platformConfig.name}" (${platformConfig.name}) initialized`);
  }

  // === 5. Wire up EventBus → WebSocket broadcast ===
  // eventBus.onPoolStateUpdate('pool-update', (pool) => {
  //   broadcastEvent('pool-update', {
  //     address: pool.address,
  //     chainId: pool.chainId,
  //     dexName: pool.dexName,
  //   });
  // });

  // eventBus.onNewBlock('new-block', (block) => {
  //   broadcastEvent('new-block', block);
  // });

  // eventBus.onArbitrageOpportunity('arbitrage-opportunity', (opp) => {
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
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutting down...');
    // crossChainDetector.stop();
    await workerManager.terminateAll(); // Gracefully terminate all workers
    server.stop();
    logger.info('Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // log.info('═══════════════════════════════════════════════');
  // log.info('   Universal Trader — Running');
  // log.info(`   Admin API: http://localhost:${appConfig.apiServerPort}`);
  // log.info(`   Chains: ${appConfig.enabledPlatforms.join(', ')}`);
  // log.info(`   Pools: ${store.size}`);
  // log.info('═══════════════════════════════════════════════');
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
