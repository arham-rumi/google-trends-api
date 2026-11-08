import { describe, expect, it } from 'vitest';

import {
  GOOGLE_TRENDS_PROPERTIES,
  INTEREST_BY_REGION_RESOLUTIONS,
  createClient,
} from '../src/index.js';
import { TestCoordinatedCacheStore } from './support/coordinated-cache-store.js';

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
        adaptivePacing: {
          enabled: true,
          maxIntervalMs: 30_000,
          increaseFactor: 2,
          recoveryFactor: 0.75,
          successThreshold: 4,
        },
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
        keyPrefix: 'google-trends-api:v1:',
        coordination: {
          enabled: false,
          sharedRequestPacing: true,
          lockTtlMs: 30_000,
          pollIntervalMs: 100,
        },
      },
    });

    expect(client.options.userAgent).toContain('Mozilla/5.0');
    expect(client.options.userAgent).toContain('Chrome/');
    expect(client.requestIntervalMs).toBe(2_500);
  });

  it('rejects invalid options', () => {
    expect(() => createClient({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createClient({ retries: -1 })).toThrow(RangeError);
    expect(() => createClient({ locale: '' })).toThrow(RangeError);
    expect(() => createClient({ rateLimit: { minIntervalMs: -1 } })).toThrow(RangeError);
    expect(() => createClient({ rateLimit: { recoveryDelaysMs: [-1] } })).toThrow(RangeError);
    expect(() =>
      createClient({
        rateLimit: { minIntervalMs: 100, adaptivePacing: { maxIntervalMs: 99 } },
      }),
    ).toThrow(RangeError);
    expect(() => createClient({ rateLimit: { adaptivePacing: { increaseFactor: 1 } } })).toThrow(
      RangeError,
    );
    expect(() => createClient({ rateLimit: { adaptivePacing: { recoveryFactor: 1 } } })).toThrow(
      RangeError,
    );
    expect(() => createClient({ rateLimit: { adaptivePacing: { successThreshold: 0 } } })).toThrow(
      RangeError,
    );
    expect(() => createClient({ cache: { maxEntries: 0 } })).toThrow(RangeError);
    expect(() => createClient({ cache: { keyPrefix: '' } })).toThrow(RangeError);
    expect(() => createClient({ cache: { coordination: { enabled: true } } })).toThrow(TypeError);
    expect(() =>
      createClient({
        cache: {
          store: new TestCoordinatedCacheStore(),
          coordination: { lockTtlMs: 100, pollIntervalMs: 100 },
        },
      }),
    ).toThrow(RangeError);
  });

  it('enables coordination automatically for a capable cache store', () => {
    const client = createClient({ cache: { store: new TestCoordinatedCacheStore() } });

    expect(client.options.cache.coordination).toEqual({
      enabled: true,
      sharedRequestPacing: true,
      lockTtlMs: 30_000,
      pollIntervalMs: 100,
    });
  });

  it('allows shared request pacing to be disabled independently', () => {
    const client = createClient({
      cache: {
        store: new TestCoordinatedCacheStore(),
        coordination: { sharedRequestPacing: false },
      },
    });

    expect(client.options.cache.coordination).toMatchObject({
      enabled: true,
      sharedRequestPacing: false,
    });
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
