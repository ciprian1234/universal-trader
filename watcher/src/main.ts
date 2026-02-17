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

import { resolveConfig, getChainRpcUrl } from './config/index.ts';
import { PoolStateStore } from './shared/pool-state-store.ts';
import { EventBus } from './core/event-bus.ts';
import { WorkerManager, type PoolRegistration } from './orchestrator/worker-manager.ts';
import { CrossChainDetector } from './orchestrator/cross-chain-detector.ts';
import { startApiServer, broadcastEvent } from './api-server';
import { createLogger } from './utils/logger.ts';

const log = createLogger('[Main]');

async function main(): Promise<void> {
  log.info('═══════════════════════════════════════════════');
  log.info('   Universal Trader — Starting');
  log.info('═══════════════════════════════════════════════');

  // ── 1. Load config ──
  const config = resolveConfig();
  log.info(`Enabled chains: ${config.enabledChainIds.join(', ')}`);

  // ── 2. Create core components (all on main thread) ──
  const store = new PoolStateStore();
  const eventBus = new EventBus();
  const workerManager = new WorkerManager({ store, eventBus });
  const crossChainDetector = new CrossChainDetector(store, {
    minSpreadBps: 20,
    estimatedCostBps: 10,
    scanIntervalMs: 2000,
    freshnessMs: 30_000,
  });

  // ── 3. Build pool registry from chain configs ──
  // For each chain, create pool registrations from its DEX configs.
  // In production, you'd discover pools from factory contracts or a database.
  // For now, we register common pairs for each DEX.
  for (const chainConfig of Object.values(config.chains)) {
    const pools = buildPoolRegistrations(chainConfig);
    workerManager.registerPools(pools);
    log.info(`  Chain ${chainConfig.chainName}: ${pools.length} pools registered`);
  }

  // ── 4. Start Admin API ──
  const { server } = startAdminServer(config.adminPort, {
    store,
    workerManager,
    crossChainDetector,
  });

  // ── 5. Wire up EventBus → WebSocket broadcast ──
  eventBus.on('pool-update', (pool) => {
    broadcastEvent('pool-update', {
      address: pool.address,
      chainId: pool.chainId,
      dexName: pool.dexName,
    });
  });

  eventBus.on('newBlock', (block) => {
    broadcastEvent('new-block', block);
  });

  eventBus.on('arbitrage-opportunity', (opp) => {
    broadcastEvent('arbitrage-opportunity', opp);
    log.info(`💰 Opportunity: ${opp.profitUSD.toFixed(2)} USD on chain ${opp.chainId}`);
  });

  // ── 6. Wire up cross-chain detector ──
  crossChainDetector.onDetect((opp) => {
    broadcastEvent('cross-chain-opportunity', opp);
    log.info(`🌐 Cross-chain: ${opp.pair} buy@${opp.buyChain} sell@${opp.sellChain} spread=${opp.spreadBps.toFixed(1)}bps`);
  });

  // ── 7. Wire up PoolStateStore → EventBus ──
  store.onChange((pool, changeType) => {
    if (changeType === 'update') {
      eventBus.emit('pool-update', pool);
    }
  });

  // ── 8. Spawn watcher workers ──
  for (const chainConfig of Object.values(config.chains)) {
    const rpcUrl = getChainRpcUrl(chainConfig);
    const pools = workerManager.getRegisteredPools(chainConfig.chainId);

    log.info(`Spawning watcher for ${chainConfig.chainName}...`);
    workerManager.spawnWatcher(chainConfig, rpcUrl, pools);
  }

  // ── 9. Start cross-chain detector (after workers are up) ──
  // Delay slightly so workers have time to fetch initial states
  setTimeout(() => {
    crossChainDetector.start();
    log.info('🌐 Cross-chain detector started');
  }, 10_000);

  // ── 10. Signal handling ──
  const shutdown = async () => {
    log.info('Shutting down...');
    crossChainDetector.stop();
    workerManager.stopAll();
    server.stop();
    log.info('Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('═══════════════════════════════════════════════');
  log.info('   Universal Trader — Running');
  log.info(`   Admin API: http://localhost:${config.adminPort}`);
  log.info(`   Chains: ${config.enabledChainIds.join(', ')}`);
  log.info(`   Pools: ${store.size}`);
  log.info('═══════════════════════════════════════════════');
}

// ── Pool Discovery Stub ──
// In production, replace with factory contract scanning or DB queries.
// For now, returns empty — pools can be added via the admin API or by
// extending chain configs with known pool addresses.

import type { ChainConfig } from './config/types.ts';

function buildPoolRegistrations(chainConfig: ChainConfig): PoolRegistration[] {
  const pools: PoolRegistration[] = [];

  // Example: for each DEX, register well-known pairs
  // You would typically load these from a database or discovery service
  for (const dex of chainConfig.dexConfigs) {
    for (let i = 0; i < chainConfig.tokens.length; i++) {
      for (let j = i + 1; j < chainConfig.tokens.length; j++) {
        const token0 = chainConfig.tokens[i];
        const token1 = chainConfig.tokens[j];
        if (!token0 || !token1) continue;

        // Pool addresses need to be computed or fetched from factory contracts.
        // This is a placeholder — real addresses would come from:
        //   1. Factory.getPair(token0, token1)     — V2
        //   2. Factory.getPool(token0, token1, fee) — V3
        //   3. Pre-populated database
        // For now, we skip pool address computation and leave it for the
        // pool discovery phase that runs after workers are spawned.
        pools.push({
          address: '', // Will be populated by pool discovery
          chainId: chainConfig.chainId,
          dexType: dex.type,
          dexName: dex.name,
          fee: dex.type === 'uniswap-v3' ? 3000 : 3000,
          routerAddress: dex.routerAddress,
          token0: {
            address: token0.address,
            symbol: token0.symbol ?? 'UNKNOWN',
            name: token0.symbol ?? 'UNKNOWN',
            decimals: token0.decimals ?? 18,
          },
          token1: {
            address: token1.address,
            symbol: token1.symbol ?? 'UNKNOWN',
            name: token1.symbol ?? 'UNKNOWN',
            decimals: token1.decimals ?? 18,
          },
        });
      }
    }
  }

  return pools;
}

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
