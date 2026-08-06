import {
  GoogleTrendsError,
  HttpStatusError,
  NetworkError,
  RateLimitError,
  RequestAbortedError,
  RequestTimeoutError,
} from '../errors.js';
import type { RequestGovernor } from '../rate-limit/governor.js';
import type {
  FetchLike,
  HttpHeadersInit,
  HttpRequestOptions,
  QueryParameters,
  QueryPrimitive,
  RetryOptions,
} from '../types.js';
import { resolveRetryOptions, withRetry } from './retry.js';

const RETRYABLE_STATUS_CODES = new Set([408, 425, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

const MAX_ERROR_BODY_LENGTH = 4_000;

export interface RequestContext {
  baseUrl: URL;
  fetch: FetchLike;
  defaultHeaders: Headers;
  timeoutMs: number;
  retry: RetryOptions;
  governor: RequestGovernor;
}

function serializeQueryValue(value: QueryPrimitive): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

export function buildUrl(baseUrl: URL, path: string | URL, query?: QueryParameters): URL {
  const url = path instanceof URL ? new URL(path.toString()) : new URL(path, baseUrl);

  if (query === undefined) {
    return url;
  }

  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const value of values) {
      const serializedValue = serializeQueryValue(value);
      if (serializedValue !== undefined) {
        url.searchParams.append(key, serializedValue);
      }
    }
  }

  return url;
}

function mergeHeaders(defaultHeaders: Headers, requestHeaders?: HttpHeadersInit): Headers {
  const headers = new Headers(defaultHeaders);

  if (requestHeaders !== undefined) {
    new Headers(requestHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return headers;
}

export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1_000));
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, timestamp - now);
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    const body = await response.text();

    if (body.length === 0) {
      return undefined;
    }

    return body.slice(0, MAX_ERROR_BODY_LENGTH);
  } catch {
    return undefined;
  }
}

async function createHttpError(
  response: Response,
  url: URL,
): Promise<HttpStatusError | RateLimitError> {
  const responseBody = await readErrorBody(response);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  if (response.status === 429) {
    return new RateLimitError({
      url: url.toString(),
      responseBody,
      retryAfterMs,
    });
  }

  return new HttpStatusError({
    status: response.status,
    url: url.toString(),
    responseBody,
    retryAfterMs,
  });
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof RequestTimeoutError) {
    return true;
  }

  return error instanceof HttpStatusError && RETRYABLE_STATUS_CODES.has(error.status);
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof HttpStatusError || error instanceof RateLimitError) {
    return error.retryAfterMs;
  }

  return undefined;
}

export async function performRequest(
  context: RequestContext,
  path: string | URL,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const {
    headers,
    query,
    retry: requestRetry,
    signal,
    timeoutMs = context.timeoutMs,
    ...requestInit
  } = options;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be greater than zero.');
  }

  const url = buildUrl(context.baseUrl, path, query);
  const method = (requestInit.method ?? 'GET').toUpperCase();

  let retryOptions = resolveRetryOptions(context.retry);
  if (requestRetry === false || (!IDEMPOTENT_METHODS.has(method) && requestRetry === undefined)) {
    retryOptions = {
      ...retryOptions,
      retries: 0,
    };
  } else if (requestRetry !== undefined) {
    retryOptions = resolveRetryOptions({
      ...retryOptions,
      ...requestRetry,
    });
  }

  return withRetry(
    async () =>
      context.governor.execute(
        async () => {
          const timeoutSignal = AbortSignal.timeout(timeoutMs);
          const combinedSignal =
            signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

          try {
            const response = await context.fetch(url, {
              ...requestInit,
              method,
              headers: mergeHeaders(context.defaultHeaders, headers),
              signal: combinedSignal,
            });

            if (!response.ok) {
              throw await createHttpError(response, url);
            }

            return response;
          } catch (error) {
            if (error instanceof GoogleTrendsError) {
              throw error;
            }

            if (signal?.aborted === true) {
              throw new RequestAbortedError(url.toString(), signal.reason);
            }

            if (timeoutSignal.aborted) {
              throw new RequestTimeoutError(url.toString(), timeoutMs, timeoutSignal.reason);
            }

            throw new NetworkError(url.toString(), error);
          }
        },
        signal,
        url.pathname,
      ),
    {
      ...retryOptions,
      signal,
      shouldRetry: isRetryableError,
      getRetryAfterMs,
    },
  );
}
