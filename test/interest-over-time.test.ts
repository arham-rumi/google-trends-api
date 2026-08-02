import { describe, expect, it } from 'vitest';

import { InvalidResponseError } from '../src/errors.js';
import {
  buildInterestOverTimeComparisonItems,
  parseInterestOverTimeResponse,
} from '../src/google/interest-over-time.js';
import { createClient } from '../src/index.js';
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

  it('warms the session, discovers a token, and requests timeline data', async () => {
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
      fetch: fakeFetch,
    });

    const result = await client.interestOverTime({
      keywords: 'TypeScript',
      geo: 'US',
      category: 31,
      property: 'news',
    });

    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/explore',
      '/trends/api/explore',
      '/trends/api/widgetdata/multiline',
    ]);

    const timelineUrl = requestedUrls[2] as URL;
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
});
