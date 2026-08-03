import fetchCookieExport from 'fetch-cookie';

import { HttpStatusError, InvalidResponseError } from '../errors.js';
import { GOOGLE_EXPLORE_PAGE_PATH, GOOGLE_TRENDS_HOME_PATH } from '../google/constants.js';
import type { FetchLike, HttpRequestOptions, HttpSessionOptions } from '../types.js';
import { performRequest, type RequestContext } from './request.js';
import { resolveRetryOptions } from './retry.js';

const DEFAULT_TIMEOUT_MS = 10_000;

type FetchCookieFactory = typeof import('fetch-cookie').default;

function resolveFetchCookieFactory(value: unknown): FetchCookieFactory {
  if (typeof value === 'function') {
    return value as FetchCookieFactory;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    typeof value.default === 'function'
  ) {
    return value.default as FetchCookieFactory;
  }

  throw new TypeError('fetch-cookie did not expose a callable default export.');
}

const makeFetchCookie = resolveFetchCookieFactory(fetchCookieExport);

export interface HttpSessionWarmupOptions {
  locale?: string;
  geo?: string;
  signal?: AbortSignal;
}

export class HttpSession {
  readonly #context: RequestContext;

  public constructor(options: HttpSessionOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be greater than zero.');
    }

    const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

    /*
     * fetch-cookie supports the native Fetch API, but its generic type is
     * narrower than our injectable FetchLike interface.
     */
    const cookieFetch = makeFetchCookie(baseFetch as typeof globalThis.fetch) as FetchLike;

    this.#context = {
      baseUrl: new URL(options.baseUrl),
      fetch: cookieFetch,
      defaultHeaders: new Headers(options.headers),
      timeoutMs,
      retry: resolveRetryOptions(options.retry),
    };
  }

  public request(path: string | URL, options: HttpRequestOptions = {}): Promise<Response> {
    return performRequest(this.#context, path, options);
  }

  public async getText(path: string | URL, options: HttpRequestOptions = {}): Promise<string> {
    const response = await this.request(path, {
      ...options,
      method: 'GET',
    });

    return response.text();
  }

  public async getJson<T>(path: string | URL, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.request(path, {
      ...options,
      method: 'GET',
    });

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new InvalidResponseError(response.url, error);
    }
  }

  public async warmup(options: HttpSessionWarmupOptions = {}): Promise<void> {
    const requestOptions: HttpRequestOptions = {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'upgrade-insecure-requests': '1',
      },
      query: {
        geo: options.geo,
        hl: options.locale,
      },
      retry: {
        retries: 1,
      },
    };

    if (options.signal !== undefined) {
      requestOptions.signal = options.signal;
    }

    try {
      await this.#consumeWarmupResponse(GOOGLE_EXPLORE_PAGE_PATH, requestOptions);
    } catch (error) {
      if (!(error instanceof HttpStatusError) || error.status !== 404) {
        throw error;
      }

      await this.#consumeWarmupResponse(GOOGLE_TRENDS_HOME_PATH, requestOptions);
    }
  }

  async #consumeWarmupResponse(path: string, options: HttpRequestOptions): Promise<void> {
    const response = await this.request(path, options);

    // Consume the response so redirects and Set-Cookie headers are fully handled.
    await response.arrayBuffer();
  }
}
