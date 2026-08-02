import makeFetchCookie from 'fetch-cookie';

import { InvalidResponseError } from '../errors.js';
import type { FetchLike, HttpRequestOptions, HttpSessionOptions } from '../types.js';
import { performRequest, type RequestContext } from './request.js';
import { resolveRetryOptions } from './retry.js';

const DEFAULT_TIMEOUT_MS = 10_000;

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

  public async warmup(signal?: AbortSignal): Promise<void> {
    const options: HttpRequestOptions = {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      retry: {
        retries: 1,
      },
    };

    if (signal !== undefined) {
      options.signal = signal;
    }

    const response = await this.request('/trends/', options);

    // Consume the response so the underlying connection can be reused.
    await response.arrayBuffer();
  }
}
