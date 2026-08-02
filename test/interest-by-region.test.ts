import { describe, expect, it } from 'vitest';

import { InvalidResponseError } from '../src/errors.js';
import {
  buildInterestByRegionComparisonItems,
  parseInterestByRegionResponse,
} from '../src/google/interest-by-region.js';
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

describe('interestByRegion', () => {
  it('normalizes keywords and applies a safe default time range', () => {
    expect(
      buildInterestByRegionComparisonItems({
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

  it('parses geo codes, coordinates, and keyword values', () => {
    const result = parseInterestByRegionResponse(
      {
        default: {
          geoMapData: [
            {
              geoCode: 'US-CA',
              geoName: 'California',
              value: [92, 76],
              formattedValue: ['92', '76'],
              maxValueIndex: 0,
            },
            {
              coordinates: {
                lat: 31.5204,
                lng: 74.3587,
              },
              geoName: 'Lahore',
              value: [81, 90],
              formattedValue: ['81', '90'],
              maxValueIndex: 1,
            },
          ],
        },
      },
      ['TypeScript', 'Node.js'],
      'https://trends.google.com/trends/api/widgetdata/comparedgeo',
    );

    expect(result).toEqual({
      regions: [
        {
          geoCode: 'US-CA',
          geoName: 'California',
          values: [
            {
              keyword: 'TypeScript',
              value: 92,
              formattedValue: '92',
            },
            {
              keyword: 'Node.js',
              value: 76,
              formattedValue: '76',
            },
          ],
          maxValueIndex: 0,
        },
        {
          coordinates: {
            lat: 31.5204,
            lng: 74.3587,
          },
          geoName: 'Lahore',
          values: [
            {
              keyword: 'TypeScript',
              value: 81,
              formattedValue: '81',
            },
            {
              keyword: 'Node.js',
              value: 90,
              formattedValue: '90',
            },
          ],
          maxValueIndex: 1,
        },
      ],
    });
  });

  it('rejects malformed geographic responses', () => {
    expect(() =>
      parseInterestByRegionResponse(
        {
          default: {
            geoMapData: [
              {
                geoName: 'California',
                value: [90],
              },
            ],
          },
        },
        ['one', 'two'],
        'https://example.test/comparedgeo',
      ),
    ).toThrow(InvalidResponseError);
  });

  it('warms the session, discovers a token, and requests geographic data', async () => {
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
                id: 'GEO_MAP_0',
                token: 'geo-token',
                request: {
                  geo: {
                    country: 'PK',
                  },
                  comparisonItem: [],
                  resolution: 'REGION',
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

      if (url.pathname === '/trends/api/widgetdata/comparedgeo') {
        return responseWithUrl(
          `)]}',\n${JSON.stringify({
            default: {
              geoMapData: [
                {
                  geoCode: 'PK-PB',
                  geoName: 'Punjab',
                  value: [88],
                  formattedValue: ['88'],
                  maxValueIndex: 0,
                },
              ],
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

    const result = await client.interestByRegion({
      keywords: 'TypeScript',
      geo: 'PK',
      resolution: 'CITY',
      includeLowSearchVolumeGeos: true,
      category: 31,
      property: 'news',
    });

    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/explore',
      '/trends/api/explore',
      '/trends/api/widgetdata/comparedgeo',
    ]);

    const geoUrl = requestedUrls[2] as URL;
    expect(geoUrl.searchParams.get('token')).toBe('geo-token');
    expect(geoUrl.searchParams.get('hl')).toBe('en-US');
    expect(geoUrl.searchParams.get('tz')).toBe('-300');
    expect(JSON.parse(geoUrl.searchParams.get('req') ?? '')).toEqual({
      geo: {
        country: 'PK',
      },
      comparisonItem: [],
      resolution: 'CITY',
      includeLowSearchVolumeGeos: true,
      requestOptions: {
        backend: 'IZG',
        category: 31,
        property: 'news',
      },
    });

    expect(result.regions[0]).toEqual({
      geoCode: 'PK-PB',
      geoName: 'Punjab',
      values: [
        {
          keyword: 'TypeScript',
          value: 88,
          formattedValue: '88',
        },
      ],
      maxValueIndex: 0,
    });
  });
});
