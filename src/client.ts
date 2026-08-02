import { HttpSession } from './http/session.js';
import type { GoogleTrendsClientOptions, ResolvedGoogleTrendsClientOptions } from './types.js';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';

const DEFAULT_USER_AGENT =
  'google-trends-api-node (+https://github.com/arham-rumi/google-trends-api)';

function resolveOptions(options: GoogleTrendsClientOptions): ResolvedGoogleTrendsClientOptions {
  const resolved: ResolvedGoogleTrendsClientOptions = {
    locale: options.locale ?? 'en-US',
    timezone: options.timezone ?? 0,
    timeoutMs: options.timeoutMs ?? 10_000,
    retries: options.retries ?? 2,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
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

export class GoogleTrendsClient {
  public readonly options: Readonly<ResolvedGoogleTrendsClientOptions>;

  readonly #session: HttpSession;

  public constructor(options: GoogleTrendsClientOptions = {}) {
    this.options = Object.freeze(resolveOptions(options));

    this.#session = new HttpSession({
      baseUrl: GOOGLE_TRENDS_BASE_URL,
      timeoutMs: this.options.timeoutMs,
      retry: {
        retries: this.options.retries,
      },
      headers: {
        accept: 'application/json,text/plain,*/*',
        'accept-language': this.options.locale,
        'user-agent': this.options.userAgent,
      },
      ...(options.fetch === undefined
        ? {}
        : {
            fetch: options.fetch,
          }),
    });
  }

  /**
   * Establishes the initial Google Trends session and collects cookies.
   * Public API methods will eventually call this automatically.
   */
  public warmup(signal?: AbortSignal): Promise<void> {
    return this.#session.warmup(signal);
  }
}

export function createClient(options?: GoogleTrendsClientOptions): GoogleTrendsClient {
  return new GoogleTrendsClient(options);
}
