import { RateLimitError } from '../errors.js';
import type { RateLimitOptions, ResolvedRateLimitOptions } from '../types.js';

export const DEFAULT_RATE_LIMIT_RECOVERY_DELAYS_MS = Object.freeze([
  60_000,
  2 * 60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  20 * 60_000,
  25 * 60_000,
  30 * 60_000,
] as const);

const DEFAULT_RATE_LIMIT_KEY = '__default__';

interface EndpointRateLimitState {
  consecutiveRateLimits: number;
  cooldownUntil: number;
}

export interface SharedRequestLease {
  release(): void | Promise<void>;
}

export interface SharedRequestPacer {
  acquireRequestPacingLease(
    minIntervalMs: number,
    signal?: AbortSignal,
  ): Promise<SharedRequestLease>;
}

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
  const recoveryDelaysMs = [...(options.recoveryDelaysMs ?? DEFAULT_RATE_LIMIT_RECOVERY_DELAYS_MS)];
  const resolved: ResolvedRateLimitOptions = {
    enabled: options.enabled ?? true,
    minIntervalMs: options.minIntervalMs ?? 2_500,
    cooldownMs: options.cooldownMs ?? 60_000,
    recovery: options.recovery ?? true,
    recoveryDelaysMs: Object.freeze(recoveryDelaysMs),
  };

  if (!Number.isFinite(resolved.minIntervalMs) || resolved.minIntervalMs < 0) {
    throw new RangeError('rateLimit.minIntervalMs must be a non-negative number.');
  }

  if (!Number.isFinite(resolved.cooldownMs) || resolved.cooldownMs < 0) {
    throw new RangeError('rateLimit.cooldownMs must be a non-negative number.');
  }

  for (const delayMs of resolved.recoveryDelaysMs) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError('rateLimit.recoveryDelaysMs must contain only non-negative numbers.');
    }
  }

  return resolved;
}

export class RequestGovernor {
  readonly #options: Readonly<ResolvedRateLimitOptions>;
  readonly #sharedPacer: SharedRequestPacer | undefined;
  readonly #endpointStates = new Map<string, EndpointRateLimitState>();
  #tail: Promise<void> = Promise.resolve();
  #nextStartAt = 0;

  public constructor(options: ResolvedRateLimitOptions, sharedPacer?: SharedRequestPacer) {
    this.#options = options;
    this.#sharedPacer = sharedPacer;
  }

  public get cooldownRemainingMs(): number {
    let remainingMs = 0;

    for (const state of this.#endpointStates.values()) {
      remainingMs = Math.max(remainingMs, state.cooldownUntil - Date.now());
    }

    return Math.max(0, remainingMs);
  }

  public getCooldownRemainingMs(rateLimitKey?: string): number {
    const state = this.#endpointStates.get(this.#resolveKey(rateLimitKey));
    return Math.max(0, (state?.cooldownUntil ?? 0) - Date.now());
  }

  public async waitForCooldown(signal?: AbortSignal, rateLimitKey?: string): Promise<void> {
    const remainingMs = (): number =>
      rateLimitKey === undefined
        ? this.cooldownRemainingMs
        : this.getCooldownRemainingMs(rateLimitKey);

    while (remainingMs() > 0) {
      await wait(remainingMs(), signal);
    }
  }

  public markOperationSucceeded(rateLimitKey?: string): void {
    this.#endpointStates.delete(this.#resolveKey(rateLimitKey));
  }

  public execute<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
    rateLimitKey?: string,
  ): Promise<T> {
    if (!this.#options.enabled) {
      return operation();
    }

    const resolvedKey = this.#resolveKey(rateLimitKey);
    const run = async (): Promise<T> => {
      let sharedLease: SharedRequestLease | undefined;
      let failed = false;
      let failure: unknown;
      let operationStarted = false;
      let value: T | undefined;
      const state = this.#getState(resolvedKey);

      try {
        signal?.throwIfAborted();

        const allowedAt = Math.max(this.#nextStartAt, state.cooldownUntil);
        await wait(allowedAt - Date.now(), signal);
        signal?.throwIfAborted();

        sharedLease = await this.#sharedPacer?.acquireRequestPacingLease(
          this.#options.minIntervalMs,
          signal,
        );
        signal?.throwIfAborted();
        this.#nextStartAt = Date.now() + this.#options.minIntervalMs;
        operationStarted = true;
        value = await operation();
        this.#endpointStates.delete(resolvedKey);
      } catch (error) {
        failed = true;
        failure = error;

        if (operationStarted && error instanceof RateLimitError) {
          const configuredDelay = this.#options.recovery
            ? this.#options.recoveryDelaysMs[
                Math.min(
                  state.consecutiveRateLimits,
                  Math.max(0, this.#options.recoveryDelaysMs.length - 1),
                )
              ]
            : undefined;
          const fallbackDelay = configuredDelay ?? this.#options.cooldownMs;
          const cooldownMs = Math.max(error.retryAfterMs ?? 0, fallbackDelay);

          state.consecutiveRateLimits += 1;
          state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldownMs);
          this.#endpointStates.set(resolvedKey, state);
        }
      }

      let releaseFailed = false;
      let releaseFailure: unknown;

      try {
        await sharedLease?.release();
      } catch (error) {
        releaseFailed = true;
        releaseFailure = error;
      }

      if (failed) {
        throw failure;
      }

      if (releaseFailed) {
        throw releaseFailure;
      }

      return value as T;
    };

    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  #resolveKey(rateLimitKey?: string): string {
    return rateLimitKey ?? DEFAULT_RATE_LIMIT_KEY;
  }

  #getState(rateLimitKey: string): EndpointRateLimitState {
    return (
      this.#endpointStates.get(rateLimitKey) ?? {
        consecutiveRateLimits: 0,
        cooldownUntil: 0,
      }
    );
  }
}
