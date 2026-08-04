import { describe, expect, it } from 'vitest';

import { InvalidResponseError } from '../src/errors.js';
import {
  normalizeTrendingNowGeo,
  parseApproxTraffic,
  parseTrendingNowFeed,
} from '../src/google/trending-now.js';
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

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss">
  <channel>
    <title>Daily Search Trends</title>
    <item>
      <title><![CDATA[TypeScript & Node.js]]></title>
      <ht:approx_traffic>50,000+</ht:approx_traffic>
      <link>https://trends.google.com/trending?geo=PK&amp;q=typescript</link>
      <pubDate>Sun, 02 Aug 2026 09:00:00 +0000</pubDate>
      <ht:picture>https://images.example.test/typescript.jpg</ht:picture>
      <ht:picture_source>Example News</ht:picture_source>
      <ht:news_item>
        <ht:news_item_title>TypeScript reaches a new milestone</ht:news_item_title>
        <ht:news_item_snippet><![CDATA[Developers discuss <strong>new features</strong>.]]></ht:news_item_snippet>
        <ht:news_item_url>https://news.example.test/typescript?ref=trends&amp;lang=en</ht:news_item_url>
        <ht:news_item_picture>https://images.example.test/news.jpg</ht:news_item_picture>
        <ht:news_item_source>Example News</ht:news_item_source>
      </ht:news_item>
    </item>
    <item>
      <title>Node.js</title>
      <ht:approx_traffic>2K+</ht:approx_traffic>
      <link>https://trends.google.com/trending?geo=PK&amp;q=node</link>
      <pubDate>Sun, 02 Aug 2026 08:00:00 +0000</pubDate>
      <ht:picture />
      <ht:picture_source />
    </item>
  </channel>
</rss>`;

describe('trendingNow', () => {
  it('normalizes country codes and traffic estimates', () => {
    expect(normalizeTrendingNowGeo(' pk ')).toBe('PK');
    expect(parseApproxTraffic('50,000+')).toBe(50_000);
    expect(parseApproxTraffic('2K+')).toBe(2_000);
    expect(parseApproxTraffic('1.5M+')).toBe(1_500_000);
    expect(parseApproxTraffic('localized value')).toBeUndefined();
  });

  it('parses trends, optional pictures, and related news', () => {
    const result = parseTrendingNowFeed(
      SAMPLE_FEED,
      'PK',
      'https://trends.google.com/trending/rss?geo=PK',
    );

    expect(result.geo).toBe('PK');
    expect(result.trends).toHaveLength(2);
    expect(result.trends[0]).toEqual({
      title: 'TypeScript & Node.js',
      approxTraffic: '50,000+',
      approxTrafficMin: 50_000,
      link: 'https://trends.google.com/trending?geo=PK&q=typescript',
      publishedAt: new Date('2026-08-02T09:00:00.000Z'),
      pictureUrl: 'https://images.example.test/typescript.jpg',
      pictureSource: 'Example News',
      news: [
        {
          title: 'TypeScript reaches a new milestone',
          snippet: 'Developers discuss <strong>new features</strong>.',
          url: 'https://news.example.test/typescript?ref=trends&lang=en',
          pictureUrl: 'https://images.example.test/news.jpg',
          source: 'Example News',
        },
      ],
    });
    expect(result.trends[1]).toMatchObject({
      title: 'Node.js',
      approxTrafficMin: 2_000,
      news: [],
    });
    expect(result.trends[1]).not.toHaveProperty('pictureUrl');
  });

  it('applies a result limit', () => {
    const result = parseTrendingNowFeed(SAMPLE_FEED, 'PK', 'https://example.test/feed', 1);

    expect(result.trends).toHaveLength(1);
  });

  it('rejects malformed or unsafe feeds', () => {
    expect(() =>
      parseTrendingNowFeed(
        '<rss><channel><item><title>Missing fields</title></item></channel></rss>',
        'US',
        'https://example.test/feed',
      ),
    ).toThrow(InvalidResponseError);

    expect(() =>
      parseTrendingNowFeed(
        '<!DOCTYPE rss><rss><channel></channel></rss>',
        'US',
        'https://example.test/feed',
      ),
    ).toThrow(InvalidResponseError);
  });

  it('requests the RSS feed without an Explore-session warmup', async () => {
    const requestedUrls: URL[] = [];
    const requestHeaders: Headers[] = [];

    const fakeFetch: FetchLike = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);
      requestHeaders.push(new Headers(init?.headers));

      return responseWithUrl(SAMPLE_FEED, url.toString(), {
        status: 200,
        headers: {
          'content-type': 'application/rss+xml; charset=UTF-8',
        },
      });
    };

    const client = createClient({
      locale: 'en-US',
      retries: 0,
      rateLimit: { enabled: false },
      fetch: fakeFetch,
    });

    const result = await client.trendingNow({
      geo: 'pk',
      limit: 1,
    });

    expect(requestedUrls.map((url) => url.pathname)).toEqual(['/trending/rss']);
    expect(requestedUrls[0]?.searchParams.get('geo')).toBe('PK');
    expect(requestedUrls[0]?.searchParams.get('hl')).toBe('en-US');
    expect(requestHeaders[0]?.get('accept')).toContain('application/rss+xml');
    expect(result.trends).toHaveLength(1);
  });

  it('rejects invalid options before making a request', async () => {
    const fakeFetch: FetchLike = async () => {
      throw new Error('fetch must not be called');
    };

    const client = createClient({
      rateLimit: { enabled: false },
      fetch: fakeFetch,
    });

    await expect(client.trendingNow({ geo: 'Pakistan' })).rejects.toThrow(RangeError);
    await expect(client.trendingNow({ geo: 'PK', limit: 0 })).rejects.toThrow(RangeError);
  });
});
