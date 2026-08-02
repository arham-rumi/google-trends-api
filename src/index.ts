export { GoogleTrendsClient, createClient } from './client.js';

export {
  GoogleTrendsError,
  HttpStatusError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  RequestAbortedError,
  RequestTimeoutError,
  WidgetNotFoundError,
} from './errors.js';

export type { GoogleTrendsErrorCode } from './errors.js';

export type {
  InterestOverTimeAverage,
  InterestOverTimeOptions,
  InterestOverTimePoint,
  InterestOverTimeResult,
  InterestOverTimeValue,
} from './google/interest-over-time.js';

export type { GoogleTrendsProperty } from './google/constants.js';

export type {
  FetchLike,
  GoogleTrendsClientOptions,
  HttpHeadersInit,
  QueryParameters,
  QueryPrimitive,
  QueryValue,
  ResolvedGoogleTrendsClientOptions,
  RetryOptions,
} from './types.js';
