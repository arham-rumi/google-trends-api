export interface GoogleTrendsClientOptions {
  locale?: string;
  timezone?: number;
  timeoutMs?: number;
}

export class GoogleTrendsClient {
  public readonly options: Readonly<Required<GoogleTrendsClientOptions>>;

  public constructor(options: GoogleTrendsClientOptions = {}) {
    this.options = Object.freeze({
      locale: options.locale ?? 'en-US',
      timezone: options.timezone ?? 0,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
  }
}

export function createClient(options?: GoogleTrendsClientOptions): GoogleTrendsClient {
  return new GoogleTrendsClient(options);
}
