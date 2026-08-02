import { InvalidResponseError } from '../errors.js';
import type { HttpSession } from '../http/session.js';
import type { HttpRequestOptions } from '../types.js';
import { GOOGLE_TRENDING_NOW_PATH } from './constants.js';

const MAX_TRENDING_FEED_LENGTH = 5_000_000;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

export interface TrendingNowOptions {
  /** Two-letter country or territory code, for example "US" or "PK". */
  geo: string;
  /** Maximum number of trends to return. */
  limit?: number;
  signal?: AbortSignal;
}

export interface TrendingNowNewsItem {
  title: string;
  url: string;
  source: string;
  snippet?: string;
  pictureUrl?: string;
}

export interface TrendingNowItem {
  title: string;
  approxTraffic: string;
  /** Parsed lower-bound traffic estimate when the feed value is recognizable. */
  approxTrafficMin?: number;
  link: string;
  publishedAt: Date;
  pictureUrl?: string;
  pictureSource?: string;
  news: TrendingNowNewsItem[];
}

export interface TrendingNowResult {
  geo: string;
  trends: TrendingNowItem[];
}

interface FetchTrendingNowOptions extends TrendingNowOptions {
  locale: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTagBlocks(xml: string, tagName: string): string[] {
  const escapedTagName = escapeRegExp(tagName);
  const expression = new RegExp(
    `<${escapedTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTagName}\\s*>`,
    'gi',
  );

  return Array.from(xml.matchAll(expression), (match) => match[1] ?? '');
}

function extractTag(xml: string, tagName: string): string | undefined {
  return extractTagBlocks(xml, tagName)[0];
}

function decodeXmlEntity(entity: string): string {
  switch (entity) {
    case '&amp;':
      return '&';
    case '&lt;':
      return '<';
    case '&gt;':
      return '>';
    case '&quot;':
      return '"';
    case '&apos;':
      return "'";
    default: {
      const hexadecimalMatch = /^&#x([\da-f]+);$/i.exec(entity);
      const decimalMatch = /^&#(\d+);$/.exec(entity);
      const codePointText = hexadecimalMatch?.[1] ?? decimalMatch?.[1];

      if (codePointText === undefined) {
        return entity;
      }

      const radix = hexadecimalMatch === null ? 10 : 16;
      const codePoint = Number.parseInt(codePointText, radix);

      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return entity;
      }

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    }
  }
}

function decodeXmlText(value: string): string {
  const withoutCdata = value.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    (_match, content: string) => content,
  );

  return withoutCdata.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, decodeXmlEntity).trim();
}

function requireText(xml: string, tagName: string, fieldName: string, url: string): string {
  const rawValue = extractTag(xml, tagName);

  if (rawValue === undefined) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} is missing from the trending feed.`),
    );
  }

  const value = decodeXmlText(rawValue);

  if (value.length === 0) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} cannot be empty.`));
  }

  return value;
}

function optionalText(xml: string, tagName: string): string | undefined {
  const rawValue = extractTag(xml, tagName);

  if (rawValue === undefined) {
    return undefined;
  }

  const value = decodeXmlText(rawValue);
  return value.length === 0 ? undefined : value;
}

function requireHttpUrl(value: string, fieldName: string, url: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch (error) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} is not a valid URL.`, { cause: error }),
    );
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} must use HTTP or HTTPS.`));
  }

  return parsedUrl.toString();
}

function optionalHttpUrl(
  value: string | undefined,
  fieldName: string,
  url: string,
): string | undefined {
  return value === undefined ? undefined : requireHttpUrl(value, fieldName, url);
}

export function parseApproxTraffic(value: string): number | undefined {
  const normalized = value.replaceAll(',', '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*([KMB])?\+?$/i.exec(normalized);

  if (match === null) {
    return undefined;
  }

  const amount = Number(match[1]);

  if (!Number.isFinite(amount)) {
    return undefined;
  }

  const multiplier =
    match[2]?.toUpperCase() === 'K'
      ? 1_000
      : match[2]?.toUpperCase() === 'M'
        ? 1_000_000
        : match[2]?.toUpperCase() === 'B'
          ? 1_000_000_000
          : 1;

  return Math.round(amount * multiplier);
}

function parseNewsItem(xml: string, index: number, feedUrl: string): TrendingNowNewsItem {
  const fieldName = `items[].news[${index}]`;
  const title = requireText(xml, 'ht:news_item_title', `${fieldName}.title`, feedUrl);
  const source = requireText(xml, 'ht:news_item_source', `${fieldName}.source`, feedUrl);
  const url = requireHttpUrl(
    requireText(xml, 'ht:news_item_url', `${fieldName}.url`, feedUrl),
    `${fieldName}.url`,
    feedUrl,
  );
  const snippet = optionalText(xml, 'ht:news_item_snippet');
  const pictureUrl = optionalHttpUrl(
    optionalText(xml, 'ht:news_item_picture'),
    `${fieldName}.pictureUrl`,
    feedUrl,
  );

  const result: TrendingNowNewsItem = {
    title,
    url,
    source,
  };

  if (snippet !== undefined) {
    result.snippet = snippet;
  }

  if (pictureUrl !== undefined) {
    result.pictureUrl = pictureUrl;
  }

  return result;
}

function parseTrendingItem(xml: string, index: number, feedUrl: string): TrendingNowItem {
  const fieldName = `items[${index}]`;
  const title = requireText(xml, 'title', `${fieldName}.title`, feedUrl);
  const approxTraffic = requireText(
    xml,
    'ht:approx_traffic',
    `${fieldName}.approxTraffic`,
    feedUrl,
  );
  const link = requireHttpUrl(
    requireText(xml, 'link', `${fieldName}.link`, feedUrl),
    `${fieldName}.link`,
    feedUrl,
  );
  const pubDate = requireText(xml, 'pubDate', `${fieldName}.pubDate`, feedUrl);
  const publishedTimestamp = Date.parse(pubDate);

  if (Number.isNaN(publishedTimestamp)) {
    throw new InvalidResponseError(
      feedUrl,
      new TypeError(`${fieldName}.pubDate is not a valid date.`),
    );
  }

  const approxTrafficMin = parseApproxTraffic(approxTraffic);
  const pictureUrl = optionalHttpUrl(
    optionalText(xml, 'ht:picture'),
    `${fieldName}.pictureUrl`,
    feedUrl,
  );
  const pictureSource = optionalText(xml, 'ht:picture_source');
  const news = extractTagBlocks(xml, 'ht:news_item').map((item, newsIndex) =>
    parseNewsItem(item, newsIndex, feedUrl),
  );

  const result: TrendingNowItem = {
    title,
    approxTraffic,
    link,
    publishedAt: new Date(publishedTimestamp),
    news,
  };

  if (approxTrafficMin !== undefined) {
    result.approxTrafficMin = approxTrafficMin;
  }

  if (pictureUrl !== undefined) {
    result.pictureUrl = pictureUrl;
  }

  if (pictureSource !== undefined) {
    result.pictureSource = pictureSource;
  }

  return result;
}

export function normalizeTrendingNowGeo(geo: string): string {
  const normalized = geo.trim().toUpperCase();

  if (!COUNTRY_CODE_PATTERN.test(normalized)) {
    throw new RangeError('geo must be a two-letter country or territory code.');
  }

  return normalized;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('limit must be a positive integer.');
  }

  return limit;
}

export function parseTrendingNowFeed(
  xml: string,
  geo: string,
  url: string,
  limit?: number,
): TrendingNowResult {
  if (xml.length === 0 || xml.length > MAX_TRENDING_FEED_LENGTH) {
    throw new InvalidResponseError(
      url,
      new TypeError('Trending feed is empty or exceeds the supported size.'),
    );
  }

  if (/<!DOCTYPE/i.test(xml)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Trending feed must not contain a document type declaration.'),
    );
  }

  const channel = extractTag(xml, 'channel');

  if (channel === undefined) {
    throw new InvalidResponseError(url, new TypeError('Trending feed has no RSS channel.'));
  }

  const trends = extractTagBlocks(channel, 'item').map((item, index) =>
    parseTrendingItem(item, index, url),
  );

  return {
    geo,
    trends: limit === undefined ? trends : trends.slice(0, limit),
  };
}

export async function fetchTrendingNow(
  session: HttpSession,
  input: FetchTrendingNowOptions,
): Promise<TrendingNowResult> {
  const geo = normalizeTrendingNowGeo(input.geo);
  const limit = normalizeLimit(input.limit);
  const requestOptions: HttpRequestOptions = {
    method: 'GET',
    headers: {
      accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    },
    query: {
      geo,
      hl: input.locale,
    },
  };

  if (input.signal !== undefined) {
    requestOptions.signal = input.signal;
  }

  const response = await session.request(GOOGLE_TRENDING_NOW_PATH, requestOptions);
  const xml = await response.text();

  return parseTrendingNowFeed(xml, geo, response.url || GOOGLE_TRENDING_NOW_PATH, limit);
}
