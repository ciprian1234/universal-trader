import { SQL } from 'bun';
import type { DexPoolState } from '@/shared/data-model/layer1';
import type { TokenOnChain } from '@/shared/data-model/token';
import { createLogger } from '@/utils';
import type { ArbitrageOpportunity } from '../core/interfaces';

// ════════════════════════════════════════════════════════════
// DB TYPES — static data only, no dynamic fields
// ════════════════════════════════════════════════════════════

export interface StoredToken extends TokenOnChain {
  source: 'config' | 'coingecko' | 'introspected';
  isEnabled: boolean; // whether this token is enabled for trading (not blacklisted)
  createdAt?: number;
  updatedAt?: number;
}

export interface StoredPool {
  id: string;

  // we store those for easy querying => we also have this data in state
  chainId: number;
  venueName: string;
  tokenPairKey: string; // on-chain token pair key token0:token1 (example: USDC:WETH)
  feeBps: number;
  pairId: string; // canonical token pair id (e.g. "ETH:USDC")

  state: DexPoolState; // we store full state but we care only about static fields
  source: 'config' | 'event' | 'sync';
  isEnabled: boolean; // whether this pool is enabled for trading (not blacklisted)
  createdAt?: number;
  updatedAt?: number;
}

// ════════════════════════════════════════════════════════════
// WORKER DB
// ════════════════════════════════════════════════════════════

export class WorkerDb {
  private readonly sql: SQL;
  private readonly logger = createLogger('WorkerDb');
  private readonly chainId: number;

  constructor(databaseUrl: string, chainId: number) {
    this.sql = new SQL(databaseUrl);
    this.chainId = chainId;
    console.log(`Initializing WorkerDb with databaseUrl: ${databaseUrl}, chainId: ${chainId}`);
  }

  // for testing/dev purposes only, drops all tables and data
  async reset() {
    await this.sql`DROP TABLE IF EXISTS tokens`;
    await this.sql`DROP TABLE IF EXISTS pools`;
    this.logger.info('✅ DB reset complete');
  }

  // ================================================================================================
  // SCHEMA SETUP
  // ================================================================================================
  async createTables(): Promise<void> {
    try {
      // Create 'tokens' table
      await this.sql`
      CREATE TABLE IF NOT EXISTS tokens (
        "chainId"         INTEGER   NOT NULL,
        "address"         TEXT      NOT NULL,
        "symbol"          TEXT      NOT NULL,
        "name"            TEXT      NOT NULL,
        "decimals"        INTEGER   NOT NULL,
        "source"          TEXT      NOT NULL,
        "isEnabled"       BOOLEAN   NOT NULL DEFAULT TRUE,
        "createdAt"       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("chainId", "address")
      )
    `;

      // Create 'pools' table
      await this.sql`
      CREATE TABLE IF NOT EXISTS pools (
        "id"              TEXT      PRIMARY KEY,
        "error"           TEXT      DEFAULT NULL,
        "chainId"         INTEGER   NOT NULL,
        "venueName"       TEXT      NOT NULL,
        "tokenPairKey"    TEXT      NOT NULL,
        "feeBps"          INTEGER   NOT NULL,
        "pairId"          TEXT      NOT NULL,
        "state"           JSONB     NOT NULL,
        "source"          TEXT      NOT NULL,
        "isEnabled"       BOOLEAN   NOT NULL DEFAULT TRUE,
        "createdAt"       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

      // create 'arbitrage_opportunities' table
      await this.sql`
      CREATE TABLE IF NOT EXISTS arbitrage_opportunities (
        "id"                TEXT      PRIMARY KEY,
        "status"            TEXT      NOT NULL,
        "grossProfitUSD"    FLOAT     NOT NULL,
        "state"             JSONB     NOT NULL,
        "createdAt"         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    } catch (error) {
      this.logger.error(`Error creating tables: ${error instanceof Error ? error.stack : String(error)}`);
      throw error;
    }

    // optionally create DB indexes
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens (chainId)`;
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_pools_chain  ON pools  (chainId)`;
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_pools_venue  ON pools  (venueName)`;
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_pools_pair   ON pools  (pairId)`;
    this.logger.info('✅ DB schema ready');
  }

  // ================================================================================================
  // TOKENS
  // ================================================================================================
  async upsertToken(token: StoredToken): Promise<void> {
    await this.sql`
      INSERT INTO tokens ("chainId", "address", "symbol", "name", "decimals", "source", "isEnabled")
      VALUES (
        ${token.chainId},
        ${token.address.toLowerCase()},
        ${token.symbol},
        ${token.name},
        ${token.decimals},
        ${token.source},
        ${token.isEnabled}
      )
      ON CONFLICT ("chainId", "address") DO UPDATE SET
        "source" = EXCLUDED."source",
        "isEnabled" = EXCLUDED."isEnabled",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
  }

  async loadAllTokens(): Promise<StoredToken[]> {
    const rows = await this.sql`SELECT * FROM tokens WHERE "chainId" = ${this.chainId}`;

    return rows.map((row: any) => ({
      chainId: row.chainId as number,
      address: row.address as string,
      symbol: row.symbol as string,
      name: row.name as string,
      decimals: row.decimals as number,
      source: row.source as StoredToken['source'],
      isEnabled: row.isEnabled as boolean,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  // ================================================================================================
  // POOLS
  // ================================================================================================
  async upsertPool(pool: DexPoolState, source: StoredPool['source'], isEnabled: boolean): Promise<void> {
    // return;
    await this.sql`
      INSERT INTO pools ("id", "error", "chainId", "venueName", "tokenPairKey", "feeBps", "pairId", "state", "source", "isEnabled")
      VALUES (
        ${pool.id},
        ${pool.error},
        ${pool.venue.chainId},
        ${pool.venue.name},
        ${pool.tokenPair.key},
        ${pool.feeBps},
        ${pool.pairId},
        ${serializeObject(pool)},
        ${source},
        ${isEnabled}
      )
      ON CONFLICT ("id") DO UPDATE SET
        "error" = EXCLUDED."error",
        "venueName" = EXCLUDED."venueName",
        "state" = EXCLUDED."state",
        "isEnabled" = EXCLUDED."isEnabled",
        "source" = EXCLUDED."source",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
  }

  async updatePoolIsEnabled(poolId: string, isEnabled: boolean): Promise<void> {
    await this.sql`
      UPDATE pools
      SET "isEnabled" = ${isEnabled}
      WHERE "id" = ${poolId}
    `;
  }

  async loadAllPools(): Promise<StoredPool[]> {
    const rows = await this.sql`SELECT * FROM pools WHERE "chainId" = ${this.chainId}`;

    return rows.map((row: any) => ({
      id: row.id as string,
      chainId: row.chainId as number,
      venueName: row.venueName as string,
      tokenPairKey: row.tokenPairKey as string,
      feeBps: row.feeBps as number,
      pairId: row.pairId as string,
      state: deserializeObject<DexPoolState>(row.state),
      source: row.source as StoredPool['source'],
      isEnabled: row.isEnabled as boolean,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  // ================================================================================================
  // ARBITRAGE OPPORTUNITIES
  // ================================================================================================
  async upsertArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    await this.sql`
      INSERT INTO arbitrage_opportunities ("id", "status", "grossProfitUSD", "state")
      VALUES (
        ${opportunity.id},
        ${opportunity.status},
        ${opportunity.grossProfitUSD},
        ${serializeObject(opportunity)}
      )
      ON CONFLICT ("id") DO UPDATE SET
        "status" = EXCLUDED."status",
        "state" = EXCLUDED."state",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
  }

  async pushArbitrageLog_deprecated(
    opportunityId: string,
    input: { logEntry: any; status: string; confirmedAtBlock?: number },
  ): Promise<void> {
    input.logEntry.date = new Date().toISOString(); // add formatted date for easier reading in DB

    await this.sql`
      UPDATE arbitrage_opportunities
      SET
        "logs"      = "logs" || ${[serializeObject(input.logEntry)]}::jsonb,
        "status"    = ${input.status},
        "confirmedAtBlock" = ${input.confirmedAtBlock ?? null},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${opportunityId}
    `;
  }

  // ================================================================================================
  // LIFECYCLE
  // ================================================================================================
  async destroy(): Promise<void> {
    await this.sql.end?.();
  }
}

// ════════════════════════════════════════════════════════════
// SERIALIZATION HELPERS
// ════════════════════════════════════════════════════════════
/**
 * Serialize object which may contain bigints
 * - bigints are converted to strings with "n" suffix (e.g. "123n") before stringifying
 * - then we parse the JSON back to get an object with bigints as strings, which can be stored in JSONB column
 * - on deserialization, we convert "123n" strings back to bigints
 */
function serializeObject<T>(state: T): object {
  const stringifiedData = JSON.stringify(state, (_, value) => (typeof value === 'bigint' ? `${value.toString()}n` : value));
  const parsedData = JSON.parse(stringifiedData);
  return parsedData;
}

/*
 * Deserialize object from DB, converting "123n" strings back to bigints
 * to through all fields and convert any string that ends with "n" and is a number to bigint
 */
const BIGINT_STRING_REGEX = /^\d+n$/;
function deserializeObject<T>(json: object): T {
  return JSON.parse(JSON.stringify(json), (_, value) =>
    typeof value === 'string' && BIGINT_STRING_REGEX.test(value) ? BigInt(value.slice(0, -1)) : value,
  );
}
