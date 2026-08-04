import { describe, expect, it } from 'vitest';

import { InvalidResponseError } from '../src/errors.js';
import {
  buildInterestOverTimeComparisonItems,
  parseInterestOverTimeResponse,
} from '../src/google/interest-over-time.js';
import { createClient, getResultMetadata } from '../src/index.js';
import type { FetchLike } from '../src/types.js';

function responseWithUrl(body: string, url: string, init: ResponseInit = {}): Response {
  const response = new Response(body, init);

  Object.defineProperty(response, 'url', {
    value: url,
    configurable: true,
  });

  return response;
}

describe('interestOverTime', () => {
  it('normalizes keywords and applies a safe default time range', () => {
    expect(
      buildInterestOverTimeComparisonItems({
        keywords: [' TypeScript ', ' Node.js '],
        geo: ' US ',
      }),
    ).toEqual([
      {
        keyword: 'TypeScript',
        geo: 'US',
        time: 'today 12-m',
      },
      {
        keyword: 'Node.js',
        geo: 'US',
        time: 'today 12-m',
      },
    ]);
  });

  it('rejects empty or excessive keyword lists', () => {
    expect(() => buildInterestOverTimeComparisonItems({ keywords: [] })).toThrow(RangeError);

    expect(() =>
      buildInterestOverTimeComparisonItems({
        keywords: ['one', 'two', 'three', 'four', 'five', 'six'],
      }),
    ).toThrow(RangeError);
  });

  it('parses timeline values into typed points', () => {
    const result = parseInterestOverTimeResponse(
      {
        default: {
          timelineData: [
            {
              time: '1711929600',
              formattedTime: 'Apr 1, 2024',
              formattedAxisTime: 'Apr 1',
              value: [72, 55],
              hasData: [true, true],
              formattedValue: ['72', '55'],
              isPartial: false,
            },
          ],
          averages: [64, 48],
        },
      },
      ['TypeScript', 'Node.js'],
      'https://trends.google.com/trends/api/widgetdata/multiline',
    );

    expect(result.averages).toEqual([
      { keyword: 'TypeScript', value: 64 },
      { keyword: 'Node.js', value: 48 },
    ]);
    expect(result.timeline[0]).toMatchObject({
      timestamp: 1_711_929_600,
      formattedTime: 'Apr 1, 2024',
      formattedAxisTime: 'Apr 1',
      isPartial: false,
      values: [
        {
          keyword: 'TypeScript',
          value: 72,
          hasData: true,
          formattedValue: '72',
        },
        {
          keyword: 'Node.js',
          value: 55,
          hasData: true,
          formattedValue: '55',
        },
      ],
    });
    expect(result.timeline[0]?.date).toEqual(new Date(1_711_929_600_000));
  });

  it('rejects malformed timeline responses', () => {
    expect(() =>
      parseInterestOverTimeResponse(
        {
          default: {
            timelineData: [
              {
                time: '1711929600',
                value: [50],
              },
            ],
          },
        },
        ['one', 'two'],
        'https://example.test/timeline',
      ),
    ).toThrow(InvalidResponseError);
  });

  it('discovers a token without eager warm-up and requests timeline data', async () => {
    const requestedUrls: URL[] = [];

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);

      if (url.pathname === '/explore') {
        return responseWithUrl('<html>ready</html>', url.toString(), {
          status: 200,
        });
      }

      if (url.pathname === '/trends/api/explore') {
        return responseWithUrl(
          `)]}',\n${JSON.stringify({
            widgets: [
              {
                id: 'TIMESERIES',
                token: 'timeline-token',
                request: {
                  time: 'today 12-m',
                  requestOptions: {
                    backend: 'IZG',
                  },
                },
              },
            ],
          })}`,
          url.toString(),
        );
      }

      if (url.pathname === '/trends/api/widgetdata/multiline') {
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
          url.toString(),
        );
      }

      return responseWithUrl('Not found', url.toString(), {
        status: 404,
      });
    };

    const client = createClient({
      locale: 'en-US',
      timezone: -300,
      retries: 0,
      rateLimit: { enabled: false },
      fetch: fakeFetch,
    });

    const result = await client.interestOverTime({
      keywords: 'TypeScript',
      geo: 'US',
      category: 31,
      property: 'news',
    });

    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/trends/api/explore',
      '/trends/api/widgetdata/multiline',
    ]);

    const timelineUrl = requestedUrls[1] as URL;
    expect(timelineUrl.searchParams.get('token')).toBe('timeline-token');
    expect(timelineUrl.searchParams.get('hl')).toBe('en-US');
    expect(timelineUrl.searchParams.get('tz')).toBe('-300');
    expect(JSON.parse(timelineUrl.searchParams.get('req') ?? '')).toEqual({
      time: 'today 12-m',
      requestOptions: {
        backend: 'IZG',
        category: 31,
        property: 'news',
      },
    });

    expect(result.timeline[0]?.values[0]).toEqual({
      keyword: 'TypeScript',
      value: 80,
      hasData: true,
      formattedValue: '80',
    });
  });

  it('deduplicates concurrent requests and serves repeated calls from cache', async () => {
    const requestedUrls: URL[] = [];

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);

      if (url.pathname === '/trends/api/explore') {
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
          url.toString(),
        );
      }

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
        url.toString(),
      );
    };

    const client = createClient({
      retries: 0,
      rateLimit: { minIntervalMs: 0 },
      fetch: fakeFetch,
    });
    const input = { keywords: 'TypeScript', geo: 'US' } as const;
    const [first, second] = await Promise.all([
      client.interestOverTime(input),
      client.interestOverTime(input),
    ]);

    expect(requestedUrls).toHaveLength(2);
    expect(getResultMetadata(first)).toEqual({ source: 'network', stale: false });
    expect(getResultMetadata(second)).toEqual({ source: 'network', stale: false });

    const cached = await client.interestOverTime(input);

    expect(requestedUrls).toHaveLength(2);
    expect(getResultMetadata(cached)).toMatchObject({ source: 'cache', stale: false });
    expect(cached).toEqual(first);
  });

  it('returns stale cached data on 429 and avoids requests during cooldown', async () => {
    let rateLimited = false;
    let requestCount = 0;

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestCount += 1;

      if (rateLimited) {
        return responseWithUrl('Too many requests', url.toString(), {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      }

      if (url.pathname === '/trends/api/explore') {
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
          url.toString(),
        );
      }

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
        url.toString(),
      );
    };

    const client = createClient({
      retries: 3,
      rateLimit: { minIntervalMs: 0, cooldownMs: 60_000 },
      cache: { ttlMs: 1, staleIfErrorMs: 60_000 },
      fetch: fakeFetch,
    });
    const input = { keywords: 'TypeScript', geo: 'US' } as const;

    await client.interestOverTime(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    rateLimited = true;

    const stale = await client.interestOverTime(input);

    expect(requestCount).toBe(3);
    expect(getResultMetadata(stale)).toMatchObject({
      source: 'stale-cache',
      stale: true,
    });
    expect(client.cooldownRemainingMs).toBeGreaterThan(0);

    const duringCooldown = await client.interestOverTime(input);

    expect(requestCount).toBe(3);
    expect(getResultMetadata(duringCooldown)?.source).toBe('stale-cache');
  });

  it('warms up lazily only after Google returns an HTML challenge', async () => {
    const requestedPaths: string[] = [];
    let exploreAttempts = 0;

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedPaths.push(url.pathname);

      if (url.pathname === '/trends/api/explore') {
        exploreAttempts += 1;

        if (exploreAttempts === 1) {
          return responseWithUrl('<html>consent required</html>', url.toString(), {
            headers: { 'content-type': 'text/html' },
          });
        }

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
          url.toString(),
        );
      }

      if (url.pathname === '/explore') {
        return responseWithUrl('<html>ready</html>', url.toString());
      }

      return responseWithUrl(
        `)]}',\n${JSON.stringify({
          default: {
            timelineData: [],
            averages: [],
          },
        })}`,
        url.toString(),
      );
    };

    const client = createClient({
      retries: 0,
      rateLimit: { enabled: false },
      fetch: fakeFetch,
    });

    await client.interestOverTime({ keywords: 'TypeScript' });

    expect(requestedPaths).toEqual([
      '/trends/api/explore',
      '/explore',
      '/trends/api/explore',
      '/trends/api/widgetdata/multiline',
    ]);
  });
});
