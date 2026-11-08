export type CacheStoreResult<T> = T | Promise<T>;

/**
 * Persistent storage for opaque cache payloads managed by this package.
 *
 * Implementations must preserve the bytes exactly and apply the supplied TTL.
 * `clear()` must remove only keys beginning with the supplied prefix.
 */
export interface CacheStore {
  get(key: string): CacheStoreResult<Uint8Array | undefined>;
  set(key: string, value: Uint8Array, ttlMs: number): CacheStoreResult<void>;
  delete(key: string): CacheStoreResult<void>;
  clear(keyPrefix: string): CacheStoreResult<void>;
}

export interface CacheOptions {
  /** Enables caching. Defaults to true. */
  enabled?: boolean;

  /** How long a successful result is considered fresh. Defaults to 15 minutes. */
  ttlMs?: number;

  /** How long an expired result may be returned after HTTP 429. Defaults to 24 hours. */
  staleIfErrorMs?: number;

  /** Maximum number of cached request results. Defaults to 100. */
  maxEntries?: number;

  /** Optional persistent L2 cache shared across clients or processes. */
  store?: CacheStore;

  /** Namespace used for persistent cache keys. Defaults to "google-trends-api:v1:". */
  keyPrefix?: string;
}

export interface ResolvedCacheOptions {
  enabled: boolean;
  ttlMs: number;
  staleIfErrorMs: number;
  maxEntries: number;
  store?: CacheStore;
  keyPrefix: string;
}

export type CacheEntryState = 'fresh' | 'stale';

export interface CacheLookup<T> {
  value: T;
  state: CacheEntryState;
  cachedAt: number;
}
