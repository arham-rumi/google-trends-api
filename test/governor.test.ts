import { describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import { RequestGovernor, resolveRateLimitOptions } from '../src/rate-limit/governor.js';

describe('RequestGovernor', () => {
  it('serializes requests and spaces their start times', async () => {
    const governor = new RequestGovernor(
      resolveRateLimitOptions({
        minIntervalMs: 20,
        cooldownMs: 50,
        recovery: false,
      }),
    );
    const starts: number[] = [];
    await Promise.all([
      governor.execute(async () => {
        starts.push(Date.now());
      }),
      governor.execute(async () => {
        starts.push(Date.now());
      }),
    ]);

    expect(starts).toHaveLength(2);
    expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(15);
  });

  it('uses Retry-After as the minimum shared cooldown', async () => {
    const governor = new RequestGovernor(
      resolveRateLimitOptions({
        minIntervalMs: 0,
        cooldownMs: 5,
        recoveryDelaysMs: [10],
      }),
    );

    await expect(
      governor.execute(async () => {
        throw new RateLimitError({
          url: 'https://example.test',
          responseBody: undefined,
          retryAfterMs: 30,
        });
      }),
    ).rejects.toBeInstanceOf(RateLimitError);

    const startedAt = Date.now();
    await governor.waitForCooldown();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it('advances through recovery delays and resets after success', async () => {
    vi.useFakeTimers();

    try {
      const governor = new RequestGovernor(
        resolveRateLimitOptions({
          minIntervalMs: 0,
          recoveryDelaysMs: [15, 30],
        }),
      );
      const rejectWithRateLimit = () =>
        governor.execute(async () => {
          throw new RateLimitError({
            url: 'https://example.test',
            responseBody: undefined,
            retryAfterMs: undefined,
          });
        });

      await expect(rejectWithRateLimit()).rejects.toBeInstanceOf(RateLimitError);
      expect(governor.cooldownRemainingMs).toBe(15);

      const firstCooldown = governor.waitForCooldown();
      await vi.advanceTimersByTimeAsync(15);
      await firstCooldown;
      expect(governor.cooldownRemainingMs).toBe(0);

      await expect(rejectWithRateLimit()).rejects.toBeInstanceOf(RateLimitError);
      expect(governor.cooldownRemainingMs).toBe(30);

      const secondCooldown = governor.waitForCooldown();
      await vi.advanceTimersByTimeAsync(30);
      await secondCooldown;
      expect(governor.cooldownRemainingMs).toBe(0);

      governor.markOperationSucceeded();
      await expect(rejectWithRateLimit()).rejects.toBeInstanceOf(RateLimitError);
      expect(governor.cooldownRemainingMs).toBe(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cooldowns and recovery counters isolated by endpoint', async () => {
    const governor = new RequestGovernor(
      resolveRateLimitOptions({
        minIntervalMs: 0,
        recoveryDelaysMs: [20, 100],
      }),
    );
    const rejectFor = (path: string) =>
      governor.execute(
        async () => {
          throw new RateLimitError({
            url: `https://example.test${path}`,
            responseBody: undefined,
            retryAfterMs: undefined,
          });
        },
        undefined,
        path,
      );

    await expect(rejectFor('/limited-a')).rejects.toBeInstanceOf(RateLimitError);

    expect(governor.getCooldownRemainingMs('/limited-a')).toBeGreaterThan(0);
    expect(governor.getCooldownRemainingMs('/healthy')).toBe(0);

    await expect(governor.execute(async () => 'ok', undefined, '/healthy')).resolves.toBe('ok');

    expect(governor.getCooldownRemainingMs('/limited-a')).toBeGreaterThan(0);

    await governor.waitForCooldown(undefined, '/limited-a');
    await expect(rejectFor('/limited-a')).rejects.toBeInstanceOf(RateLimitError);
    await expect(rejectFor('/limited-b')).rejects.toBeInstanceOf(RateLimitError);

    expect(governor.getCooldownRemainingMs('/limited-a')).toBeGreaterThan(60);
    expect(governor.getCooldownRemainingMs('/limited-b')).toBeLessThanOrEqual(20);
  });

  it('rejects invalid recovery delays', () => {
    expect(() =>
      resolveRateLimitOptions({
        recoveryDelaysMs: [1_000, -1],
      }),
    ).toThrow(RangeError);
  });
});
