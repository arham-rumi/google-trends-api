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
import type { GoogleTrendsClientOptions, ResolvedGoogleTrendsClientOptions } from './types.js';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function inferRegionFromLocale(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).region;
  } catch {
    return undefined;
  }
}

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
  #warmupPromise: Promise<void> | undefined;

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
        'accept-language': `${this.options.locale},en;q=0.9`,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        referer: `${GOOGLE_TRENDS_BASE_URL}/explore`,
        'user-agent': this.options.userAgent,
      },
      ...(options.fetch === undefined
        ? {}
        : {
            fetch: options.fetch,
          }),
    });
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
    this.#warmupPromise ??= this.#session
      .warmup(this.#createWarmupOptions())
      .catch((error: unknown) => {
        this.#warmupPromise = undefined;
        throw error;
      });

    return this.#warmupPromise;
  }

  /** Establishes the Google Trends session and collects cookies. */
  public warmup(signal?: AbortSignal): Promise<void> {
    if (signal !== undefined) {
      return this.#session.warmup(this.#createWarmupOptions(signal));
    }

    return this.#ensureWarmup();
  }

  /** Returns normalized Google Trends interest values over time. */
  public async interestOverTime(input: InterestOverTimeOptions): Promise<InterestOverTimeResult> {
    input.signal?.throwIfAborted();
    await this.#ensureWarmup();
    input.signal?.throwIfAborted();

    return fetchInterestOverTime(this.#session, {
      ...input,
      locale: this.options.locale,
      timezone: this.options.timezone,
    });
  }

  /** Returns normalized Google Trends interest values by geographic area. */
  public async interestByRegion(input: InterestByRegionOptions): Promise<InterestByRegionResult> {
    input.signal?.throwIfAborted();
    await this.#ensureWarmup();
    input.signal?.throwIfAborted();

    return fetchInterestByRegion(this.#session, {
      ...input,
      locale: this.options.locale,
      timezone: this.options.timezone,
    });
  }

  /** Returns top and rising searches related to each keyword. */
  public async relatedQueries(input: RelatedSearchesOptions): Promise<RelatedQueriesResult[]> {
    input.signal?.throwIfAborted();
    await this.#ensureWarmup();
    input.signal?.throwIfAborted();

    return fetchRelatedQueries(this.#session, {
      ...input,
      locale: this.options.locale,
      timezone: this.options.timezone,
    });
  }

  /** Returns top and rising topics related to each keyword. */
  public async relatedTopics(input: RelatedSearchesOptions): Promise<RelatedTopicsResult[]> {
    input.signal?.throwIfAborted();
    await this.#ensureWarmup();
    input.signal?.throwIfAborted();

    return fetchRelatedTopics(this.#session, {
      ...input,
      locale: this.options.locale,
      timezone: this.options.timezone,
    });
  }

  /** Returns Google Trends search-term and topic suggestions. */
  public autocomplete(input: AutocompleteOptions): Promise<AutocompleteResult> {
    input.signal?.throwIfAborted();

    return fetchAutocomplete(this.#session, {
      ...input,
      locale: this.options.locale,
    });
  }

  /** Returns searches currently surging in the selected country or territory. */
  public trendingNow(input: TrendingNowOptions): Promise<TrendingNowResult> {
    input.signal?.throwIfAborted();

    return fetchTrendingNow(this.#session, {
      ...input,
      locale: this.options.locale,
    });
  }
}

export function createClient(options?: GoogleTrendsClientOptions): GoogleTrendsClient {
  return new GoogleTrendsClient(options);
}
