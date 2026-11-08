import { RateLimitError, RequestBudgetExceededError } from '../errors.js';
import type {
  RateLimitOptions,
  ResolvedAdaptivePacingOptions,
  ResolvedRateLimitOptions,
  ResolvedRequestBudgetOptions,
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
  circuitOpenUntil: number;
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
    requestBudget: Readonly<ResolvedRequestBudgetOptions>,
    rateLimitKey: string,
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
  const requestBudget = {
    enabled: options.requestBudget?.enabled ?? true,
    maxPendingRequests: options.requestBudget?.maxPendingRequests ?? 100,
    maxQueueWaitMs: options.requestBudget?.maxQueueWaitMs ?? 2 * 60_000,
    circuitBreakerThreshold: options.requestBudget?.circuitBreakerThreshold ?? 3,
    circuitOpenMs: options.requestBudget?.circuitOpenMs ?? 5 * 60_000,
  };
  const resolved: ResolvedRateLimitOptions = {
    enabled: options.enabled ?? true,
    minIntervalMs,
    adaptivePacing: Object.freeze(adaptivePacing),
    requestBudget: Object.freeze(requestBudget),
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

  if (
    !Number.isInteger(requestBudget.maxPendingRequests) ||
    requestBudget.maxPendingRequests <= 0
  ) {
    throw new RangeError('rateLimit.requestBudget.maxPendingRequests must be a positive integer.');
  }

  if (!Number.isFinite(requestBudget.maxQueueWaitMs) || requestBudget.maxQueueWaitMs <= 0) {
    throw new RangeError('rateLimit.requestBudget.maxQueueWaitMs must be greater than zero.');
  }

  if (
    !Number.isInteger(requestBudget.circuitBreakerThreshold) ||
    requestBudget.circuitBreakerThreshold <= 0
  ) {
    throw new RangeError(
      'rateLimit.requestBudget.circuitBreakerThreshold must be a positive integer.',
    );
  }

  if (!Number.isFinite(requestBudget.circuitOpenMs) || requestBudget.circuitOpenMs <= 0) {
    throw new RangeError('rateLimit.requestBudget.circuitOpenMs must be greater than zero.');
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
  #pendingRequests = 0;

  public constructor(options: ResolvedRateLimitOptions, sharedPacer?: SharedRequestPacer) {
    this.#options = options;
    this.#sharedPacer = sharedPacer;
    this.#requestIntervalMs = options.minIntervalMs;
  }

  public get requestIntervalMs(): number {
    return this.#requestIntervalMs;
  }

  public get pendingRequests(): number {
    return this.#pendingRequests;
  }

  public get circuitRemainingMs(): number {
    let remainingMs = 0;

    for (const state of this.#endpointStates.values()) {
      remainingMs = Math.max(remainingMs, state.circuitOpenUntil - Date.now());
    }

    return Math.max(0, remainingMs);
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
    const state = this.#getState(resolvedKey);
    const budget = this.#options.requestBudget;

    if (budget.enabled) {
      const circuitError = this.#getCircuitError(state);

      if (circuitError !== undefined) {
        return Promise.reject(circuitError);
      }

      if (this.#pendingRequests >= budget.maxPendingRequests) {
        return Promise.reject(
          new RequestBudgetExceededError({
            reason: 'queue-full',
            pendingRequests: this.#pendingRequests,
            maxPendingRequests: budget.maxPendingRequests,
            retryAfterMs: this.#requestIntervalMs,
          }),
        );
      }
    }

    this.#pendingRequests += 1;
    const admissionController = new AbortController();
    const admissionSignal =
      signal === undefined
        ? admissionController.signal
        : AbortSignal.any([signal, admissionController.signal]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout: ((error: RequestBudgetExceededError) => void) | undefined;
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      rejectTimeout = reject;
    });

    if (budget.enabled) {
      timeout = setTimeout(() => {
        const error = new RequestBudgetExceededError({
          reason: 'queue-timeout',
          pendingRequests: this.#pendingRequests,
          maxPendingRequests: budget.maxPendingRequests,
          retryAfterMs: this.#requestIntervalMs,
        });

        admissionController.abort(error);
        rejectTimeout?.(error);
      }, budget.maxQueueWaitMs);
      timeout.unref?.();
    }

    const clearAdmissionTimeout = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };
    const run = async (): Promise<T> => {
      let sharedLease: SharedRequestLease | undefined;
      let failed = false;
      let failure: unknown;
      let operationStarted = false;
      let value: T | undefined;
      let pacingOutcome: RequestPacingOutcome = 'error';

      try {
        admissionSignal.throwIfAborted();

        if (budget.enabled) {
          const circuitError = this.#getCircuitError(state);
          if (circuitError !== undefined) {
            throw circuitError;
          }
        }

        const allowedAt = Math.max(this.#nextStartAt, state.cooldownUntil);
        await wait(allowedAt - Date.now(), admissionSignal);
        admissionSignal.throwIfAborted();

        sharedLease = await this.#sharedPacer?.acquireRequestPacingLease(
          this.#options.minIntervalMs,
          this.#requestIntervalMs,
          this.#options.adaptivePacing,
          budget,
          resolvedKey,
          admissionSignal,
        );
        this.#requestIntervalMs = Math.max(this.#requestIntervalMs, sharedLease?.intervalMs ?? 0);
        admissionSignal.throwIfAborted();
        clearAdmissionTimeout();
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
          if (budget.enabled && state.consecutiveRateLimits >= budget.circuitBreakerThreshold) {
            state.circuitOpenUntil = Math.max(
              state.circuitOpenUntil,
              Date.now() + budget.circuitOpenMs,
            );
          }
          this.#endpointStates.set(resolvedKey, state);
        }
      }

      if (!operationStarted) {
        clearAdmissionTimeout();
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

    const scheduled = this.#tail.then(run, run);
    this.#tail = scheduled.then(
      () => undefined,
      () => undefined,
    );

    void scheduled.then(
      () => {
        this.#pendingRequests -= 1;
      },
      () => {
        this.#pendingRequests -= 1;
      },
    );

    return budget.enabled ? Promise.race([scheduled, timeoutPromise]) : scheduled;
  }

  #resolveKey(rateLimitKey?: string): string {
    return rateLimitKey ?? DEFAULT_RATE_LIMIT_KEY;
  }

  #getCircuitError(state: EndpointRateLimitState): RequestBudgetExceededError | undefined {
    const retryAfterMs = Math.max(0, state.circuitOpenUntil - Date.now());

    return retryAfterMs > 0
      ? new RequestBudgetExceededError({ reason: 'circuit-open', retryAfterMs })
      : undefined;
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
        circuitOpenUntil: 0,
      }
    );
  }
}
