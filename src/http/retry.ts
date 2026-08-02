import { setTimeout as sleep } from 'node:timers/promises';

import type { RetryOptions } from '../types.js';

export const DEFAULT_RETRY_OPTIONS: Readonly<RetryOptions> = Object.freeze({
  retries: 2,
  minDelayMs: 500,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: 0.2,
});

export function resolveRetryOptions(overrides: Partial<RetryOptions> = {}): RetryOptions {
  const options: RetryOptions = {
    ...DEFAULT_RETRY_OPTIONS,
    ...overrides,
  };

  if (!Number.isInteger(options.retries) || options.retries < 0) {
    throw new RangeError('retries must be a non-negative integer.');
  }

  if (!Number.isFinite(options.minDelayMs) || options.minDelayMs < 0) {
    throw new RangeError('minDelayMs must be a non-negative number.');
  }

  if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < options.minDelayMs) {
    throw new RangeError('maxDelayMs must be greater than or equal to minDelayMs.');
  }

  if (!Number.isFinite(options.factor) || options.factor < 1) {
    throw new RangeError('factor must be greater than or equal to 1.');
  }

  if (!Number.isFinite(options.jitter) || options.jitter < 0 || options.jitter > 1) {
    throw new RangeError('jitter must be between 0 and 1.');
  }

  return options;
}

export function calculateRetryDelay(
  retryIndex: number,
  options: RetryOptions,
  random: () => number = Math.random,
): number {
  const exponentialDelay = options.minDelayMs * options.factor ** retryIndex;

  const limitedDelay = Math.min(exponentialDelay, options.maxDelayMs);
  const variation = limitedDelay * options.jitter;
  const randomizedDelay = limitedDelay - variation + random() * variation * 2;

  return Math.max(0, Math.round(randomizedDelay));
}

interface RetryExecutionOptions extends Partial<RetryOptions> {
  signal: AbortSignal | undefined;
  shouldRetry: (error: unknown) => boolean;
  getRetryAfterMs?: (error: unknown) => number | undefined;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryExecutionOptions,
): Promise<T> {
  const retryOptions = resolveRetryOptions(options);

  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();

    try {
      return await operation(attempt);
    } catch (error) {
      const retriesExhausted = attempt >= retryOptions.retries;

      if (retriesExhausted || !options.shouldRetry(error)) {
        throw error;
      }

      const calculatedDelay = calculateRetryDelay(attempt, retryOptions);
      const retryAfterMs = options.getRetryAfterMs?.(error) ?? 0;
      const delayMs = Math.max(calculatedDelay, retryAfterMs);

      if (delayMs === 0) {
        continue;
      }

      const timerOptions =
        options.signal === undefined
          ? undefined
          : {
              signal: options.signal,
            };

      await sleep(delayMs, undefined, timerOptions);
    }
  }
}
