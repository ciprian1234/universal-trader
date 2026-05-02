// ================================================================================================
// CHECK POOL SYNC — Compares live API pool state against fresh on-chain data
//
// Usage:
//   SCRIPTS_DATABASE_URL=... bun run src/scripts/check-pool-sync.ts
//
// What it checks:
//   V2  — reserve0, reserve1
//   V3/V4 — sqrtPriceX96, liquidity, ticks (sorted tick arrays)
// ================================================================================================
import { appendFileSync, writeFileSync } from 'fs';
import { appConfig } from '@/config';
import type { ChainConfig } from '@/config/models';
import { logger } from '@/utils';
import { WorkerDb } from '@/db';
import { EventBus } from '@/core/event-bus';
import { Blockchain } from '@/core/blockchain';
import { TokenManager } from '@/core/token-manager';
import { PriceOracle } from '@/core/price-oracle';
import { DexManager } from '@/core/dex-manager';
import type { DexPoolState, DexV2PoolState, DexV3PoolState, DexV4PoolState } from '@/shared/data-model/layer1';

// ========================================================================================
// CONFIG
// ========================================================================================
const API_BASE_URL = `http://192.168.1.167:${appConfig.apiServerPort}`;
const PAGE_LIMIT = 1000; // pools per API page (also the on-chain update batch size)
const TICKS_RANGE = 8; // tick word range for V3/V4 comparison

const chainConfig = appConfig.platforms['ethereum'] as ChainConfig;
if (!process.env.SCRIPTS_DATABASE_URL) throw new Error('SCRIPTS_DATABASE_URL not set');

// ========================================================================================
// SERVICES
// ========================================================================================
const db = new WorkerDb(process.env.SCRIPTS_DATABASE_URL, chainConfig.chainId);
const eventBus = new EventBus();
const blockchain = new Blockchain({ chainConfig, eventBus });
const tokenManager = new TokenManager({ chainConfig, blockchain, eventBus, db });
const priceOracle = new PriceOracle({ chainConfig, tokenManager, eventBus });
const dexManager = new DexManager({ chainConfig, eventBus, blockchain, tokenManager, priceOracle, db });

// ========================================================================================
// OUTPUT FILE
// ========================================================================================
const OUTPUT_FILE = `pool-sync-report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

function initOutputFile(): void {
  writeFileSync(OUTPUT_FILE, `Pool Sync Report — ${new Date().toISOString()}\n${'═'.repeat(60)}\n\n`);
  logger.info(`📝 Writing diffs to: ${OUTPUT_FILE}`);
}

function appendDiffToFile(r: PoolDiff): void {
  const lines = [`[${r.protocol}] ${r.venue} ${r.pair} (${r.poolId})`];
  for (const d of r.diffs) lines.push(`  • ${d}`);
  appendFileSync(OUTPUT_FILE, lines.join('\n') + '\n\n');
}

function appendSummaryToFile(totalProcessed: number, results: PoolDiff[]): void {
  const v2 = results.filter((r) => r.protocol === 'v2').length;
  const v3 = results.filter((r) => r.protocol === 'v3').length;
  const v4 = results.filter((r) => r.protocol === 'v4').length;
  const lines = [
    `${'═'.repeat(60)}`,
    `SUMMARY — ${totalProcessed} pools checked, ${results.length} out of sync`,
    `V2: ${v2} diffs  |  V3: ${v3} diffs  |  V4: ${v4} diffs`,
    `Completed: ${new Date().toISOString()}`,
  ];
  appendFileSync(OUTPUT_FILE, lines.join('\n') + '\n');
}

// ========================================================================================
// HELPERS
// ========================================================================================
function pct(a: bigint, b: bigint): string {
  if (b === 0n) return 'N/A';
  const diff = a > b ? a - b : b - a;
  return ((Number(diff) / Number(b)) * 100).toFixed(4) + '%';
}

interface PoolDiff {
  poolId: string;
  venue: string;
  protocol: string;
  pair: string;
  diffs: string[];
}

function diffV2(api: DexV2PoolState, chain: DexV2PoolState): string[] {
  const diffs: string[] = [];
  if (api.reserve0 !== chain.reserve0)
    diffs.push(`reserve0: api=${api.reserve0} chain=${chain.reserve0} (${pct(api.reserve0, chain.reserve0)} off)`);
  if (api.reserve1 !== chain.reserve1)
    diffs.push(`reserve1: api=${api.reserve1} chain=${chain.reserve1} (${pct(api.reserve1, chain.reserve1)} off)`);
  return diffs;
}

function diffV3V4(api: DexV3PoolState | DexV4PoolState, chain: DexV3PoolState | DexV4PoolState): string[] {
  const diffs: string[] = [];
  if (api.sqrtPriceX96 !== chain.sqrtPriceX96)
    diffs.push(
      `sqrtPriceX96: api=${api.sqrtPriceX96} chain=${chain.sqrtPriceX96} (${pct(api.sqrtPriceX96, chain.sqrtPriceX96)} off)`,
    );
  if (api.liquidity !== chain.liquidity)
    diffs.push(`liquidity: api=${api.liquidity} chain=${chain.liquidity} (${pct(api.liquidity, chain.liquidity)} off)`);

  // compare ticks
  const apiTicks = (api.ticks ?? []).map((t) => `${t.tick}:${t.liquidityNet}`).join(',');
  const chainTicks = (chain.ticks ?? []).map((t) => `${t.tick}:${t.liquidityNet}`).join(',');
  if (apiTicks !== chainTicks) {
    diffs.push(`ticks mismatch: api=[${apiTicks}] chain=[${chainTicks}]`);
  }
  return diffs;
}

// ========================================================================================
// MAIN
// ========================================================================================
async function main() {
  logger.info('🔍 Starting pool sync check...');

  // init services (no block listeners, no arbitrage, just data access)
  await tokenManager.init();
  await priceOracle.init();
  await dexManager.init();
  await dexManager.registerStoredPools(false); // load pools into dexManager.pools without chain sync

  // fetch one page at a time, immediately compare against fresh on-chain data
  logger.info(`\n📡 Fetching and checking pools page by page from ${API_BASE_URL}...`);
  initOutputFile();
  const results: PoolDiff[] = [];
  let page = 1;
  let total = 0;
  let fetchedFromApi = 0; // tracks API-returned count — used for loop termination
  let totalProcessed = 0; // tracks dexManager-processed count — for logging only

  do {
    // fetch one page from API
    const res = await fetch(`${API_BASE_URL}/pools?page=${page}&limit=${PAGE_LIMIT}`);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { total: number; pools: DexPoolState[] };
    total = body.total;
    const apiPools = JSON.parse(JSON.stringify(body.pools), (_, v) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as DexPoolState[];

    // empty page means we've gone past the end — stop
    if (apiPools.length === 0) break;
    fetchedFromApi += apiPools.length;
    logger.info(`  📄 Page ${page}: fetched ${apiPools.length} pools (${fetchedFromApi}/${total})`);

    // immediately fetch fresh on-chain data for this page and compare
    const apiPoolMap = new Map<string, DexPoolState>(apiPools.map((p) => [p.id, p]));
    const batchIds = new Set(apiPoolMap.keys());
    const chainPools = await dexManager.updatePoolsByIds(batchIds, TICKS_RANGE);
    totalProcessed += chainPools.length;
    logger.info(`  🔗 Page ${page}: on-chain update done (${totalProcessed} processed so far)`);

    for (const chainPool of chainPools) {
      let diff: PoolDiff | null = null;

      if (chainPool.error) {
        diff = {
          poolId: chainPool.id,
          venue: chainPool.venue.name,
          protocol: chainPool.protocol,
          pair: chainPool.tokenPair.key,
          diffs: [`on-chain fetch error: ${chainPool.error}`],
        };
      } else {
        const apiPool = apiPoolMap.get(chainPool.id);
        if (apiPool) {
          let diffs: string[] = [];
          if (chainPool.protocol === 'v2' && apiPool.protocol === 'v2') {
            diffs = diffV2(apiPool, chainPool);
          } else if (
            (chainPool.protocol === 'v3' || chainPool.protocol === 'v4') &&
            (apiPool.protocol === 'v3' || apiPool.protocol === 'v4')
          ) {
            diffs = diffV3V4(apiPool as DexV3PoolState | DexV4PoolState, chainPool as DexV3PoolState | DexV4PoolState);
          }
          if (diffs.length > 0) {
            diff = {
              poolId: chainPool.id,
              venue: chainPool.venue.name,
              protocol: chainPool.protocol,
              pair: chainPool.tokenPair.key,
              diffs,
            };
          }
        }
      }

      if (diff) {
        results.push(diff);
        appendDiffToFile(diff); // write to file immediately
      }
    }

    page++;
  } while (fetchedFromApi < total);

  // 3. report
  logger.info('\n════════════════════════════════════════════════════════');
  logger.info(`📊 SYNC CHECK RESULTS — ${totalProcessed} pools checked`);
  logger.info('════════════════════════════════════════════════════════');

  appendSummaryToFile(totalProcessed, results);

  if (results.length === 0) {
    logger.info('✅ All pools are in sync with on-chain data!');
  } else {
    logger.warn(`⚠️  ${results.length} pools out of sync (see ${OUTPUT_FILE})`);
  }

  const v2Diffs = results.filter((r) => r.protocol === 'v2').length;
  const v3Diffs = results.filter((r) => r.protocol === 'v3').length;
  const v4Diffs = results.filter((r) => r.protocol === 'v4').length;
  logger.info(`\n  V2: ${v2Diffs} diffs  |  V3: ${v3Diffs} diffs  |  V4: ${v4Diffs} diffs`);
  logger.info('════════════════════════════════════════════════════════\n');
}

main()
  .then(() => logger.info('✅ Done'))
  .catch((err) => {
    logger.error('❌ Fatal error', { err });
    process.exit(1);
  })
  .finally(async () => {
    await db.destroy();
    await blockchain.cleanup();
    process.exit(0);
  });
