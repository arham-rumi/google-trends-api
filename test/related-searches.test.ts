import { describe, expect, it } from 'vitest';

import { InvalidResponseError } from '../src/errors.js';
import {
  buildRelatedSearchComparisonItems,
  parseRelatedQueriesResponse,
  parseRelatedTopicsResponse,
} from '../src/google/related-searches.js';
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

function widgetRequest(keyword: string): Record<string, unknown> {
  return {
    restriction: {
      complexKeywordsRestriction: {
        keyword: [{ value: keyword }],
      },
    },
  };
}

describe('related searches', () => {
  it('normalizes keywords and applies a default time range', () => {
    expect(
      buildRelatedSearchComparisonItems({
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

  it('parses top and rising related queries', () => {
    expect(
      parseRelatedQueriesResponse(
        {
          default: {
            rankedList: [
              {
                rankedKeyword: [
                  {
                    query: 'typescript tutorial',
                    value: 100,
                    formattedValue: '100',
                    link: '/trends/explore?q=typescript+tutorial',
                  },
                ],
              },
              {
                rankedKeyword: [
                  {
                    query: 'typescript 6',
                    value: 12_500,
                    formattedValue: 'Breakout',
                  },
                ],
              },
            ],
          },
        },
        'https://example.test/related',
      ),
    ).toEqual({
      top: [
        {
          query: 'typescript tutorial',
          value: 100,
          formattedValue: '100',
          link: '/trends/explore?q=typescript+tutorial',
        },
      ],
      rising: [
        {
          query: 'typescript 6',
          value: 12_500,
          formattedValue: 'Breakout',
        },
      ],
    });
  });

  it('parses top and rising related topics', () => {
    expect(
      parseRelatedTopicsResponse(
        {
          default: {
            rankedList: [
              {
                rankedKeyword: [
                  {
                    topic: {
                      mid: '/m/07sbkfb',
                      title: 'TypeScript',
                      type: 'Programming language',
                    },
                    value: 100,
                    formattedValue: '100',
                  },
                ],
              },
              {
                rankedKeyword: [
                  {
                    topic: {
                      title: 'JavaScript',
                    },
                    value: 250,
                    formattedValue: '+250%',
                  },
                ],
              },
            ],
          },
        },
        'https://example.test/related',
      ),
    ).toEqual({
      top: [
        {
          topic: {
            mid: '/m/07sbkfb',
            title: 'TypeScript',
            type: 'Programming language',
          },
          value: 100,
          formattedValue: '100',
        },
      ],
      rising: [
        {
          topic: {
            title: 'JavaScript',
          },
          value: 250,
          formattedValue: '+250%',
        },
      ],
    });
  });

  it('rejects malformed ranked items', () => {
    expect(() =>
      parseRelatedQueriesResponse(
        {
          default: {
            rankedList: [
              {
                rankedKeyword: [{ query: 'missing value' }],
              },
            ],
          },
        },
        'https://example.test/related',
      ),
    ).toThrow(InvalidResponseError);
  });

  it('matches multiple widgets to their keywords and requests them sequentially', async () => {
    const requestedUrls: URL[] = [];

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);

      if (url.pathname === '/explore') {
        return responseWithUrl('<html>ready</html>', url.toString());
      }

      if (url.pathname === '/trends/api/explore') {
        const request = JSON.parse(url.searchParams.get('req') ?? '{}') as {
          comparisonItem?: { keyword?: string }[];
        };
        const keywords = request.comparisonItem?.map((item) => item.keyword ?? '') ?? [];

        const widgets =
          keywords.length === 2
            ? [
                {
                  id: 'RELATED_QUERIES_1',
                  token: 'node-token',
                  request: widgetRequest('Node.js'),
                },
                {
                  id: 'RELATED_QUERIES_0',
                  token: 'typescript-token',
                  request: widgetRequest('TypeScript'),
                },
              ]
            : [
                {
                  id: 'RELATED_TOPICS',
                  token: 'topic-token',
                  request: widgetRequest('TypeScript'),
                },
              ];

        return responseWithUrl(`)]}',\n${JSON.stringify({ widgets })}`, url.toString());
      }

      if (url.pathname === '/trends/api/widgetdata/relatedsearches') {
        const token = url.searchParams.get('token');

        if (token === 'typescript-token') {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              default: {
                rankedList: [
                  {
                    rankedKeyword: [
                      {
                        query: 'typescript tutorial',
                        value: 100,
                        formattedValue: '100',
                      },
                    ],
                  },
                ],
              },
            })}`,
            url.toString(),
          );
        }

        if (token === 'node-token') {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              default: {
                rankedList: [
                  {
                    rankedKeyword: [
                      {
                        query: 'node js download',
                        value: 100,
                        formattedValue: '100',
                      },
                    ],
                  },
                ],
              },
            })}`,
            url.toString(),
          );
        }

        if (token === 'topic-token') {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              default: {
                rankedList: [
                  {
                    rankedKeyword: [
                      {
                        topic: {
                          mid: '/m/07sbkfb',
                          title: 'TypeScript',
                          type: 'Programming language',
                        },
                        value: 100,
                        formattedValue: '100',
                      },
                    ],
                  },
                ],
              },
            })}`,
            url.toString(),
          );
        }
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

    const queryResults = await client.relatedQueries({
      keywords: ['TypeScript', 'Node.js'],
      geo: 'US',
    });

    expect(queryResults).toEqual([
      {
        keyword: 'TypeScript',
        top: [
          {
            query: 'typescript tutorial',
            value: 100,
            formattedValue: '100',
          },
        ],
        rising: [],
      },
      {
        keyword: 'Node.js',
        top: [
          {
            query: 'node js download',
            value: 100,
            formattedValue: '100',
          },
        ],
        rising: [],
      },
    ]);

    const topicResults = await client.relatedTopics({
      keywords: 'TypeScript',
      geo: 'US',
    });

    expect(topicResults[0]?.top[0]).toEqual({
      topic: {
        mid: '/m/07sbkfb',
        title: 'TypeScript',
        type: 'Programming language',
      },
      value: 100,
      formattedValue: '100',
    });

    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/trends/api/explore',
      '/trends/api/widgetdata/relatedsearches',
      '/trends/api/widgetdata/relatedsearches',
      '/trends/api/explore',
      '/trends/api/widgetdata/relatedsearches',
    ]);
    expect(requestedUrls[1]?.searchParams.get('token')).toBe('typescript-token');
    expect(requestedUrls[2]?.searchParams.get('token')).toBe('node-token');
  });

  it('falls back to per-keyword Explore when compared topic widgets are omitted', async () => {
    const requestedUrls: URL[] = [];

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);

      if (url.pathname === '/explore') {
        return responseWithUrl('<html>ready</html>', url.toString());
      }

      if (url.pathname === '/trends/api/explore') {
        const request = JSON.parse(url.searchParams.get('req') ?? '{}') as {
          comparisonItem?: { keyword?: string }[];
        };
        const keywords = request.comparisonItem?.map((item) => item.keyword ?? '') ?? [];

        if (keywords.length > 1) {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              widgets: [
                {
                  id: 'RELATED_QUERIES_0',
                  token: 'comparison-query-token',
                  request: widgetRequest(keywords[0] ?? ''),
                },
              ],
            })}`,
            url.toString(),
          );
        }

        const keyword = keywords[0];

        if (keyword === 'TypeScript') {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              widgets: [
                {
                  id: 'RELATED_TOPICS',
                  token: 'typescript-topic-token',
                  request: widgetRequest('TypeScript'),
                },
              ],
            })}`,
            url.toString(),
          );
        }

        if (keyword === 'Node.js') {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              widgets: [
                {
                  id: 'RELATED_TOPICS',
                  token: 'node-topic-token',
                  request: widgetRequest('Node.js'),
                },
              ],
            })}`,
            url.toString(),
          );
        }
      }

      if (url.pathname === '/trends/api/widgetdata/relatedsearches') {
        const token = url.searchParams.get('token');

        if (token === 'typescript-topic-token') {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              default: {
                rankedList: [
                  {
                    rankedKeyword: [
                      {
                        topic: {
                          mid: '/m/07sbkfb',
                          title: 'TypeScript',
                          type: 'Programming language',
                        },
                        value: 100,
                        formattedValue: '100',
                      },
                    ],
                  },
                ],
              },
            })}`,
            url.toString(),
          );
        }

        if (token === 'node-topic-token') {
          return responseWithUrl(
            `)]}',\n${JSON.stringify({
              default: {
                rankedList: [
                  {
                    rankedKeyword: [
                      {
                        topic: {
                          title: 'Node.js',
                          type: 'Runtime system',
                        },
                        value: 100,
                        formattedValue: '100',
                      },
                    ],
                  },
                ],
              },
            })}`,
            url.toString(),
          );
        }
      }

      return responseWithUrl('Not found', url.toString(), { status: 404 });
    };

    const client = createClient({
      locale: 'en-US',
      timezone: -300,
      retries: 0,
      rateLimit: { enabled: false },
      fetch: fakeFetch,
    });

    const results = await client.relatedTopics({
      keywords: ['TypeScript', 'Node.js'],
      geo: 'US',
    });

    expect(results).toEqual([
      {
        keyword: 'TypeScript',
        top: [
          {
            topic: {
              mid: '/m/07sbkfb',
              title: 'TypeScript',
              type: 'Programming language',
            },
            value: 100,
            formattedValue: '100',
          },
        ],
        rising: [],
      },
      {
        keyword: 'Node.js',
        top: [
          {
            topic: {
              title: 'Node.js',
              type: 'Runtime system',
            },
            value: 100,
            formattedValue: '100',
          },
        ],
        rising: [],
      },
    ]);

    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      '/trends/api/explore',
      '/trends/api/explore',
      '/trends/api/explore',
      '/trends/api/widgetdata/relatedsearches',
      '/trends/api/widgetdata/relatedsearches',
    ]);
    expect(requestedUrls[0]?.searchParams.get('req')).toContain('TypeScript');
    expect(requestedUrls[0]?.searchParams.get('req')).toContain('Node.js');
    expect(requestedUrls[1]?.searchParams.get('req')).toContain('TypeScript');
    expect(requestedUrls[1]?.searchParams.get('req')).not.toContain('Node.js');
    expect(requestedUrls[2]?.searchParams.get('req')).toContain('Node.js');
    expect(requestedUrls[2]?.searchParams.get('req')).not.toContain('TypeScript');
    expect(requestedUrls[3]?.searchParams.get('token')).toBe('typescript-topic-token');
    expect(requestedUrls[4]?.searchParams.get('token')).toBe('node-topic-token');
  });
});
