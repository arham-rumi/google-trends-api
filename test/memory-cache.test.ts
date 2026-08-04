import { describe, expect, it } from 'vitest';

import { MemoryCache } from '../src/cache/memory-cache.js';

describe('MemoryCache', () => {
  it('distinguishes fresh, stale, and expired entries', () => {
    const cache = new MemoryCache({
      enabled: true,
      ttlMs: 100,
      staleIfErrorMs: 200,
      maxEntries: 10,
    });

    cache.set('key', { value: 1 }, 1_000);

    expect(cache.get<{ value: number }>('key', 1_050)?.state).toBe('fresh');
    expect(cache.get<{ value: number }>('key', 1_150)?.state).toBe('stale');
    expect(cache.get('key', 1_301)).toBeUndefined();
  });

  it('clones cached values and evicts the least recently used entry', () => {
    const cache = new MemoryCache({
      enabled: true,
      ttlMs: 100,
      staleIfErrorMs: 100,
      maxEntries: 2,
    });

    cache.set('first', { nested: { value: 1 } }, 1_000);
    cache.set('second', { value: 2 }, 1_000);

    const first = cache.get<{ nested: { value: number } }>('first', 1_010);

    expect(first).toBeDefined();

    if (first === undefined) {
      throw new Error('Expected a cached value.');
    }

    first.value.nested.value = 99;

    cache.set('third', { value: 3 }, 1_020);

    expect(cache.get('second', 1_020)).toBeUndefined();
    expect(cache.get<{ nested: { value: number } }>('first', 1_020)?.value.nested.value).toBe(1);
  });
});
