import { describe, expect, it } from 'vitest';

import { createClient, getResultMetadata } from '../src/index.js';
import type { FetchLike } from '../src/types.js';
import { TestCoordinatedCacheStore } from './support/coordinated-cache-store.js';

function responseWithUrl(body: string, url: string, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function exploreResponse(url: string): Response {
  return responseWithUrl(
    `)]}',\n${JSON.stringify({
      widgets: [
        {
          id: 'TIMESERIES',
          token: 'timeline-token',
          request: { time: 'today 12-m', requestOptions: {} },
        },
      ],
    })}`,
    url,
  );
}

function timelineResponse(url: string): Response {
  return responseWithUrl(
    `)]}',\n${JSON.stringify({
      default: {
        timelineData: [
          {
            time: '1711929600',
            formattedTime: 'Apr 1, 2024',
            value: [80],
            hasData: [true],
            formattedValue: ['80'],
          },
        ],
        averages: [80],
      },
    })}`,
    url,
  );
}

function clientOptions(store: TestCoordinatedCacheStore, fetch: FetchLike) {
  return {
    retries: 0,
    rateLimit: { minIntervalMs: 0, cooldownMs: 1_000, recovery: false },
    cache: {
      store,
      keyPrefix: 'coordination-integration:',
      coordination: { lockTtlMs: 100, pollIntervalMs: 5 },
    },
    fetch,
  } as const;
}

describe('cross-instance coordination', () => {
  it('coalesces identical concurrent requests across client instances', async () => {
    const store = new TestCoordinatedCacheStore();
    let releaseFirstRequest: (() => void) | undefined;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let firstRequestStarted: (() => void) | undefined;
    const firstRequestStart = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    let requestCount = 0;
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestCount += 1;

      if (requestCount === 1) {
        firstRequestStarted?.();
        await firstRequestGate;
      }

      return url.pathname === '/trends/api/explore'
        ? exploreResponse(url.toString())
        : timelineResponse(url.toString());
    };
    const firstClient = createClient(clientOptions(store, fakeFetch));
    const secondClient = createClient(clientOptions(store, fakeFetch));
    const input = { keywords: 'TypeScript', geo: 'US' } as const;
    const firstPromise = firstClient.interestOverTime(input);

    await firstRequestStart;
    const secondPromise = secondClient.interestOverTime(input);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requestCount).toBe(1);
    releaseFirstRequest?.();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(requestCount).toBe(2);
    expect(first).toEqual(second);
    expect(getResultMetadata(first)).toEqual({ source: 'network', stale: false });
    expect(getResultMetadata(second)).toMatchObject({ source: 'cache', stale: false });
    expect(store.locks.size).toBe(0);
  });

  it('shares a 429 cooldown so another client uses stale data without a request', async () => {
    const store = new TestCoordinatedCacheStore();
    let rateLimited = false;
    let requestCount = 0;
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestCount += 1;

      if (rateLimited) {
        return responseWithUrl('Too many requests', url.toString(), { status: 429 });
      }

      return url.pathname === '/trends/api/explore'
        ? exploreResponse(url.toString())
        : timelineResponse(url.toString());
    };
    const options = clientOptions(store, fakeFetch);
    const firstClient = createClient({
      ...options,
      cache: { ...options.cache, ttlMs: 1, staleIfErrorMs: 60_000 },
    });
    const input = { keywords: 'TypeScript', geo: 'US' } as const;

    await firstClient.interestOverTime(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    rateLimited = true;

    const staleFromFirst = await firstClient.interestOverTime(input);
    const countAfterRateLimit = requestCount;
    const secondClient = createClient({
      ...options,
      cache: { ...options.cache, ttlMs: 1, staleIfErrorMs: 60_000 },
    });
    const staleFromSecond = await secondClient.interestOverTime(input);

    expect(getResultMetadata(staleFromFirst)).toMatchObject({
      source: 'stale-cache',
      stale: true,
    });
    expect(getResultMetadata(staleFromSecond)).toMatchObject({
      source: 'stale-cache',
      stale: true,
    });
    expect(requestCount).toBe(countAfterRateLimit);
    expect(secondClient.cooldownRemainingMs).toBeGreaterThan(0);
    expect(store.locks.size).toBe(0);
  });

  it('spaces unrelated HTTP requests across client instances', async () => {
    const store = new TestCoordinatedCacheStore();
    const starts: number[] = [];
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      starts.push(Date.now());

      return responseWithUrl(
        `)]}',\n${JSON.stringify({
          default: {
            topics: [
              {
                mid: '/m/test',
                title: 'Test topic',
                type: 'Topic',
              },
            ],
          },
        })}`,
        url.toString(),
      );
    };
    const baseOptions = clientOptions(store, fakeFetch);
    const options = {
      ...baseOptions,
      rateLimit: { ...baseOptions.rateLimit, minIntervalMs: 25 },
      cache: {
        ...baseOptions.cache,
        coordination: {
          ...baseOptions.cache.coordination,
          pollIntervalMs: 2,
        },
      },
    } as const;
    const firstClient = createClient(options);
    const secondClient = createClient(options);

    await Promise.all([
      firstClient.autocomplete({ keyword: 'TypeScript' }),
      secondClient.autocomplete({ keyword: 'JavaScript' }),
    ]);

    expect(starts).toHaveLength(2);
    expect(Math.abs((starts[1] as number) - (starts[0] as number))).toBeGreaterThanOrEqual(20);
    expect(store.locks.size).toBe(0);
  });
});
