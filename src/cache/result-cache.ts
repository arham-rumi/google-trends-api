import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';

import { MemoryCache } from './memory-cache.js';
import type { CacheLookup, CacheStore, ResolvedCacheOptions } from './types.js';

const CACHE_PAYLOAD_VERSION = 1;

interface StoredCachePayload {
  version: typeof CACHE_PAYLOAD_VERSION;
  cachedAt: number;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePayload(value: Uint8Array): StoredCachePayload | undefined {
  try {
    const decoded: unknown = deserialize(value);

    if (
      !isRecord(decoded) ||
      decoded.version !== CACHE_PAYLOAD_VERSION ||
      typeof decoded.cachedAt !== 'number' ||
      !Number.isFinite(decoded.cachedAt)
    ) {
      return undefined;
    }

    return {
      version: CACHE_PAYLOAD_VERSION,
      cachedAt: decoded.cachedAt,
      value: decoded.value,
    };
  } catch {
    return undefined;
  }
}

function encodePayload(value: unknown, cachedAt: number): Uint8Array {
  return serialize({
    version: CACHE_PAYLOAD_VERSION,
    cachedAt,
    value,
  } satisfies StoredCachePayload);
}

function persistentKey(prefix: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex');
  return `${prefix}results:${digest}`;
}

function validateStoredBytes(value: unknown, key: string): asserts value is Uint8Array | undefined {
  if (value !== undefined && !(value instanceof Uint8Array)) {
    throw new TypeError(`Cache store returned a non-Uint8Array value for ${key}.`);
  }
}

export class ResultCache {
  readonly #memory: MemoryCache;
  readonly #options: Readonly<ResolvedCacheOptions>;
  readonly #store: CacheStore | undefined;

  public constructor(options: ResolvedCacheOptions) {
    this.#options = options;
    this.#memory = new MemoryCache(options);
    this.#store = options.store;
  }

  /** Number of entries in this client's in-memory L1 cache. */
  public get size(): number {
    return this.#memory.size;
  }

  public async get<T>(key: string, now: number = Date.now()): Promise<CacheLookup<T> | undefined> {
    const memoryLookup = this.#memory.get<T>(key, now);

    if (memoryLookup !== undefined || !this.#options.enabled || this.#store === undefined) {
      return memoryLookup;
    }

    const storeKey = persistentKey(this.#options.keyPrefix, key);
    const storedBytes = await this.#store.get(storeKey);
    validateStoredBytes(storedBytes, storeKey);

    if (storedBytes === undefined) {
      return undefined;
    }

    const payload = decodePayload(storedBytes);
    const staleUntil =
      (payload?.cachedAt ?? 0) + this.#options.ttlMs + this.#options.staleIfErrorMs;

    if (payload === undefined || now > staleUntil) {
      await this.#store.delete(storeKey);
      return undefined;
    }

    this.#memory.set(key, payload.value, payload.cachedAt);
    return this.#memory.get<T>(key, now);
  }

  public async set<T>(key: string, value: T, now: number = Date.now()): Promise<void> {
    if (!this.#options.enabled) {
      return;
    }

    this.#memory.set(key, value, now);

    if (this.#store === undefined) {
      return;
    }

    const storeKey = persistentKey(this.#options.keyPrefix, key);
    const retentionMs = this.#options.ttlMs + this.#options.staleIfErrorMs;
    await this.#store.set(storeKey, encodePayload(value, now), retentionMs);
  }

  public async clear(): Promise<void> {
    this.#memory.clear();

    if (this.#store !== undefined) {
      await this.#store.clear(`${this.#options.keyPrefix}results:`);
    }
  }
}
