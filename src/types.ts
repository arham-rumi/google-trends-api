import type { CacheOptions, ResolvedCacheOptions } from './cache/types.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HttpHeadersInit = ConstructorParameters<typeof Headers>[0];

export type QueryPrimitive = string | number | boolean | Date | null | undefined;

export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];

export type QueryParameters = Readonly<Record<string, QueryValue>>;

export interface RetryOptions {
  /** Number of additional attempts after the first request. */
  retries: number;
  minDelayMs: number;
  maxDelayMs: number;
  factor: number;

  /** Random variation between 0 and 1. */
  jitter: number;
}

export interface AdaptivePacingOptions {
  /** Enables response-aware request spacing. Defaults to true. */
  enabled?: boolean;

  /** Maximum adaptive request interval. Defaults to at least 30 seconds. */
  maxIntervalMs?: number;

  /** Multiplier applied after each HTTP 429. Defaults to 2. */
  increaseFactor?: number;

  /** Multiplier applied after a successful recovery window. Defaults to 0.75. */
  recoveryFactor?: number;

  /** Successful requests required before reducing the interval. Defaults to 4. */
  successThreshold?: number;
}

export interface ResolvedAdaptivePacingOptions {
  enabled: boolean;
  maxIntervalMs: number;
  increaseFactor: number;
  recoveryFactor: number;
  successThreshold: number;
}

export interface RequestBudgetOptions {
  /** Enables bounded admission control and the protective circuit. Defaults to true. */
  enabled?: boolean;

  /** Maximum admitted HTTP requests, including the active request. Defaults to 100. */
  maxPendingRequests?: number;

  /** Maximum time an HTTP request may wait before starting. Defaults to 2 minutes. */
  maxQueueWaitMs?: number;

  /** Consecutive endpoint 429s required to open the circuit. Defaults to 3. */
  circuitBreakerThreshold?: number;

  /** How long an opened circuit rejects new work. Defaults to 5 minutes. */
  circuitOpenMs?: number;
}

export interface ResolvedRequestBudgetOptions {
  enabled: boolean;
  maxPendingRequests: number;
  maxQueueWaitMs: number;
  circuitBreakerThreshold: number;
  circuitOpenMs: number;
}

export interface RateLimitOptions {
  /** Enables serialized, spaced requests and shared cooldown handling. Defaults to true. */
  enabled?: boolean;

  /** Minimum delay between the start of Google requests. Defaults to 2500 ms. */
  minIntervalMs?: number;

  /** Response-aware pacing that backs off after 429s and recovers gradually. */
  adaptivePacing?: AdaptivePacingOptions;

  /** Queue limits, maximum waiting time, and protective circuit breaking. */
  requestBudget?: RequestBudgetOptions;

  /** Fallback cooldown when automatic recovery is disabled. Defaults to 60 seconds. */
  cooldownMs?: number;

  /**
   * Waits, refreshes the cookie session, and retries tokenized operations after HTTP 429.
   * Defaults to true.
   */
  recovery?: boolean;

  /**
   * Delay before each automatic recovery attempt. Defaults to
   * 1, 2, 3, 5, 10, 15, 20, 25, and 30 minutes.
   */
  recoveryDelaysMs?: readonly number[];
}

export interface ResolvedRateLimitOptions {
  enabled: boolean;
  minIntervalMs: number;
  adaptivePacing: Readonly<ResolvedAdaptivePacingOptions>;
  requestBudget: Readonly<ResolvedRequestBudgetOptions>;
  cooldownMs: number;
  recovery: boolean;
  recoveryDelaysMs: readonly number[];
}

export interface HttpSessionOptions {
  baseUrl: string | URL;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  rateLimit?: RateLimitOptions;
  headers?: HttpHeadersInit;
  fetch?: FetchLike;
}

export interface HttpRequestOptions extends Omit<RequestInit, 'headers' | 'signal'> {
  headers?: HttpHeadersInit;
  query?: QueryParameters;
  signal?: AbortSignal;
  timeoutMs?: number;

  /** Set to false to disable retries for this request. */
  retry?: false | Partial<RetryOptions>;
}

export interface GoogleTrendsClientOptions {
  locale?: string;

  /** Timezone offset in minutes, following Google Trends conventions. */
  timezone?: number;

  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  rateLimit?: RateLimitOptions;
  cache?: CacheOptions;

  /** Custom fetch implementation, primarily for testing or advanced networking. */
  fetch?: FetchLike;
}

export interface ResolvedGoogleTrendsClientOptions {
  locale: string;
  timezone: number;
  timeoutMs: number;
  retries: number;
  userAgent: string;
  rateLimit: Readonly<ResolvedRateLimitOptions>;
  cache: Readonly<ResolvedCacheOptions>;
}

export type {
  CacheCoordinationOptions,
  CacheOptions,
  CacheStore,
  CacheStoreResult,
  CoordinatedCacheStore,
  ResolvedCacheCoordinationOptions,
  ResolvedCacheOptions,
} from './cache/types.js';
