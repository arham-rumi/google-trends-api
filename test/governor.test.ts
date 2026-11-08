import { describe, expect, it, vi } from 'vitest';

import { RateLimitError, RequestBudgetExceededError } from '../src/errors.js';
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

  it('preserves the request error when releasing a shared pacing lease also fails', async () => {
    const requestError = new Error('request failed');
    const releaseError = new Error('release failed');
    const release = vi.fn(async () => {
      throw releaseError;
    });
    const governor = new RequestGovernor(resolveRateLimitOptions({ minIntervalMs: 25 }), {
      acquireRequestPacingLease: vi.fn(async () => ({ release })),
    });

    await expect(
      governor.execute(async () => {
        throw requestError;
      }),
    ).rejects.toBe(requestError);
    expect(release).toHaveBeenCalledOnce();
  });

  it('backs off after a 429 and recovers only after the configured success streak', async () => {
    vi.useFakeTimers();

    try {
      const governor = new RequestGovernor(
        resolveRateLimitOptions({
          minIntervalMs: 10,
          recoveryDelaysMs: [0],
          adaptivePacing: {
            maxIntervalMs: 15,
            increaseFactor: 2,
            recoveryFactor: 0.5,
            successThreshold: 2,
          },
        }),
      );
      const rateLimited = governor.execute(async () => {
        throw new RateLimitError({
          url: 'https://example.test/data',
          responseBody: undefined,
          retryAfterMs: undefined,
        });
      });

      await expect(rateLimited).rejects.toBeInstanceOf(RateLimitError);
      expect(governor.requestIntervalMs).toBe(15);

      const firstSuccess = governor.execute(async () => 'first');
      await vi.advanceTimersByTimeAsync(15);
      await expect(firstSuccess).resolves.toBe('first');
      expect(governor.requestIntervalMs).toBe(15);

      const secondSuccess = governor.execute(async () => 'second');
      await vi.advanceTimersByTimeAsync(15);
      await expect(secondSuccess).resolves.toBe('second');
      expect(governor.requestIntervalMs).toBe(10);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps a fixed interval when adaptive pacing is disabled', async () => {
    const governor = new RequestGovernor(
      resolveRateLimitOptions({
        minIntervalMs: 10,
        recoveryDelaysMs: [0],
        adaptivePacing: { enabled: false },
      }),
    );

    await expect(
      governor.execute(async () => {
        throw new RateLimitError({
          url: 'https://example.test/data',
          responseBody: undefined,
          retryAfterMs: undefined,
        });
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(governor.requestIntervalMs).toBe(10);
  });

  it('rejects new work when the pending-request budget is full', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const governor = new RequestGovernor(
      resolveRateLimitOptions({
        minIntervalMs: 0,
        requestBudget: { maxPendingRequests: 2, maxQueueWaitMs: 1_000 },
      }),
    );
    const first = governor.execute(async () => firstGate);
    const second = governor.execute(async () => 'second');

    expect(governor.pendingRequests).toBe(2);
    await expect(governor.execute(async () => 'third')).rejects.toMatchObject({
      code: 'REQUEST_BUDGET_EXCEEDED',
      reason: 'queue-full',
      pendingRequests: 2,
      maxPendingRequests: 2,
    });

    releaseFirst?.();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe('second');
    expect(governor.pendingRequests).toBe(0);
  });

  it('rejects queued work after its maximum wait without later executing it', async () => {
    vi.useFakeTimers();

    try {
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let secondExecuted = false;
      const governor = new RequestGovernor(
        resolveRateLimitOptions({
          minIntervalMs: 0,
          requestBudget: { maxPendingRequests: 2, maxQueueWaitMs: 10 },
        }),
      );
      const first = governor.execute(async () => firstGate);
      const second = governor.execute(async () => {
        secondExecuted = true;
      });
      const secondRejection = expect(second).rejects.toMatchObject({
        code: 'REQUEST_BUDGET_EXCEEDED',
        reason: 'queue-timeout',
      });

      await vi.advanceTimersByTimeAsync(10);
      await secondRejection;

      releaseFirst?.();
      await first;
      await vi.runAllTimersAsync();
      expect(secondExecuted).toBe(false);
      expect(governor.pendingRequests).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('opens an endpoint-specific circuit after repeated 429s', async () => {
    vi.useFakeTimers();

    try {
      const governor = new RequestGovernor(
        resolveRateLimitOptions({
          minIntervalMs: 0,
          cooldownMs: 0,
          recovery: false,
          requestBudget: {
            circuitBreakerThreshold: 2,
            circuitOpenMs: 50,
          },
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

      await expect(rejectFor('/limited')).rejects.toBeInstanceOf(RateLimitError);
      await expect(rejectFor('/limited')).rejects.toBeInstanceOf(RateLimitError);
      expect(governor.circuitRemainingMs).toBe(50);

      await expect(
        governor.execute(async () => 'blocked', undefined, '/limited'),
      ).rejects.toBeInstanceOf(RequestBudgetExceededError);
      await expect(governor.execute(async () => 'healthy', undefined, '/healthy')).resolves.toBe(
        'healthy',
      );

      await vi.advanceTimersByTimeAsync(50);
      await expect(governor.execute(async () => 'probe', undefined, '/limited')).resolves.toBe(
        'probe',
      );
      expect(governor.circuitRemainingMs).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects invalid recovery delays', () => {
    expect(() =>
      resolveRateLimitOptions({
        recoveryDelaysMs: [1_000, -1],
      }),
    ).toThrow(RangeError);
  });
});
