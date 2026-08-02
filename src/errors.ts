export type GoogleTrendsErrorCode =
  | 'HTTP_STATUS'
  | 'RATE_LIMITED'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'WIDGET_NOT_FOUND';

export class GoogleTrendsError extends Error {
  public readonly code: GoogleTrendsErrorCode;

  public constructor(message: string, code: GoogleTrendsErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });

    this.name = new.target.name;
    this.code = code;
  }
}

export class HttpStatusError extends GoogleTrendsError {
  public readonly status: number;
  public readonly url: string;
  public readonly responseBody: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(options: {
    status: number;
    url: string;
    responseBody: string | undefined;
    retryAfterMs: number | undefined;
  }) {
    super(`Request to ${options.url} failed with HTTP ${options.status}.`, 'HTTP_STATUS');

    this.status = options.status;
    this.url = options.url;
    this.responseBody = options.responseBody;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class RateLimitError extends GoogleTrendsError {
  public readonly status = 429;
  public readonly url: string;
  public readonly responseBody: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(options: {
    url: string;
    responseBody: string | undefined;
    retryAfterMs: number | undefined;
  }) {
    super(`Google Trends rate limit reached while requesting ${options.url}.`, 'RATE_LIMITED');

    this.url = options.url;
    this.responseBody = options.responseBody;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class RequestTimeoutError extends GoogleTrendsError {
  public readonly url: string;
  public readonly timeoutMs: number;

  public constructor(url: string, timeoutMs: number, cause?: unknown) {
    super(`Request to ${url} timed out after ${timeoutMs} ms.`, 'REQUEST_TIMEOUT', cause);

    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class RequestAbortedError extends GoogleTrendsError {
  public readonly url: string;

  public constructor(url: string, cause?: unknown) {
    super(`Request to ${url} was aborted.`, 'REQUEST_ABORTED', cause);

    this.url = url;
  }
}

export class NetworkError extends GoogleTrendsError {
  public readonly url: string;

  public constructor(url: string, cause?: unknown) {
    super(`Network request to ${url} failed.`, 'NETWORK_ERROR', cause);

    this.url = url;
  }
}

export class InvalidResponseError extends GoogleTrendsError {
  public readonly url: string;

  public constructor(url: string, cause?: unknown) {
    super(`The response from ${url} could not be parsed.`, 'INVALID_RESPONSE', cause);

    this.url = url;
  }
}

export class WidgetNotFoundError extends GoogleTrendsError {
  public readonly widgetId: string;
  public readonly availableWidgetIds: readonly string[];

  public constructor(widgetId: string, availableWidgetIds: readonly string[]) {
    super(`Google Trends did not return the required ${widgetId} widget.`, 'WIDGET_NOT_FOUND');

    this.widgetId = widgetId;
    this.availableWidgetIds = [...availableWidgetIds];
  }
}
