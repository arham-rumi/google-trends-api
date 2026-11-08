import { describe, expect, it, vi } from 'vitest';

import { PersistentCoordinator } from '../src/rate-limit/persistent-coordinator.js';
import { TestCoordinatedCacheStore } from './support/coordinated-cache-store.js';

function createCoordinator(
  store: TestCoordinatedCacheStore,
  options: { lockTtlMs?: number; pollIntervalMs?: number } = {},
): PersistentCoordinator {
  return new PersistentCoordinator(store, 'test:', {
    enabled: true,
    lockTtlMs: options.lockTtlMs ?? 30,
    pollIntervalMs: options.pollIntervalMs ?? 5,
  });
}

describe('PersistentCoordinator', () => {
  it('provides exclusive request leases and releases by owner', async () => {
    const store = new TestCoordinatedCacheStore();
    const first = createCoordinator(store);
    const second = createCoordinator(store);
    const firstLease = await first.tryAcquireRequest('same-request');

    expect(firstLease).toBeDefined();
    await expect(second.tryAcquireRequest('same-request')).resolves.toBeUndefined();

    await firstLease?.release();
    const secondLease = await second.tryAcquireRequest('same-request');

    expect(secondLease).toBeDefined();
    await secondLease?.release();
    expect(store.locks.size).toBe(0);
  });

  it('refreshes a live lease before its TTL expires', async () => {
    vi.useFakeTimers();

    try {
      const store = new TestCoordinatedCacheStore();
      const first = createCoordinator(store, { lockTtlMs: 30 });
      const second = createCoordinator(store, { lockTtlMs: 30 });
      const lease = await first.tryAcquireRequest('slow-request');

      await vi.advanceTimersByTimeAsync(45);
      await expect(second.tryAcquireRequest('slow-request')).resolves.toBeUndefined();

      await lease?.release();
      await expect(second.tryAcquireRequest('slow-request')).resolves.toBeDefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('takes over after an abandoned lease expires', async () => {
    vi.useFakeTimers();

    try {
      const store = new TestCoordinatedCacheStore();
      const first = createCoordinator(store, { lockTtlMs: 30 });
      const second = createCoordinator(store, { lockTtlMs: 30 });
      const abandonedLease = await first.tryAcquireRequest('abandoned-request');

      expect(abandonedLease).toBeDefined();
      vi.clearAllTimers();
      await vi.advanceTimersByTimeAsync(31);

      const recoveredLease = await second.tryAcquireRequest('abandoned-request');

      expect(recoveredLease).toBeDefined();
      await recoveredLease?.release();
      await abandonedLease?.release();
      expect(store.locks.size).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps the longest shared endpoint cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'));

    try {
      const store = new TestCoordinatedCacheStore();
      const first = createCoordinator(store);
      const second = createCoordinator(store);
      const now = Date.now();

      await first.extendCooldown('/trends/api/explore', now + 1_000);
      await second.extendCooldown('/trends/api/explore?hl=en', now + 500);

      await expect(second.getCooldownRemainingMs('/trends/api/explore')).resolves.toBe(1_000);
      expect(second.observedCooldownRemainingMs).toBe(1_000);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first.getCooldownRemainingMs('/trends/api/explore')).resolves.toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
