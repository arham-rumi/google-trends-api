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

/**
 * Cache store with atomic lease operations for cross-instance coordination.
 *
 * Lock acquisition must behave like set-if-absent with a TTL. Refresh and release must only
 * modify a lock when its current owner matches `owner`.
 */
export interface CoordinatedCacheStore extends CacheStore {
  acquireLock(key: string, owner: string, ttlMs: number): CacheStoreResult<boolean>;
  refreshLock(key: string, owner: string, ttlMs: number): CacheStoreResult<boolean>;
  releaseLock(key: string, owner: string): CacheStoreResult<void>;
}

export interface CacheCoordinationOptions {
  /** Enables cross-instance request coalescing, cooldowns, and optional shared pacing. */
  enabled?: boolean;

  /** Serializes and spaces HTTP requests across coordinated clients. Defaults to true. */
  sharedRequestPacing?: boolean;

  /** Lease duration for distributed request locks. Defaults to 30 seconds. */
  lockTtlMs?: number;

  /** Delay between cache checks while another instance owns a request. Defaults to 100 ms. */
  pollIntervalMs?: number;
}

export interface ResolvedCacheCoordinationOptions {
  enabled: boolean;
  sharedRequestPacing: boolean;
  lockTtlMs: number;
  pollIntervalMs: number;
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

  /** Cross-instance coordination settings for stores that implement atomic lease methods. */
  coordination?: CacheCoordinationOptions;
}

export interface ResolvedCacheOptions {
  enabled: boolean;
  ttlMs: number;
  staleIfErrorMs: number;
  maxEntries: number;
  store?: CacheStore;
  keyPrefix: string;
  coordination: Readonly<ResolvedCacheCoordinationOptions>;
}

export type CacheEntryState = 'fresh' | 'stale';

export interface CacheLookup<T> {
  value: T;
  state: CacheEntryState;
  cachedAt: number;
}
