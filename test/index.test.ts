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
      rateLimit: {
        enabled: true,
        minIntervalMs: 2_500,
        cooldownMs: 60_000,
        recovery: true,
        recoveryDelaysMs: [
          60_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000, 1_500_000, 1_800_000,
        ],
      },
      cache: {
        enabled: true,
        ttlMs: 900_000,
        staleIfErrorMs: 86_400_000,
        maxEntries: 100,
      },
    });

    expect(client.options.userAgent).toContain('Mozilla/5.0');
    expect(client.options.userAgent).toContain('Chrome/');
  });

  it('rejects invalid options', () => {
    expect(() => createClient({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createClient({ retries: -1 })).toThrow(RangeError);
    expect(() => createClient({ locale: '' })).toThrow(RangeError);
    expect(() => createClient({ rateLimit: { minIntervalMs: -1 } })).toThrow(RangeError);
    expect(() => createClient({ rateLimit: { recoveryDelaysMs: [-1] } })).toThrow(RangeError);
    expect(() => createClient({ cache: { maxEntries: 0 } })).toThrow(RangeError);
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
