import { RateLimitError } from '../errors.js';
import type {
  RateLimitOptions,
  ResolvedAdaptivePacingOptions,
  ResolvedRateLimitOptions,
} from '../types.js';

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
  readonly intervalMs?: number;
  release(outcome?: RequestPacingOutcome): void | Promise<void>;
}

export type RequestPacingOutcome = 'success' | 'rate-limit' | 'error';

export interface SharedRequestPacer {
  acquireRequestPacingLease(
    baseIntervalMs: number,
    requestedIntervalMs: number,
    adaptivePacing: Readonly<ResolvedAdaptivePacingOptions>,
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
  const minIntervalMs = options.minIntervalMs ?? 2_500;
  const adaptivePacing = {
    enabled: options.adaptivePacing?.enabled ?? true,
    maxIntervalMs: options.adaptivePacing?.maxIntervalMs ?? Math.max(30_000, minIntervalMs),
    increaseFactor: options.adaptivePacing?.increaseFactor ?? 2,
    recoveryFactor: options.adaptivePacing?.recoveryFactor ?? 0.75,
    successThreshold: options.adaptivePacing?.successThreshold ?? 4,
  };
  const resolved: ResolvedRateLimitOptions = {
    enabled: options.enabled ?? true,
    minIntervalMs,
    adaptivePacing: Object.freeze(adaptivePacing),
    cooldownMs: options.cooldownMs ?? 60_000,
    recovery: options.recovery ?? true,
    recoveryDelaysMs: Object.freeze(recoveryDelaysMs),
  };

  if (!Number.isFinite(resolved.minIntervalMs) || resolved.minIntervalMs < 0) {
    throw new RangeError('rateLimit.minIntervalMs must be a non-negative number.');
  }

  if (
    !Number.isFinite(adaptivePacing.maxIntervalMs) ||
    adaptivePacing.maxIntervalMs < resolved.minIntervalMs
  ) {
    throw new RangeError(
      'rateLimit.adaptivePacing.maxIntervalMs must be at least rateLimit.minIntervalMs.',
    );
  }

  if (!Number.isFinite(adaptivePacing.increaseFactor) || adaptivePacing.increaseFactor <= 1) {
    throw new RangeError('rateLimit.adaptivePacing.increaseFactor must be greater than one.');
  }

  if (
    !Number.isFinite(adaptivePacing.recoveryFactor) ||
    adaptivePacing.recoveryFactor <= 0 ||
    adaptivePacing.recoveryFactor >= 1
  ) {
    throw new RangeError('rateLimit.adaptivePacing.recoveryFactor must be between zero and one.');
  }

  if (!Number.isInteger(adaptivePacing.successThreshold) || adaptivePacing.successThreshold <= 0) {
    throw new RangeError('rateLimit.adaptivePacing.successThreshold must be a positive integer.');
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
  #requestIntervalMs: number;
  #successfulRequests = 0;

  public constructor(options: ResolvedRateLimitOptions, sharedPacer?: SharedRequestPacer) {
    this.#options = options;
    this.#sharedPacer = sharedPacer;
    this.#requestIntervalMs = options.minIntervalMs;
  }

  public get requestIntervalMs(): number {
    return this.#requestIntervalMs;
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
      let pacingOutcome: RequestPacingOutcome = 'error';
      const state = this.#getState(resolvedKey);

      try {
        signal?.throwIfAborted();

        const allowedAt = Math.max(this.#nextStartAt, state.cooldownUntil);
        await wait(allowedAt - Date.now(), signal);
        signal?.throwIfAborted();

        sharedLease = await this.#sharedPacer?.acquireRequestPacingLease(
          this.#options.minIntervalMs,
          this.#requestIntervalMs,
          this.#options.adaptivePacing,
          signal,
        );
        this.#requestIntervalMs = Math.max(this.#requestIntervalMs, sharedLease?.intervalMs ?? 0);
        signal?.throwIfAborted();
        this.#nextStartAt = Date.now() + this.#requestIntervalMs;
        operationStarted = true;
        value = await operation();
        pacingOutcome = 'success';
        this.#endpointStates.delete(resolvedKey);
      } catch (error) {
        failed = true;
        failure = error;

        if (operationStarted && error instanceof RateLimitError) {
          pacingOutcome = 'rate-limit';
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

      if (operationStarted) {
        this.#recordPacingOutcome(pacingOutcome);
      }

      let releaseFailed = false;
      let releaseFailure: unknown;

      try {
        await sharedLease?.release(pacingOutcome);
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

  #recordPacingOutcome(outcome: RequestPacingOutcome): void {
    const adaptive = this.#options.adaptivePacing;

    if (!adaptive.enabled) {
      return;
    }

    if (outcome === 'rate-limit') {
      this.#successfulRequests = 0;
      this.#requestIntervalMs = Math.min(
        adaptive.maxIntervalMs,
        Math.max(
          this.#options.minIntervalMs,
          Math.ceil(this.#requestIntervalMs * adaptive.increaseFactor),
        ),
      );
      this.#nextStartAt = Math.max(this.#nextStartAt, Date.now() + this.#requestIntervalMs);
      return;
    }

    if (outcome !== 'success') {
      this.#successfulRequests = 0;
      return;
    }

    this.#successfulRequests += 1;

    if (this.#successfulRequests >= adaptive.successThreshold) {
      this.#successfulRequests = 0;
      this.#requestIntervalMs = Math.max(
        this.#options.minIntervalMs,
        Math.ceil(this.#requestIntervalMs * adaptive.recoveryFactor),
      );
    }
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
