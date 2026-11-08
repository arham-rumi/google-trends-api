import { createHash, randomUUID } from 'node:crypto';

import type { CoordinatedCacheStore, ResolvedCacheCoordinationOptions } from '../cache/types.js';
import { RequestBudgetExceededError } from '../errors.js';
import type { ResolvedAdaptivePacingOptions, ResolvedRequestBudgetOptions } from '../types.js';
import type { RequestPacingOutcome } from './governor.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ADAPTIVE_PACING_STATE_TTL_MS = 24 * 60 * 60_000;
const CIRCUIT_STATE_TTL_MS = 60 * 60_000;

interface AdaptivePacingState {
  intervalMs: number;
  successfulRequests: number;
}

interface CircuitState {
  consecutiveRateLimits: number;
  openUntil: number;
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

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeTimestamp(value: Uint8Array | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const timestamp = Number(decoder.decode(value));
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function decodeAdaptivePacingState(value: Uint8Array | undefined): AdaptivePacingState | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const decoded: unknown = JSON.parse(decoder.decode(value));

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('intervalMs' in decoded) ||
      !('successfulRequests' in decoded) ||
      typeof decoded.intervalMs !== 'number' ||
      !Number.isFinite(decoded.intervalMs) ||
      decoded.intervalMs < 0 ||
      typeof decoded.successfulRequests !== 'number' ||
      !Number.isInteger(decoded.successfulRequests) ||
      decoded.successfulRequests < 0
    ) {
      return undefined;
    }

    return {
      intervalMs: decoded.intervalMs,
      successfulRequests: decoded.successfulRequests,
    };
  } catch {
    return undefined;
  }
}

function decodeCircuitState(value: Uint8Array | undefined): CircuitState | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const decoded: unknown = JSON.parse(decoder.decode(value));

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('consecutiveRateLimits' in decoded) ||
      !('openUntil' in decoded) ||
      typeof decoded.consecutiveRateLimits !== 'number' ||
      !Number.isInteger(decoded.consecutiveRateLimits) ||
      decoded.consecutiveRateLimits < 0 ||
      typeof decoded.openUntil !== 'number' ||
      !Number.isFinite(decoded.openUntil)
    ) {
      return undefined;
    }

    return {
      consecutiveRateLimits: decoded.consecutiveRateLimits,
      openUntil: decoded.openUntil,
    };
  } catch {
    return undefined;
  }
}

function normalizePath(path: string | URL): string {
  return new URL(path instanceof URL ? path.toString() : path, 'https://trends.google.com')
    .pathname;
}

export function isCoordinatedCacheStore(store: unknown): store is CoordinatedCacheStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof (store as Partial<CoordinatedCacheStore>).acquireLock === 'function' &&
    typeof (store as Partial<CoordinatedCacheStore>).refreshLock === 'function' &&
    typeof (store as Partial<CoordinatedCacheStore>).releaseLock === 'function'
  );
}

export class PersistentLease {
  readonly #store: CoordinatedCacheStore;
  readonly #key: string;
  readonly #owner: string;
  readonly #ttlMs: number;
  #released = false;
  #refreshPromise: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(store: CoordinatedCacheStore, key: string, owner: string, ttlMs: number) {
    this.#store = store;
    this.#key = key;
    this.#owner = owner;
    this.#ttlMs = ttlMs;
    this.#scheduleRefresh();
  }

  #scheduleRefresh(): void {
    const refreshAfterMs = Math.max(1, Math.floor(this.#ttlMs / 3));
    this.#timer = setTimeout(() => {
      this.#refreshPromise = this.#refresh();
      void this.#refreshPromise.catch(() => undefined);
    }, refreshAfterMs);
    this.#timer.unref?.();
  }

  async #refresh(): Promise<void> {
    if (this.#released) {
      return;
    }

    const refreshed = await this.#store.refreshLock(this.#key, this.#owner, this.#ttlMs);

    if (refreshed && !this.#released) {
      this.#scheduleRefresh();
    }
  }

  public async release(): Promise<void> {
    if (this.#released) {
      return;
    }

    this.#released = true;

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }

    await this.#refreshPromise;
    await this.#store.releaseLock(this.#key, this.#owner);
  }
}

class AdaptivePacingLease {
  public readonly intervalMs: number;

  readonly #lease: PersistentLease;
  readonly #store: CoordinatedCacheStore;
  readonly #stateKey: string;
  readonly #nextRequestAtKey: string;
  readonly #baseIntervalMs: number;
  readonly #adaptive: Readonly<ResolvedAdaptivePacingOptions>;
  readonly #state: AdaptivePacingState;
  readonly #requestBudget: Readonly<ResolvedRequestBudgetOptions>;
  readonly #circuitKey: string;
  readonly #circuitState: CircuitState;
  #released = false;

  public constructor(options: {
    lease: PersistentLease;
    store: CoordinatedCacheStore;
    stateKey: string;
    nextRequestAtKey: string;
    baseIntervalMs: number;
    adaptive: Readonly<ResolvedAdaptivePacingOptions>;
    state: AdaptivePacingState;
    requestBudget: Readonly<ResolvedRequestBudgetOptions>;
    circuitKey: string;
    circuitState: CircuitState;
  }) {
    this.#lease = options.lease;
    this.#store = options.store;
    this.#stateKey = options.stateKey;
    this.#nextRequestAtKey = options.nextRequestAtKey;
    this.#baseIntervalMs = options.baseIntervalMs;
    this.#adaptive = options.adaptive;
    this.#state = options.state;
    this.#requestBudget = options.requestBudget;
    this.#circuitKey = options.circuitKey;
    this.#circuitState = options.circuitState;
    this.intervalMs = options.state.intervalMs;
  }

  public async release(outcome: RequestPacingOutcome = 'error'): Promise<void> {
    if (this.#released) {
      return;
    }

    this.#released = true;
    let updateFailed = false;
    let updateFailure: unknown;

    if (this.#adaptive.enabled) {
      try {
        this.#recordOutcome(outcome);
        await this.#store.set(
          this.#stateKey,
          encoder.encode(JSON.stringify(this.#state)),
          ADAPTIVE_PACING_STATE_TTL_MS,
        );

        if (outcome === 'rate-limit') {
          const nextRequestAt = Date.now() + this.#state.intervalMs;
          await this.#store.set(
            this.#nextRequestAtKey,
            encoder.encode(String(nextRequestAt)),
            Math.max(1, this.#state.intervalMs),
          );
        }
      } catch (error) {
        updateFailed = true;
        updateFailure = error;
      }
    }

    if (this.#requestBudget.enabled) {
      try {
        if (outcome === 'success') {
          await this.#store.delete(this.#circuitKey);
        } else if (outcome === 'rate-limit') {
          this.#circuitState.consecutiveRateLimits += 1;

          if (
            this.#circuitState.consecutiveRateLimits >= this.#requestBudget.circuitBreakerThreshold
          ) {
            this.#circuitState.openUntil = Math.max(
              this.#circuitState.openUntil,
              Date.now() + this.#requestBudget.circuitOpenMs,
            );
          }

          await this.#store.set(
            this.#circuitKey,
            encoder.encode(JSON.stringify(this.#circuitState)),
            Math.max(CIRCUIT_STATE_TTL_MS, this.#requestBudget.circuitOpenMs),
          );
        }
      } catch (error) {
        if (!updateFailed) {
          updateFailed = true;
          updateFailure = error;
        }
      }
    }

    let releaseFailed = false;
    let releaseFailure: unknown;

    try {
      await this.#lease.release();
    } catch (error) {
      releaseFailed = true;
      releaseFailure = error;
    }

    if (updateFailed) {
      throw updateFailure;
    }

    if (releaseFailed) {
      throw releaseFailure;
    }
  }

  #recordOutcome(outcome: RequestPacingOutcome): void {
    if (outcome === 'rate-limit') {
      this.#state.successfulRequests = 0;
      this.#state.intervalMs = Math.min(
        this.#adaptive.maxIntervalMs,
        Math.max(
          this.#baseIntervalMs,
          Math.ceil(this.#state.intervalMs * this.#adaptive.increaseFactor),
        ),
      );
      return;
    }

    if (outcome !== 'success') {
      this.#state.successfulRequests = 0;
      return;
    }

    this.#state.successfulRequests += 1;

    if (this.#state.successfulRequests >= this.#adaptive.successThreshold) {
      this.#state.successfulRequests = 0;
      this.#state.intervalMs = Math.max(
        this.#baseIntervalMs,
        Math.ceil(this.#state.intervalMs * this.#adaptive.recoveryFactor),
      );
    }
  }
}

export class PersistentCoordinator {
  readonly #store: CoordinatedCacheStore;
  readonly #options: Readonly<ResolvedCacheCoordinationOptions>;
  readonly #keyPrefix: string;
  readonly #observedCooldowns = new Map<string, number>();

  public constructor(
    store: CoordinatedCacheStore,
    keyPrefix: string,
    options: Readonly<ResolvedCacheCoordinationOptions>,
  ) {
    this.#store = store;
    this.#options = options;
    this.#keyPrefix = `${keyPrefix}coordination:v1:`;
  }

  public get observedCooldownRemainingMs(): number {
    const now = Date.now();
    let remainingMs = 0;

    for (const cooldownUntil of this.#observedCooldowns.values()) {
      remainingMs = Math.max(remainingMs, cooldownUntil - now);
    }

    return Math.max(0, remainingMs);
  }

  #requestLockKey(requestKey: string): string {
    return `${this.#keyPrefix}request:${digest(requestKey)}`;
  }

  #cooldownKey(path: string): string {
    return `${this.#keyPrefix}cooldown:${digest(path)}`;
  }

  #cooldownLockKey(path: string): string {
    return `${this.#keyPrefix}cooldown-lock:${digest(path)}`;
  }

  #requestPacingLockKey(): string {
    return `${this.#keyPrefix}request-pacing-lock`;
  }

  #nextRequestAtKey(): string {
    return `${this.#keyPrefix}next-request-at`;
  }

  #adaptivePacingStateKey(): string {
    return `${this.#keyPrefix}adaptive-pacing-state`;
  }

  #circuitStateKey(rateLimitKey: string): string {
    return `${this.#keyPrefix}circuit:${digest(rateLimitKey)}`;
  }

  public async tryAcquireRequest(requestKey: string): Promise<PersistentLease | undefined> {
    const key = this.#requestLockKey(requestKey);
    const owner = randomUUID();
    const acquired = await this.#store.acquireLock(key, owner, this.#options.lockTtlMs);

    return acquired
      ? new PersistentLease(this.#store, key, owner, this.#options.lockTtlMs)
      : undefined;
  }

  public waitForPoll(signal?: AbortSignal): Promise<void> {
    return wait(this.#options.pollIntervalMs, signal);
  }

  public async acquireRequestPacingLease(
    baseIntervalMs: number,
    requestedIntervalMs: number,
    adaptivePacing: Readonly<ResolvedAdaptivePacingOptions>,
    requestBudget: Readonly<ResolvedRequestBudgetOptions>,
    rateLimitKey: string,
    signal?: AbortSignal,
  ): Promise<AdaptivePacingLease> {
    const lockKey = this.#requestPacingLockKey();
    const owner = randomUUID();
    let lease: PersistentLease | undefined;

    while (lease === undefined) {
      signal?.throwIfAborted();

      if (await this.#store.acquireLock(lockKey, owner, this.#options.lockTtlMs)) {
        lease = new PersistentLease(this.#store, lockKey, owner, this.#options.lockTtlMs);
      } else {
        await this.waitForPoll(signal);
      }
    }

    try {
      const nextRequestAt = decodeTimestamp(await this.#store.get(this.#nextRequestAtKey())) ?? 0;
      const storedState = decodeAdaptivePacingState(
        await this.#store.get(this.#adaptivePacingStateKey()),
      );
      const circuitKey = this.#circuitStateKey(rateLimitKey);
      const circuitState = decodeCircuitState(await this.#store.get(circuitKey)) ?? {
        consecutiveRateLimits: 0,
        openUntil: 0,
      };

      if (requestBudget.enabled && circuitState.openUntil > Date.now()) {
        throw new RequestBudgetExceededError({
          reason: 'circuit-open',
          retryAfterMs: circuitState.openUntil - Date.now(),
        });
      }
      const intervalMs = adaptivePacing.enabled
        ? Math.min(
            adaptivePacing.maxIntervalMs,
            Math.max(baseIntervalMs, requestedIntervalMs, storedState?.intervalMs ?? 0),
          )
        : requestedIntervalMs;
      const state: AdaptivePacingState = {
        intervalMs,
        successfulRequests: storedState?.successfulRequests ?? 0,
      };

      await wait(nextRequestAt - Date.now(), signal);
      signal?.throwIfAborted();

      const nextStart = Date.now() + intervalMs;
      await this.#store.set(
        this.#nextRequestAtKey(),
        encoder.encode(String(nextStart)),
        Math.max(1, intervalMs),
      );

      return new AdaptivePacingLease({
        lease,
        store: this.#store,
        stateKey: this.#adaptivePacingStateKey(),
        nextRequestAtKey: this.#nextRequestAtKey(),
        baseIntervalMs,
        adaptive: adaptivePacing,
        state,
        requestBudget,
        circuitKey,
        circuitState,
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  public async getCooldownRemainingMs(path: string | URL): Promise<number> {
    const normalizedPath = normalizePath(path);
    const key = this.#cooldownKey(normalizedPath);
    const value = await this.#store.get(key);
    const cooldownUntil = decodeTimestamp(value);

    if (value !== undefined && cooldownUntil === undefined) {
      this.#observedCooldowns.delete(normalizedPath);
      return 0;
    }

    if (cooldownUntil === undefined || cooldownUntil <= Date.now()) {
      this.#observedCooldowns.delete(normalizedPath);
      return 0;
    }

    this.#observedCooldowns.set(normalizedPath, cooldownUntil);
    return cooldownUntil - Date.now();
  }

  public async getMaximumCooldownRemainingMs(paths: readonly (string | URL)[]): Promise<number> {
    const remaining = await Promise.all(paths.map((path) => this.getCooldownRemainingMs(path)));

    return Math.max(0, ...remaining);
  }

  public async waitForCooldown(
    paths: readonly (string | URL)[],
    signal?: AbortSignal,
  ): Promise<void> {
    while (true) {
      const remainingMs = await this.getMaximumCooldownRemainingMs(paths);

      if (remainingMs <= 0) {
        signal?.throwIfAborted();
        return;
      }

      await wait(remainingMs, signal);
    }
  }

  public async extendCooldown(
    path: string | URL,
    cooldownUntil: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const normalizedPath = normalizePath(path);

    if (cooldownUntil <= Date.now()) {
      return;
    }

    const lockKey = this.#cooldownLockKey(normalizedPath);
    const owner = randomUUID();
    let lease: PersistentLease | undefined;

    while (lease === undefined) {
      if (await this.#store.acquireLock(lockKey, owner, this.#options.lockTtlMs)) {
        lease = new PersistentLease(this.#store, lockKey, owner, this.#options.lockTtlMs);
      } else {
        await this.waitForPoll(signal);
      }
    }

    try {
      const key = this.#cooldownKey(normalizedPath);
      const storedUntil = decodeTimestamp(await this.#store.get(key)) ?? 0;
      const resolvedUntil = Math.max(storedUntil, cooldownUntil);
      const ttlMs = Math.max(1, resolvedUntil - Date.now());

      await this.#store.set(key, encoder.encode(String(resolvedUntil)), ttlMs);
      this.#observedCooldowns.set(normalizedPath, resolvedUntil);
    } finally {
      await lease.release();
    }
  }
}
