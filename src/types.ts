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

export interface RateLimitOptions {
  /** Enables serialized, spaced requests and shared cooldown handling. Defaults to true. */
  enabled?: boolean;

  /** Minimum delay between the start of Google requests. Defaults to 2500 ms. */
  minIntervalMs?: number;

  /** Fallback cooldown after HTTP 429 when Retry-After is absent. Defaults to 60 seconds. */
  cooldownMs?: number;
}

export interface ResolvedRateLimitOptions {
  enabled: boolean;
  minIntervalMs: number;
  cooldownMs: number;
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

export type { CacheOptions, ResolvedCacheOptions } from './cache/types.js';
