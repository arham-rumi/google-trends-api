import { describe, expect, it } from 'vitest';

import { InvalidResponseError, WidgetNotFoundError } from '../src/errors.js';
import {
  buildExploreRequest,
  fetchExploreWidgets,
  findExploreWidget,
  parseExploreWidgets,
} from '../src/google/explore.js';
import { HttpSession } from '../src/http/session.js';
import type { FetchLike } from '../src/types.js';

function responseWithUrl(body: string, url: string): Response {
  const response = new Response(body, { status: 200 });

  Object.defineProperty(response, 'url', {
    value: url,
    configurable: true,
  });

  return response;
}

describe('Google Explore flow', () => {
  it('builds a normalized Explore request without mutating input', () => {
    const comparisonItems = [
      {
        keyword: '  TypeScript  ',
        geo: ' US ',
        time: ' today 12-m ',
      },
    ] as const;

    const request = buildExploreRequest({
      comparisonItems,
      locale: 'en-US',
      timezone: -300,
      category: 31,
      property: 'news',
    });

    expect(request).toEqual({
      comparisonItem: [
        {
          keyword: 'TypeScript',
          geo: 'US',
          time: 'today 12-m',
        },
      ],
      category: 31,
      property: 'news',
    });

    expect(comparisonItems[0].keyword).toBe('  TypeScript  ');
  });

  it('rejects invalid comparison input', () => {
    expect(() =>
      buildExploreRequest({
        comparisonItems: [],
        locale: 'en-US',
        timezone: 0,
      }),
    ).toThrow(RangeError);

    expect(() =>
      buildExploreRequest({
        comparisonItems: [{ keyword: '', time: 'today 12-m' }],
        locale: 'en-US',
        timezone: 0,
      }),
    ).toThrow('comparisonItems[0].keyword cannot be empty');
  });

  it('parses and validates tokenized widgets', () => {
    const widgets = parseExploreWidgets(
      {
        widgets: [
          {
            id: 'TIMESERIES',
            token: 'token-123',
            request: {
              time: 'today 12-m',
            },
            title: 'Interest over time',
          },
        ],
      },
      'https://trends.google.com/trends/api/explore',
    );

    expect(widgets).toEqual([
      {
        id: 'TIMESERIES',
        token: 'token-123',
        request: {
          time: 'today 12-m',
        },
        title: 'Interest over time',
      },
    ]);
  });

  it('rejects malformed widget responses', () => {
    expect(() =>
      parseExploreWidgets(
        {
          widgets: [{ id: 'TIMESERIES', request: {} }],
        },
        'https://trends.google.com/trends/api/explore',
      ),
    ).toThrow(InvalidResponseError);
  });

  it('selects widget ids with Google suffixes', () => {
    const widget = findExploreWidget(
      [
        {
          id: 'RELATED_QUERIES_0',
          token: 'query-token',
          request: {},
        },
      ],
      'RELATED_QUERIES',
    );

    expect(widget.token).toBe('query-token');
  });

  it('reports available ids when a required widget is absent', () => {
    expect(() =>
      findExploreWidget(
        [
          {
            id: 'TIMESERIES',
            token: 'timeline-token',
            request: {},
          },
        ],
        'RELATED_TOPICS',
      ),
    ).toThrow(WidgetNotFoundError);
  });

  it('requests Explore widgets with the expected query contract', async () => {
    let requestedUrl: URL | undefined;

    const fakeFetch: FetchLike = async (input) => {
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString());

      return responseWithUrl(
        `)]}',\n${JSON.stringify({
          widgets: [
            {
              id: 'TIMESERIES',
              token: 'timeline-token',
              request: {
                time: 'today 12-m',
              },
            },
          ],
        })}`,
        requestedUrl.toString(),
      );
    };

    const session = new HttpSession({
      baseUrl: 'https://trends.google.com',
      fetch: fakeFetch,
      retry: {
        retries: 0,
      },
    });

    const widgets = await fetchExploreWidgets(session, {
      comparisonItems: [
        {
          keyword: 'TypeScript',
          geo: 'US',
          time: 'today 12-m',
        },
      ],
      locale: 'en-US',
      timezone: -300,
    });

    expect(requestedUrl?.pathname).toBe('/trends/api/explore');
    expect(requestedUrl?.searchParams.get('hl')).toBe('en-US');
    expect(requestedUrl?.searchParams.get('tz')).toBe('-300');
    expect(JSON.parse(requestedUrl?.searchParams.get('req') ?? '')).toEqual({
      comparisonItem: [
        {
          keyword: 'TypeScript',
          geo: 'US',
          time: 'today 12-m',
        },
      ],
      category: 0,
      property: '',
    });
    expect(widgets[0]?.token).toBe('timeline-token');
  });
});
