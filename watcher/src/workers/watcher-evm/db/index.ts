import { SQL } from 'bun';
import type { DexPoolState } from '@/shared/data-model/layer1';
import type { TokenOnChain } from '@/shared/data-model/token';
import { createLogger } from '@/utils';

// ════════════════════════════════════════════════════════════
// DB TYPES — static data only, no dynamic fields
// ════════════════════════════════════════════════════════════

export interface StoredToken extends TokenOnChain {
  source: 'config' | 'coingecko' | 'introspected';
  created_at?: number;
  updated_at?: number;
}

export interface StoredPool {
  id: string;

  // we store those for easy querying => we also have this data in state
  chain_id: number;
  venue_name: string;
  token_pair_key: string; // on-chain token pair key token0:token1 (example: USDC:WETH)
  fee_bps: number;
  pair_id: string; // canonical token pair id (e.g. "ETH:USDC")

  state: DexPoolState; // we store full state but we care only about static fields
  source: 'config' | 'event';
  created_at?: number;
  updated_at?: number;
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

  // ── Schema ───────────────────────────────────────────────────────────
  async createTables(): Promise<void> {
    try {
      await this.sql`
      CREATE TABLE IF NOT EXISTS tokens (
        chain_id       INTEGER   NOT NULL,
        address        TEXT      NOT NULL,
        symbol         TEXT      NOT NULL,
        name           TEXT      NOT NULL,
        decimals       INTEGER   NOT NULL,
        source         TEXT      NOT NULL,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chain_id, address)
      )
    `;

      await this.sql`
      CREATE TABLE IF NOT EXISTS pools (
        id             TEXT      PRIMARY KEY,
        chain_id       INTEGER   NOT NULL,
        venue_name     TEXT      NOT NULL,
        token_pair_key TEXT      NOT NULL,
        fee_bps        INTEGER   NOT NULL,
        pair_id        TEXT      NOT NULL,
        state          JSONB     NOT NULL,
        source         TEXT      NOT NULL,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    } catch (error) {
      this.logger.error(`Error creating tables: ${error instanceof Error ? error.stack : String(error)}`);
      throw error;
    }

    // optionally create DB indexes
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens (chain_id)`;
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_pools_chain  ON pools  (chain_id)`;
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_pools_venue  ON pools  (venue_name)`;
    // await this.sql`CREATE INDEX IF NOT EXISTS idx_pools_pair   ON pools  (pair_key)`;
    this.logger.info('✅ DB schema ready');
  }

  // ── Tokens ───────────────────────────────────────────────────────────
  async upsertToken(token: StoredToken): Promise<void> {
    await this.sql`
      INSERT INTO tokens (chain_id, address, symbol, name, decimals, source)
      VALUES (
        ${token.chainId},
        ${token.address.toLowerCase()},
        ${token.symbol},
        ${token.name},
        ${token.decimals},
        ${token.source}
      )
      ON CONFLICT (chain_id, address) DO UPDATE SET
        source        = EXCLUDED.source,
        updated_at    = CURRENT_TIMESTAMP
    `;
  }

  async loadAllTokens(): Promise<StoredToken[]> {
    const rows = await this.sql`
      SELECT * FROM tokens WHERE chain_id = ${this.chainId}`;

    return rows.map((row: any) => ({
      chainId: row.chain_id as number,
      address: row.address as string,
      symbol: row.symbol as string,
      name: row.name as string,
      decimals: row.decimals as number,
      source: row.source as StoredToken['source'],
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    }));
  }

  // ── Pools ────────────────────────────────────────────────────────────
  async upsertPool(pool: DexPoolState, source: StoredPool['source']): Promise<void> {
    // return;
    await this.sql`
      INSERT INTO pools (id, chain_id, venue_name,token_pair_key, fee_bps, pair_id, state, source)
      VALUES (
        ${pool.id},
        ${pool.venue.chainId},
        ${pool.venue.name},
        ${pool.tokenPair.key},
        ${pool.feeBps},
        ${pool.pairId},
        ${serializeObject(pool)},
        ${source}
      )
      ON CONFLICT (id) DO UPDATE SET
        state = EXCLUDED.state,
        updated_at = CURRENT_TIMESTAMP
    `;
  }

  async updatePoolIsEnabled(poolId: string, isEnabled: boolean): Promise<void> {
    await this.sql`
      UPDATE pools
      SET is_enabled = ${isEnabled}
      WHERE id = ${poolId}
    `;
  }

  async loadAllPools(): Promise<StoredPool[]> {
    const rows = await this.sql`SELECT * FROM pools WHERE chain_id = ${this.chainId}`;

    return rows.map((row: any) => ({
      id: row.id as string,
      chain_id: row.chain_id as number,
      venue_name: row.venue_name as string,
      token_pair_key: row.token_pair_key as string,
      fee_bps: row.fee_bps as number,
      pair_id: row.pair_id as string,
      state: deserializeObject<DexPoolState>(row.state),
      source: row.source as StoredPool['source'],
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    }));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
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
