import fs from 'fs/promises';
import path from 'path';

/**
 * 🗄️ STATIC DATA CACHE: Persistent cache for immutable blockchain data
 *
 * Caches:
 * - Token metadata (name, symbol, decimals)
 * - Pool metadata (token0, token1, fee)
 * - Factory lookups (getPair, getPool)
 */

interface CacheEntry {
  value: any;
  timestamp: number;
}

interface CacheData {
  chainId: number;
  createdAt: string;
  updatedAt: string;
  entries: Record<string, CacheEntry>;
}

export class CacheService {
  private cache: Map<string, any> = new Map();
  private readonly cacheFilePath: string;
  private readonly chainId: number;
  private isDirty = false;

  constructor(chainId: number, cacheDir: string = './data/cache') {
    this.chainId = chainId;
    this.cacheFilePath = path.join(cacheDir, `static-cache-${chainId}.json`);
  }

  // ================================================================================================
  // CORE OPERATIONS
  // ================================================================================================

  /**
   * 📂 LOAD: Load cache from disk
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.cacheFilePath, 'utf-8');
      const parsed: CacheData = JSON.parse(data);

      // Validate chain ID
      if (parsed.chainId !== this.chainId) throw new Error(`Chain ID mismatch: expected ${this.chainId}, got ${parsed.chainId}`);

      // Load entries into memory
      for (const [key, entry] of Object.entries(parsed.entries)) {
        this.cache.set(key, this.deserializeValue(entry.value)); // Restore BigInt
      }

      console.log(`✅ Loaded ${this.cache.size} cached entries from disk`);
      console.log(`   Cache file: ${this.cacheFilePath}`);
      console.log(`   Last updated: ${parsed.updatedAt}`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log('ℹ️  No cache file found, starting fresh');
      } else {
        throw error;
      }
    }
  }

  /**
   * 💾 SAVE: Save cache to disk
   */
  async save(): Promise<void> {
    if (!this.isDirty) {
      console.log('Cache not dirty, skipping save');
      return;
    }

    try {
      // Convert Map to serializable object
      const entries: Record<string, CacheEntry> = {};

      for (const [key, value] of this.cache.entries()) {
        entries[key] = { value: this.serializeValue(value), timestamp: Date.now() }; // Serialize BigInt
      }

      const data: CacheData = {
        chainId: this.chainId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries,
      };

      // Ensure directory exists
      await fs.mkdir(path.dirname(this.cacheFilePath), { recursive: true });

      // Write to temp file first (atomic write)
      const tempFile = `${this.cacheFilePath}.tmp`;
      await fs.writeFile(tempFile, JSON.stringify(data, null, 2));

      // Rename temp file to actual file (atomic operation)
      await fs.rename(tempFile, this.cacheFilePath);

      this.isDirty = false;
      console.log(`💾 Saved ${this.cache.size} entries to cache`);
    } catch (error) {
      console.error('❌ Failed to save cache:', error);
      throw error;
    }
  }

  /**
   * 🔍 GET: Retrieve cached value
   */
  get(key: string): any | null {
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    return null;
  }

  /**
   * ➕ SET: Store value in cache
   */
  set(key: string, value: any): void {
    this.cache.set(key, value);
    // console.log(`➕ Cache set: ${key}`);
    this.isDirty = true;
  }

  /**
   * ❓ HAS: Check if key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * 🗑️ DELETE: Remove entry from cache
   */
  delete(key: string): boolean {
    this.isDirty = true;
    return this.cache.delete(key);
  }

  /**
   * 🧹 CLEAR: Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.isDirty = true;
    console.log('🧹 Cache cleared');
  }

  // ================================================================================================
  // UTILITIES
  // ================================================================================================
  /**
   * 🔄 SERIALIZE VALUE: Convert BigInt to serializable format
   */
  private serializeValue(value: any): any {
    if (typeof value === 'bigint') {
      return { __type__: 'bigint', value: value.toString() };
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.serializeValue(item));
    }

    if (value && typeof value === 'object') {
      const serialized: any = {};
      for (const [key, val] of Object.entries(value)) {
        serialized[key] = this.serializeValue(val);
      }
      return serialized;
    }

    return value;
  }

  /**
   * 🔄 DESERIALIZE VALUE: Restore BigInt from serialized format
   */
  private deserializeValue(value: any): any {
    if (value && typeof value === 'object') {
      // Check if it's a serialized BigInt
      if (value.__type__ === 'bigint') {
        return BigInt(value.value);
      }

      // Handle arrays
      if (Array.isArray(value)) {
        return value.map((item) => this.deserializeValue(item));
      }

      // Handle objects
      const deserialized: any = {};
      for (const [key, val] of Object.entries(value)) {
        deserialized[key] = this.deserializeValue(val);
      }
      return deserialized;
    }

    return value;
  }
}
