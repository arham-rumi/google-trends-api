import { describe, expect, it } from 'vitest';

import { ResultCache } from '../src/cache/result-cache.js';
import type { CacheStore } from '../src/cache/types.js';

class TestCacheStore implements CacheStore {
  public readonly entries = new Map<string, Uint8Array>();
  public readonly ttls = new Map<string, number>();

  public get(key: string): Uint8Array | undefined {
    return this.entries.get(key)?.slice();
  }

  public set(key: string, value: Uint8Array, ttlMs: number): void {
    this.entries.set(key, value.slice());
    this.ttls.set(key, ttlMs);
  }

  public delete(key: string): void {
    this.entries.delete(key);
    this.ttls.delete(key);
  }

  public clear(keyPrefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.delete(key);
      }
    }
  }
}

function createCache(store: CacheStore, keyPrefix = 'test:v1:'): ResultCache {
  return new ResultCache({
    enabled: true,
    ttlMs: 100,
    staleIfErrorMs: 200,
    maxEntries: 10,
    store,
    keyPrefix,
  });
}

describe('ResultCache', () => {
  it('shares cached values across instances and preserves Dates', async () => {
    const store = new TestCacheStore();
    const first = createCache(store);
    const second = createCache(store);
    const value = {
      date: new Date('2026-08-10T00:00:00.000Z'),
      nested: { value: 42 },
    };

    await first.set('interestOverTime:{...}', value, 1_000);

    expect(store.entries.size).toBe(1);
    expect([...store.ttls.values()]).toEqual([300]);
    expect([...store.entries.keys()][0]).toMatch(/^test:v1:[a-f\d]{64}$/);

    const lookup = await second.get<typeof value>('interestOverTime:{...}', 1_050);

    expect(lookup).toMatchObject({ state: 'fresh', cachedAt: 1_000 });
    expect(lookup?.value).toEqual(value);
    expect(lookup?.value.date).toBeInstanceOf(Date);
    expect(second.size).toBe(1);

    if (lookup !== undefined) {
      lookup.value.nested.value = 99;
    }

    expect((await second.get<typeof value>('interestOverTime:{...}', 1_060))?.value).toEqual(value);
  });

  it('deletes expired or invalid persistent entries', async () => {
    const store = new TestCacheStore();
    const cache = createCache(store);

    await cache.set('expired', { value: 1 }, 1_000);
    await expect(cache.get('expired', 1_301)).resolves.toBeUndefined();
    expect(store.entries.size).toBe(0);

    const invalidCache = createCache(store, 'test:v1:');

    // A malformed entry can only be addressed through its hashed request key. Store a malformed
    // payload under a key produced by a valid write, then replace its bytes.
    await invalidCache.set('invalid', { value: 1 }, 2_000);
    const invalidKey = [...store.entries.keys()][0];

    if (invalidKey === undefined) {
      throw new Error('Expected a persistent cache key.');
    }

    store.entries.set(invalidKey, new Uint8Array([1, 2, 3]));
    const reader = createCache(store, 'test:v1:');

    await expect(reader.get('invalid', 2_010)).resolves.toBeUndefined();
    expect(store.entries.has(invalidKey)).toBe(false);
  });

  it('clears only the configured persistent namespace', async () => {
    const store = new TestCacheStore();
    const first = createCache(store, 'first:');
    const second = createCache(store, 'second:');

    await first.set('key', { source: 'first' }, 1_000);
    await second.set('key', { source: 'second' }, 1_000);
    await first.clear();

    expect(first.size).toBe(0);
    await expect(createCache(store, 'first:').get('key', 1_010)).resolves.toBeUndefined();
    await expect(createCache(store, 'second:').get('key', 1_010)).resolves.toMatchObject({
      value: { source: 'second' },
    });
  });
});
