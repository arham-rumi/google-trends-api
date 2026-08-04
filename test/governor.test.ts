import { describe, expect, it } from 'vitest';

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
    const firstStartedAt = Date.now();
    await governor.waitForCooldown();
    expect(Date.now() - firstStartedAt).toBeGreaterThanOrEqual(10);

    await expect(rejectWithRateLimit()).rejects.toBeInstanceOf(RateLimitError);
    const secondStartedAt = Date.now();
    await governor.waitForCooldown();
    expect(Date.now() - secondStartedAt).toBeGreaterThanOrEqual(25);

    governor.markOperationSucceeded();
    await expect(rejectWithRateLimit()).rejects.toBeInstanceOf(RateLimitError);
    expect(governor.cooldownRemainingMs).toBeLessThanOrEqual(15);
  });

  it('rejects invalid recovery delays', () => {
    expect(() =>
      resolveRateLimitOptions({
        recoveryDelaysMs: [1_000, -1],
      }),
    ).toThrow(RangeError);
  });
});
