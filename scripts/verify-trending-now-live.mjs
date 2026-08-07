import assert from 'node:assert/strict';

import { RateLimitError, createClient, getResultMetadata } from '../dist/index.mjs';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';
const TRENDING_RSS_PATH = '/trending/rss';
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function readNonEmptyEnv(name, fallback) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();

  if (!raw) return fallback;

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }

  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTagBlocks(xml, tagName) {
  const escaped = escapeRegExp(tagName);
  const expression = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'gi');

  return Array.from(xml.matchAll(expression), (match) => match[1] ?? '');
}

function extractTag(xml, tagName) {
  return extractTagBlocks(xml, tagName)[0];
}

function decodeEntity(entity) {
  const named = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
  };

  if (entity in named) return named[entity];

  const hex = /^&#x([\da-f]+);$/i.exec(entity);
  const decimal = /^&#(\d+);$/.exec(entity);
  const digits = hex?.[1] ?? decimal?.[1];

  if (digits === undefined) return entity;

  const codePoint = Number.parseInt(digits, hex === null ? 10 : 16);

  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
}

function decodeXmlText(value) {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, content) => content);

  return withoutCdata.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, decodeEntity).trim();
}

function requiredText(xml, tagName, fieldName) {
  const raw = extractTag(xml, tagName);
  assert.notEqual(raw, undefined, `${fieldName} was missing from Google's RSS feed.`);

  const value = decodeXmlText(raw);
  assert.ok(value.length > 0, `${fieldName} was empty in Google's RSS feed.`);
  return value;
}

function optionalText(xml, tagName) {
  const raw = extractTag(xml, tagName);

  if (raw === undefined) return undefined;

  const value = decodeXmlText(raw);
  return value.length > 0 ? value : undefined;
}

function normalizeHttpUrl(value, fieldName) {
  let url;

  try {
    url = new URL(value);
  } catch (error) {
    assert.fail(`${fieldName} was not a valid URL: ${String(error)}`);
  }

  assert.ok(
    url.protocol === 'http:' || url.protocol === 'https:',
    `${fieldName} did not use HTTP or HTTPS.`,
  );

  return url.toString();
}

function parseTrafficLowerBound(value) {
  const normalized = value.replaceAll(',', '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*([KMB])?\+?$/i.exec(normalized);

  if (match === null) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;

  const suffix = match[2]?.toUpperCase();
  const multiplier =
    suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;

  return Math.round(amount * multiplier);
}

function parseRawNewsItem(xml, itemIndex, newsIndex) {
  const prefix = `raw.items[${itemIndex}].news[${newsIndex}]`;
  const title = requiredText(xml, 'ht:news_item_title', `${prefix}.title`);
  const source = requiredText(xml, 'ht:news_item_source', `${prefix}.source`);
  const url = normalizeHttpUrl(
    requiredText(xml, 'ht:news_item_url', `${prefix}.url`),
    `${prefix}.url`,
  );
  const snippet = optionalText(xml, 'ht:news_item_snippet');
  const rawPicture = optionalText(xml, 'ht:news_item_picture');

  return {
    title,
    url,
    source,
    ...(snippet === undefined ? {} : { snippet }),
    ...(rawPicture === undefined
      ? {}
      : { pictureUrl: normalizeHttpUrl(rawPicture, `${prefix}.pictureUrl`) }),
  };
}

function parseRawTrendingFeed(xml, geo, limit) {
  assert.ok(xml.length > 0, 'Google returned an empty Trending Now RSS body.');
  assert.ok(!/<!DOCTYPE/i.test(xml), 'Google Trending Now RSS unexpectedly contained a DOCTYPE.');

  const channel = extractTag(xml, 'channel');
  assert.notEqual(channel, undefined, 'Google Trending Now RSS had no channel element.');

  const rawItems = extractTagBlocks(channel, 'item');
  const allTrends = rawItems.map((xmlItem, itemIndex) => {
    const prefix = `raw.items[${itemIndex}]`;
    const title = requiredText(xmlItem, 'title', `${prefix}.title`);
    const approxTraffic = requiredText(xmlItem, 'ht:approx_traffic', `${prefix}.approxTraffic`);
    const link = normalizeHttpUrl(
      requiredText(xmlItem, 'link', `${prefix}.link`),
      `${prefix}.link`,
    );
    const pubDate = requiredText(xmlItem, 'pubDate', `${prefix}.pubDate`);
    const timestamp = Date.parse(pubDate);

    assert.ok(Number.isFinite(timestamp), `${prefix}.pubDate was not a valid date.`);

    const rawPicture = optionalText(xmlItem, 'ht:picture');
    const pictureSource = optionalText(xmlItem, 'ht:picture_source');
    const approxTrafficMin = parseTrafficLowerBound(approxTraffic);
    const news = extractTagBlocks(xmlItem, 'ht:news_item').map((newsItem, newsIndex) =>
      parseRawNewsItem(newsItem, itemIndex, newsIndex),
    );

    return {
      title,
      approxTraffic,
      ...(approxTrafficMin === undefined ? {} : { approxTrafficMin }),
      link,
      publishedAt: new Date(timestamp),
      ...(rawPicture === undefined
        ? {}
        : { pictureUrl: normalizeHttpUrl(rawPicture, `${prefix}.pictureUrl`) }),
      ...(pictureSource === undefined ? {} : { pictureSource }),
      news,
    };
  });

  return {
    rawItemCount: allTrends.length,
    result: {
      geo,
      trends: allTrends.slice(0, limit),
    },
  };
}

function validateRequest(capture, { geo, locale }) {
  const url = new URL(capture.requestUrl);

  assert.equal(url.pathname, TRENDING_RSS_PATH);
  assert.equal(url.searchParams.get('geo'), geo, 'RSS geo query did not match input.');
  assert.equal(url.searchParams.get('hl'), locale, 'RSS hl query did not match client locale.');
  assert.equal(
    url.searchParams.getAll('geo').length,
    1,
    'RSS request contained duplicate geo params.',
  );
  assert.equal(
    url.searchParams.getAll('hl').length,
    1,
    'RSS request contained duplicate hl params.',
  );

  const accept = capture.requestHeaders.get('accept') ?? '';
  assert.ok(
    accept.includes('application/rss+xml'),
    'RSS request Accept header did not advertise application/rss+xml.',
  );
}

function validateSemanticIntegrity(result, rawItemCount, limit) {
  assert.equal(result.trends.length, Math.min(rawItemCount, limit));
  assert.ok(result.trends.length > 0, 'Google Trending Now returned no trends.');

  let newsCount = 0;
  let parsedTrafficCount = 0;
  let pictureCount = 0;
  let newestTimestamp = -Infinity;
  let oldestTimestamp = Infinity;

  for (const [index, trend] of result.trends.entries()) {
    assert.ok(trend.title.trim().length > 0, `Trend ${index} had an empty title.`);
    assert.ok(trend.approxTraffic.trim().length > 0, `Trend ${index} had empty traffic text.`);
    assert.ok(!Number.isNaN(trend.publishedAt.getTime()), `Trend ${index} had an invalid date.`);
    normalizeHttpUrl(trend.link, `result.trends[${index}].link`);

    if (trend.approxTrafficMin !== undefined) {
      assert.ok(
        Number.isSafeInteger(trend.approxTrafficMin) && trend.approxTrafficMin >= 0,
        `Trend ${index} had an invalid approxTrafficMin.`,
      );
      parsedTrafficCount += 1;
    }

    if (trend.pictureUrl !== undefined) {
      normalizeHttpUrl(trend.pictureUrl, `result.trends[${index}].pictureUrl`);
      pictureCount += 1;
    }

    if (trend.pictureSource !== undefined) {
      assert.ok(
        trend.pictureSource.trim().length > 0,
        `Trend ${index} had an empty pictureSource.`,
      );
    }

    const timestamp = trend.publishedAt.getTime();
    newestTimestamp = Math.max(newestTimestamp, timestamp);
    oldestTimestamp = Math.min(oldestTimestamp, timestamp);

    for (const [newsIndex, news] of trend.news.entries()) {
      assert.ok(
        news.title.trim().length > 0,
        `Trend ${index} news ${newsIndex} had an empty title.`,
      );
      assert.ok(
        news.source.trim().length > 0,
        `Trend ${index} news ${newsIndex} had an empty source.`,
      );
      normalizeHttpUrl(news.url, `result.trends[${index}].news[${newsIndex}].url`);

      if (news.pictureUrl !== undefined) {
        normalizeHttpUrl(news.pictureUrl, `result.trends[${index}].news[${newsIndex}].pictureUrl`);
      }

      newsCount += 1;
    }
  }

  const now = Date.now();
  const newestAgeHours = (now - newestTimestamp) / 3_600_000;
  const spanHours = (newestTimestamp - oldestTimestamp) / 3_600_000;

  assert.ok(newestAgeHours >= -24, 'Newest trending item was unexpectedly far in the future.');
  assert.ok(newestAgeHours <= 168, 'Newest trending item was more than seven days old.');

  return {
    returnedCount: result.trends.length,
    rawFeedItemCount: rawItemCount,
    appliedLimit: limit,
    newsCount,
    parsedTrafficCount,
    pictureCount,
    newestAgeHours: Number(newestAgeHours.toFixed(2)),
    feedSpanHours: Number(spanHours.toFixed(2)),
  };
}

function toReportTrend(trend) {
  return {
    title: trend.title,
    approxTraffic: trend.approxTraffic,
    ...(trend.approxTrafficMin === undefined ? {} : { approxTrafficMin: trend.approxTrafficMin }),
    link: trend.link,
    publishedAt: trend.publishedAt.toISOString(),
    ...(trend.pictureUrl === undefined ? {} : { pictureUrl: trend.pictureUrl }),
    ...(trend.pictureSource === undefined ? {} : { pictureSource: trend.pictureSource }),
    newsCount: trend.news.length,
    newsSample: trend.news.slice(0, 2),
  };
}

const geo = readNonEmptyEnv('GOOGLE_TRENDS_TEST_GEO', 'US').toUpperCase();
const locale = readNonEmptyEnv('GOOGLE_TRENDS_TEST_LOCALE', 'en-US');
const limit = readPositiveIntegerEnv('GOOGLE_TRENDS_TEST_TREND_LIMIT', 10);

if (!COUNTRY_CODE_PATTERN.test(geo)) {
  throw new RangeError('GOOGLE_TRENDS_TEST_GEO must be a two-letter country or territory code.');
}

const captures = [];
const nativeFetch = globalThis.fetch.bind(globalThis);

const captureFetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
  const response = await nativeFetch(input, init);

  if (requestUrl.pathname === TRENDING_RSS_PATH) {
    captures.push({
      requestUrl: requestUrl.toString(),
      status: response.status,
      contentType: response.headers.get('content-type'),
      requestHeaders: new Headers(init?.headers),
      body: await response.clone().text(),
    });
  }

  return response;
};

const startedAt = new Date();

try {
  const client = createClient({
    locale,
    timeoutMs: 30_000,
    retries: 0,
    cache: { enabled: false },
    rateLimit: {
      minIntervalMs: 3_000,
      recovery: false,
    },
    fetch: captureFetch,
  });

  const result = await client.trendingNow({ geo, limit });
  const successfulCaptures = captures.filter(
    (capture) => capture.status >= 200 && capture.status < 300,
  );

  assert.equal(
    captures.length,
    1,
    `Expected exactly one Trending RSS request, got ${captures.length}.`,
  );
  assert.equal(
    successfulCaptures.length,
    1,
    'Expected exactly one successful Trending RSS response.',
  );

  const capture = successfulCaptures[0];
  assert.ok(capture);
  validateRequest(capture, { geo, locale });

  const raw = parseRawTrendingFeed(capture.body, geo, limit);
  assert.deepEqual(
    result,
    raw.result,
    "Package Trending Now output differed from Google's raw RSS feed.",
  );

  const integrity = validateSemanticIntegrity(result, raw.rawItemCount, limit);
  const metadata = getResultMetadata(result);

  assert.deepEqual(metadata, { source: 'network', stale: false });

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        packageValidation: {
          builtDistributionUsed: true,
          requestParametersMatchInput: true,
          rssAcceptHeaderValid: true,
          packageOutputExactlyMatchesRawGoogleRss: true,
          trendingRowsSemanticallyValid: true,
          metadata,
        },
        input: {
          geo,
          locale,
          limit,
        },
        result: {
          integrity,
          samples: result.trends.slice(0, 3).map(toReportTrend),
        },
        rawGoogleResponse: {
          status: capture.status,
          contentType: capture.contentType,
          responseCount: successfulCaptures.length,
          rawFeedItemCount: raw.rawItemCount,
        },
        manualCheckUrl: new URL(
          `/trending?geo=${encodeURIComponent(geo)}`,
          GOOGLE_TRENDS_BASE_URL,
        ).toString(),
      },
      null,
      2,
    ),
  );
} catch (error) {
  const completedAt = new Date().toISOString();

  if (error instanceof RateLimitError) {
    console.log(
      JSON.stringify(
        {
          status: 'rate-limited',
          startedAt: startedAt.toISOString(),
          completedAt,
          input: { geo, locale, limit },
          error: {
            name: error.name,
            message: error.message,
            url: error.url,
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  } else {
    console.log(
      JSON.stringify(
        {
          status: 'failed',
          startedAt: startedAt.toISOString(),
          completedAt,
          input: { geo, locale, limit },
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
