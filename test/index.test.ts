import { describe, expect, it } from 'vitest';

import {
  GOOGLE_TRENDS_PROPERTIES,
  INTEREST_BY_REGION_RESOLUTIONS,
  createClient,
} from '../src/index.js';

describe('createClient', () => {
  it('creates a client with safe defaults', () => {
    const client = createClient();

    expect(client.options).toMatchObject({
      locale: 'en-US',
      timezone: 0,
      timeoutMs: 10_000,
      retries: 2,
    });

    expect(client.options.userAgent).toContain('google-trends-api');
  });

  it('rejects invalid options', () => {
    expect(() => createClient({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createClient({ retries: -1 })).toThrow(RangeError);
    expect(() => createClient({ locale: '' })).toThrow(RangeError);
  });
});

describe('public constants', () => {
  it('exports supported Google Trends properties', () => {
    expect(GOOGLE_TRENDS_PROPERTIES).toEqual(['', 'images', 'news', 'youtube', 'froogle']);
  });

  it('exports supported geographic resolutions', () => {
    expect(INTEREST_BY_REGION_RESOLUTIONS).toEqual(['COUNTRY', 'REGION', 'CITY', 'DMA']);
  });
});
