export interface CacheOptions {
  /** Enables the built-in memory cache. Defaults to true. */
  enabled?: boolean;

  /** How long a successful result is considered fresh. Defaults to 15 minutes. */
  ttlMs?: number;

  /** How long an expired result may be returned after HTTP 429. Defaults to 24 hours. */
  staleIfErrorMs?: number;

  /** Maximum number of cached request results. Defaults to 100. */
  maxEntries?: number;
}

export interface ResolvedCacheOptions {
  enabled: boolean;
  ttlMs: number;
  staleIfErrorMs: number;
  maxEntries: number;
}

export type CacheEntryState = 'fresh' | 'stale';

export interface CacheLookup<T> {
  value: T;
  state: CacheEntryState;
  cachedAt: number;
}
