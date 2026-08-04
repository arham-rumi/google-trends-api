import type { CacheLookup, ResolvedCacheOptions } from './types.js';

interface StoredCacheEntry {
  value: unknown;
  cachedAt: number;
  freshUntil: number;
  staleUntil: number;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryCache {
  readonly #entries = new Map<string, StoredCacheEntry>();
  readonly #options: Readonly<ResolvedCacheOptions>;

  public constructor(options: ResolvedCacheOptions) {
    this.#options = options;
  }

  public get size(): number {
    return this.#entries.size;
  }

  public get<T>(key: string, now: number = Date.now()): CacheLookup<T> | undefined {
    if (!this.#options.enabled) {
      return undefined;
    }

    const entry = this.#entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (now > entry.staleUntil) {
      this.#entries.delete(key);
      return undefined;
    }

    // Refresh insertion order so eviction behaves like a small LRU cache.
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return {
      value: cloneValue(entry.value) as T,
      state: now <= entry.freshUntil ? 'fresh' : 'stale',
      cachedAt: entry.cachedAt,
    };
  }

  public set<T>(key: string, value: T, now: number = Date.now()): void {
    if (!this.#options.enabled) {
      return;
    }

    this.#entries.delete(key);
    this.#entries.set(key, {
      value: cloneValue(value),
      cachedAt: now,
      freshUntil: now + this.#options.ttlMs,
      staleUntil: now + this.#options.ttlMs + this.#options.staleIfErrorMs,
    });

    while (this.#entries.size > this.#options.maxEntries) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;

      if (oldestKey === undefined) {
        break;
      }

      this.#entries.delete(oldestKey);
    }
  }

  public clear(): void {
    this.#entries.clear();
  }
}
