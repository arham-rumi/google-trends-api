import { MemoryCache } from './cache/memory-cache.js';
import type { CacheLookup, ResolvedCacheOptions } from './cache/types.js';
import { HttpStatusError, InvalidResponseError, RateLimitError } from './errors.js';
import {
  fetchAutocomplete,
  type AutocompleteOptions,
  type AutocompleteResult,
} from './google/autocomplete.js';
import {
  fetchInterestByRegion,
  type InterestByRegionOptions,
  type InterestByRegionResult,
} from './google/interest-by-region.js';
import {
  fetchInterestOverTime,
  type InterestOverTimeOptions,
  type InterestOverTimeResult,
} from './google/interest-over-time.js';
import {
  fetchRelatedQueries,
  fetchRelatedTopics,
  type RelatedQueriesResult,
  type RelatedSearchesOptions,
  type RelatedTopicsResult,
} from './google/related-searches.js';
import {
  fetchTrendingNow,
  type TrendingNowOptions,
  type TrendingNowResult,
} from './google/trending-now.js';
import { HttpSession, type HttpSessionWarmupOptions } from './http/session.js';
import { createRequestKey } from './rate-limit/request-key.js';
import { resolveRateLimitOptions } from './rate-limit/governor.js';
import { attachResultMetadata, type ResultMetadata } from './result-metadata.js';
import type { GoogleTrendsClientOptions, ResolvedGoogleTrendsClientOptions } from './types.js';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface OperationOutcome<T extends object> {
  value: T;
  source: ResultMetadata['source'];
  cachedAt?: number;
}

interface InflightEntry<T extends object> {
  controller: AbortController;
  promise: Promise<OperationOutcome<T>>;
  waiters: number;
  settled: boolean;
}

function inferRegionFromLocale(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).region;
  } catch {
    return undefined;
  }
}

function resolveCacheOptions(
  options: GoogleTrendsClientOptions['cache'] = {},
): ResolvedCacheOptions {
  const resolved: ResolvedCacheOptions = {
    enabled: options.enabled ?? true,
    ttlMs: options.ttlMs ?? 15 * 60_000,
    staleIfErrorMs: options.staleIfErrorMs ?? 24 * 60 * 60_000,
    maxEntries: options.maxEntries ?? 100,
  };

  if (!Number.isFinite(resolved.ttlMs) || resolved.ttlMs < 0) {
    throw new RangeError('cache.ttlMs must be a non-negative number.');
  }

  if (!Number.isFinite(resolved.staleIfErrorMs) || resolved.staleIfErrorMs < 0) {
    throw new RangeError('cache.staleIfErrorMs must be a non-negative number.');
  }

  if (!Number.isInteger(resolved.maxEntries) || resolved.maxEntries <= 0) {
    throw new RangeError('cache.maxEntries must be a positive integer.');
  }

  return resolved;
}

function resolveOptions(options: GoogleTrendsClientOptions): ResolvedGoogleTrendsClientOptions {
  const resolved: ResolvedGoogleTrendsClientOptions = {
    locale: options.locale ?? 'en-US',
    timezone: options.timezone ?? 0,
    timeoutMs: options.timeoutMs ?? 10_000,
    retries: options.retries ?? 2,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    rateLimit: Object.freeze(resolveRateLimitOptions(options.rateLimit)),
    cache: Object.freeze(resolveCacheOptions(options.cache)),
  };

  if (resolved.locale.trim().length === 0) {
    throw new RangeError('locale cannot be empty.');
  }

  if (!Number.isInteger(resolved.timezone) || resolved.timezone < -840 || resolved.timezone > 840) {
    throw new RangeError('timezone must be an integer between -840 and 840 minutes.');
  }

  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be greater than zero.');
  }

  if (!Number.isInteger(resolved.retries) || resolved.retries < 0) {
    throw new RangeError('retries must be a non-negative integer.');
  }

  return resolved;
}

function shouldWarmupAfter(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return error.status === 401 || error.status === 403;
  }

  if (!(error instanceof InvalidResponseError)) {
    return false;
  }

  if (error.contentType?.toLowerCase().includes('text/html') === true) {
    return true;
  }

  return /^\s*(?:<!doctype\s+html|<html|<head|<body)\b/i.test(error.responseBody ?? '');
}

function withoutSignal<T extends { signal?: AbortSignal }>(input: T): Omit<T, 'signal'> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'signal')) as Omit<
    T,
    'signal'
  >;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export class GoogleTrendsClient {
  public readonly options: Readonly<ResolvedGoogleTrendsClientOptions>;

  readonly #session: HttpSession;
  readonly #cache: MemoryCache;
  readonly #inflight = new Map<string, InflightEntry<object>>();
  #warmupPromise: Promise<void> | undefined;

  public constructor(options: GoogleTrendsClientOptions = {}) {
    this.options = Object.freeze(resolveOptions(options));
    this.#cache = new MemoryCache(this.options.cache);

    this.#session = new HttpSession({
      baseUrl: GOOGLE_TRENDS_BASE_URL,
      timeoutMs: this.options.timeoutMs,
      retry: {
        retries: this.options.retries,
      },
      rateLimit: this.options.rateLimit,
      headers: {
        accept: 'application/json,text/plain,*/*',
        'accept-language': `${this.options.locale},en;q=0.9`,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        referer: `${GOOGLE_TRENDS_BASE_URL}/explore`,
        'user-agent': this.options.userAgent,
      },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  public get cacheSize(): number {
    return this.#cache.size;
  }

  public get cooldownRemainingMs(): number {
    return this.#session.cooldownRemainingMs;
  }

  public clearCache(): void {
    this.#cache.clear();
  }

  #createWarmupOptions(signal?: AbortSignal): HttpSessionWarmupOptions {
    const geo = inferRegionFromLocale(this.options.locale);

    return {
      locale: this.options.locale,
      ...(geo === undefined ? {} : { geo }),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  #ensureWarmup(): Promise<void> {
    this.#warmupPromise ??= this.#session.warmup(this.#createWarmupOptions()).catch((error) => {
      this.#warmupPromise = undefined;
      throw error;
    });

    return this.#warmupPromise;
  }

  async #runTokenizedOnce<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await operation(signal);
    } catch (error) {
      if (!shouldWarmupAfter(error)) {
        throw error;
      }

      signal.throwIfAborted();
      await this.#ensureWarmup();
      signal.throwIfAborted();
      return operation(signal);
    }
  }

  async #refreshSession(signal: AbortSignal): Promise<void> {
    await this.#session.waitForCooldown(signal);
    signal.throwIfAborted();

    this.#session.resetCookies();
    this.#warmupPromise = undefined;

    await this.#session.warmup(this.#createWarmupOptions(signal));
    signal.throwIfAborted();
  }

  async #runTokenized<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    recoverRateLimits: boolean,
  ): Promise<T> {
    const recoveryEnabled =
      recoverRateLimits && this.options.rateLimit.enabled && this.options.rateLimit.recovery;
    const maxRecoveryAttempts = this.options.rateLimit.recoveryDelaysMs.length;
    let recoveryAttempts = 0;
    let refreshSession = false;

    while (true) {
      try {
        if (refreshSession) {
          await this.#refreshSession(signal);
          refreshSession = false;
        }

        const value = await this.#runTokenizedOnce(operation, signal);
        this.#session.markOperationSucceeded();
        return value;
      } catch (error) {
        if (
          !(error instanceof RateLimitError) ||
          !recoveryEnabled ||
          recoveryAttempts >= maxRecoveryAttempts
        ) {
          throw error;
        }

        recoveryAttempts += 1;
        refreshSession = true;
      }
    }
  }

  #materialize<T extends object>(outcome: OperationOutcome<T>): T {
    const value = structuredClone(outcome.value);

    return attachResultMetadata(value, {
      source: outcome.source,
      stale: outcome.source === 'stale-cache',
      ...(outcome.cachedAt === undefined ? {} : { cachedAt: new Date(outcome.cachedAt) }),
    });
  }

  #joinInflight<T extends object>(entry: InflightEntry<T>, signal?: AbortSignal): Promise<T> {
    entry.waiters += 1;

    return new Promise<T>((resolve, reject) => {
      let completed = false;

      const finish = (callback: () => void): void => {
        if (completed) {
          return;
        }

        completed = true;
        signal?.removeEventListener('abort', onAbort);
        entry.waiters -= 1;

        if (entry.waiters === 0 && !entry.settled) {
          entry.controller.abort(new DOMException('All request consumers aborted.', 'AbortError'));
        }

        callback();
      };

      const onAbort = (): void => {
        finish(() => reject(signal === undefined ? undefined : abortReason(signal)));
      };

      if (signal?.aborted === true) {
        onAbort();
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });

      entry.promise.then(
        (outcome) => finish(() => resolve(this.#materialize(outcome))),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  #cacheOutcome<T extends object>(lookup: CacheLookup<T>): OperationOutcome<T> {
    return {
      value: lookup.value,
      source: lookup.state === 'fresh' ? 'cache' : 'stale-cache',
      cachedAt: lookup.cachedAt,
    };
  }

  #execute<T extends object>(options: {
    method: string;
    input: { signal?: AbortSignal };
    tokenized: boolean;
    operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    const signal = options.input.signal;
    signal?.throwIfAborted();

    const key = createRequestKey(options.method, {
      locale: this.options.locale,
      timezone: this.options.timezone,
      input: withoutSignal(options.input),
    });
    const cached = this.#cache.get<T>(key);

    if (cached?.state === 'fresh') {
      return Promise.resolve(this.#materialize(this.#cacheOutcome(cached)));
    }

    if (cached?.state === 'stale' && this.#session.cooldownRemainingMs > 0) {
      return Promise.resolve(this.#materialize(this.#cacheOutcome(cached)));
    }

    const existing = this.#inflight.get(key) as InflightEntry<T> | undefined;

    if (existing !== undefined) {
      return this.#joinInflight(existing, signal);
    }

    const controller = new AbortController();
    const promise = (async (): Promise<OperationOutcome<T>> => {
      try {
        const value = options.tokenized
          ? await this.#runTokenized(
              options.operation,
              controller.signal,
              cached?.state !== 'stale',
            )
          : await options.operation(controller.signal);

        this.#cache.set(key, value);

        return {
          value,
          source: 'network',
        };
      } catch (error) {
        if (error instanceof RateLimitError && cached?.state === 'stale') {
          return this.#cacheOutcome(cached);
        }

        throw error;
      }
    })();
    const entry: InflightEntry<T> = {
      controller,
      promise,
      waiters: 0,
      settled: false,
    };

    this.#inflight.set(key, entry as InflightEntry<object>);

    const settle = (): void => {
      entry.settled = true;
      this.#inflight.delete(key);
    };

    promise.then(settle, settle);

    return this.#joinInflight(entry, signal);
  }

  /** Establishes the Google Trends session and collects cookies. */
  public warmup(signal?: AbortSignal): Promise<void> {
    if (signal !== undefined) {
      return this.#session.warmup(this.#createWarmupOptions(signal));
    }

    return this.#ensureWarmup();
  }

  /** Returns normalized Google Trends interest values over time. */
  public interestOverTime(input: InterestOverTimeOptions): Promise<InterestOverTimeResult> {
    return this.#execute({
      method: 'interestOverTime',
      input,
      tokenized: true,
      operation: (signal) =>
        fetchInterestOverTime(this.#session, {
          ...input,
          signal,
          locale: this.options.locale,
          timezone: this.options.timezone,
        }),
    });
  }

  /** Returns normalized Google Trends interest values by geographic area. */
  public interestByRegion(input: InterestByRegionOptions): Promise<InterestByRegionResult> {
    return this.#execute({
      method: 'interestByRegion',
      input,
      tokenized: true,
      operation: (signal) =>
        fetchInterestByRegion(this.#session, {
          ...input,
          signal,
          locale: this.options.locale,
          timezone: this.options.timezone,
        }),
    });
  }

  /** Returns top and rising searches related to each keyword. */
  public relatedQueries(input: RelatedSearchesOptions): Promise<RelatedQueriesResult[]> {
    return this.#execute({
      method: 'relatedQueries',
      input,
      tokenized: true,
      operation: (signal) =>
        fetchRelatedQueries(this.#session, {
          ...input,
          signal,
          locale: this.options.locale,
          timezone: this.options.timezone,
        }),
    });
  }

  /** Returns top and rising topics related to each keyword. */
  public relatedTopics(input: RelatedSearchesOptions): Promise<RelatedTopicsResult[]> {
    return this.#execute({
      method: 'relatedTopics',
      input,
      tokenized: true,
      operation: (signal) =>
        fetchRelatedTopics(this.#session, {
          ...input,
          signal,
          locale: this.options.locale,
          timezone: this.options.timezone,
        }),
    });
  }

  /** Returns Google Trends search-term and topic suggestions. */
  public autocomplete(input: AutocompleteOptions): Promise<AutocompleteResult> {
    return this.#execute({
      method: 'autocomplete',
      input,
      tokenized: false,
      operation: (signal) =>
        fetchAutocomplete(this.#session, {
          ...input,
          signal,
          locale: this.options.locale,
        }),
    });
  }

  /** Returns searches currently surging in the selected country or territory. */
  public trendingNow(input: TrendingNowOptions): Promise<TrendingNowResult> {
    return this.#execute({
      method: 'trendingNow',
      input,
      tokenized: false,
      operation: (signal) =>
        fetchTrendingNow(this.#session, {
          ...input,
          signal,
          locale: this.options.locale,
        }),
    });
  }
}

export function createClient(options?: GoogleTrendsClientOptions): GoogleTrendsClient {
  return new GoogleTrendsClient(options);
}
