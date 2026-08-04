import { RateLimitError } from '../errors.js';
import type { RateLimitOptions, ResolvedRateLimitOptions } from '../types.js';

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    signal?.throwIfAborted();
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function resolveRateLimitOptions(options: RateLimitOptions = {}): ResolvedRateLimitOptions {
  const resolved: ResolvedRateLimitOptions = {
    enabled: options.enabled ?? true,
    minIntervalMs: options.minIntervalMs ?? 2_500,
    cooldownMs: options.cooldownMs ?? 60_000,
  };

  if (!Number.isFinite(resolved.minIntervalMs) || resolved.minIntervalMs < 0) {
    throw new RangeError('rateLimit.minIntervalMs must be a non-negative number.');
  }

  if (!Number.isFinite(resolved.cooldownMs) || resolved.cooldownMs < 0) {
    throw new RangeError('rateLimit.cooldownMs must be a non-negative number.');
  }

  return resolved;
}

export class RequestGovernor {
  readonly #options: Readonly<ResolvedRateLimitOptions>;
  #tail: Promise<void> = Promise.resolve();
  #nextStartAt = 0;
  #cooldownUntil = 0;

  public constructor(options: ResolvedRateLimitOptions) {
    this.#options = options;
  }

  public get cooldownRemainingMs(): number {
    return Math.max(0, this.#cooldownUntil - Date.now());
  }

  public execute<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.#options.enabled) {
      return operation();
    }

    const run = async (): Promise<T> => {
      signal?.throwIfAborted();

      const allowedAt = Math.max(this.#nextStartAt, this.#cooldownUntil);
      await wait(allowedAt - Date.now(), signal);
      signal?.throwIfAborted();

      this.#nextStartAt = Date.now() + this.#options.minIntervalMs;

      try {
        return await operation();
      } catch (error) {
        if (error instanceof RateLimitError) {
          const cooldownMs = error.retryAfterMs ?? this.#options.cooldownMs;
          this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + cooldownMs);
        }

        throw error;
      }
    };

    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}
