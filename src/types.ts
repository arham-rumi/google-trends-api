export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HttpHeadersInit = ConstructorParameters<typeof Headers>[0];

export type QueryPrimitive = string | number | boolean | Date | null | undefined;

export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];

export type QueryParameters = Readonly<Record<string, QueryValue>>;

export interface RetryOptions {
  /**
   * Number of additional attempts after the first request.
   */
  retries: number;

  minDelayMs: number;
  maxDelayMs: number;
  factor: number;

  /**
   * Random variation between 0 and 1.
   */
  jitter: number;
}

export interface HttpSessionOptions {
  baseUrl: string | URL;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  headers?: HttpHeadersInit;
  fetch?: FetchLike;
}

export interface HttpRequestOptions extends Omit<RequestInit, 'headers' | 'signal'> {
  headers?: HttpHeadersInit;
  query?: QueryParameters;
  signal?: AbortSignal;
  timeoutMs?: number;

  /**
   * Set to false to disable retries for this request.
   */
  retry?: false | Partial<RetryOptions>;
}

export interface GoogleTrendsClientOptions {
  locale?: string;

  /**
   * Timezone offset in minutes, following Google Trends conventions.
   */
  timezone?: number;

  timeoutMs?: number;
  retries?: number;
  userAgent?: string;

  /**
   * Custom fetch implementation, primarily for testing or advanced networking.
   */
  fetch?: FetchLike;
}

export interface ResolvedGoogleTrendsClientOptions {
  locale: string;
  timezone: number;
  timeoutMs: number;
  retries: number;
  userAgent: string;
}
