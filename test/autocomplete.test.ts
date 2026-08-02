import { describe, expect, it } from 'vitest';

import { InvalidResponseError } from '../src/errors.js';
import {
  normalizeAutocompleteKeyword,
  parseAutocompleteResponse,
} from '../src/google/autocomplete.js';
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

describe('autocomplete', () => {
  it('normalizes keywords and parses search terms and topics', () => {
    expect(normalizeAutocompleteKeyword('  TypeScript  ')).toBe('TypeScript');

    const result = parseAutocompleteResponse(
      {
        default: {
          searchTerms: [
            {
              title: 'TypeScript tutorial',
              type: 'Search term',
            },
          ],
          topics: [
            {
              mid: '/m/0n50hxv',
              title: 'TypeScript',
              type: 'Programming language',
            },
          ],
        },
      },
      'TypeScript',
      'https://trends.google.com/trends/api/autocomplete/TypeScript',
    );

    expect(result).toEqual({
      query: 'TypeScript',
      suggestions: [
        {
          keyword: 'TypeScript tutorial',
          title: 'TypeScript tutorial',
          type: 'Search term',
          kind: 'search-term',
        },
        {
          keyword: '/m/0n50hxv',
          title: 'TypeScript',
          type: 'Programming language',
          kind: 'topic',
          mid: '/m/0n50hxv',
        },
      ],
    });
  });

  it('supports the legacy topics-only response shape and applies limits', () => {
    const result = parseAutocompleteResponse(
      {
        default: {
          topics: [
            {
              mid: '/m/01',
              title: 'First topic',
              type: 'Topic',
            },
            {
              mid: '/m/02',
              title: 'Second topic',
              type: 'Topic',
            },
          ],
        },
      },
      'topic',
      'https://example.test/autocomplete',
      1,
    );

    expect(result.suggestions).toEqual([
      {
        keyword: '/m/01',
        title: 'First topic',
        type: 'Topic',
        kind: 'topic',
        mid: '/m/01',
      },
    ]);
  });

  it('rejects malformed responses', () => {
    expect(() =>
      parseAutocompleteResponse(
        { default: { topics: 'invalid' } },
        'TypeScript',
        'https://example.test/autocomplete',
      ),
    ).toThrow(InvalidResponseError);

    expect(() =>
      parseAutocompleteResponse({ default: {} }, 'TypeScript', 'https://example.test/autocomplete'),
    ).toThrow(InvalidResponseError);
  });

  it('requests the encoded autocomplete path without Explore warmup', async () => {
    const requestedUrls: URL[] = [];

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);

      return responseWithUrl(
        `)]}',\n${JSON.stringify({
          default: {
            topics: [
              {
                mid: '/m/0n50hxv',
                title: 'TypeScript',
                type: 'Programming language',
              },
            ],
          },
        })}`,
        url.toString(),
      );
    };

    const client = createClient({
      locale: 'en-US',
      retries: 0,
      fetch: fakeFetch,
    });

    const result = await client.autocomplete({
      keyword: 'C++ guide',
    });

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]?.pathname).toBe('/trends/api/autocomplete/C%2B%2B%20guide');
    expect(requestedUrls[0]?.searchParams.get('hl')).toBe('en-US');
    expect(result.suggestions[0]?.mid).toBe('/m/0n50hxv');
  });

  it('rejects invalid options before making a request', async () => {
    const fakeFetch: FetchLike = async () => {
      throw new Error('fetch must not be called');
    };

    const client = createClient({ fetch: fakeFetch });

    await expect(client.autocomplete({ keyword: '   ' })).rejects.toThrow(RangeError);
    await expect(client.autocomplete({ keyword: 'TypeScript', limit: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
