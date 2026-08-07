import assert from 'node:assert/strict';

import { RateLimitError, createClient, getResultMetadata } from '../dist/index.mjs';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';
const EXPLORE_API_PATH = '/trends/api/explore';
const RELATED_SEARCHES_API_PATH = '/trends/api/widgetdata/relatedsearches';
const RELATED_QUERIES_WIDGET_ID = 'RELATED_QUERIES';

function readNonEmptyEnv(name, fallback) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();

  if (!raw) return fallback;

  const value = Number(raw);

  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer.`);
  }

  return value;
}

function parseKeywords() {
  const raw = readNonEmptyEnv('GOOGLE_TRENDS_TEST_KEYWORDS', 'typescript,javascript');
  const keywords = raw
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  if (keywords.length === 0 || keywords.length > 5) {
    throw new RangeError('GOOGLE_TRENDS_TEST_KEYWORDS must contain between 1 and 5 values.');
  }

  return keywords;
}

function parseGoogleJson(text) {
  let json = text.trimStart();

  if (json.startsWith(")]}'")) {
    json = json.slice(4);

    if (json.startsWith(',')) {
      json = json.slice(1);
    }

    json = json.trimStart();
  }

  return JSON.parse(json);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value, message) {
  assert.ok(isRecord(value), message);
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value, fieldName) {
  assert.equal(typeof value, 'number', `${fieldName} was not a number.`);
  assert.ok(Number.isFinite(value), `${fieldName} was not finite.`);
  return value;
}

function findSuccessfulCapture(captures, pathname) {
  const capture = [...captures]
    .reverse()
    .find((entry) => entry.pathname === pathname && entry.status >= 200 && entry.status < 300);

  assert.ok(capture, `No successful ${pathname} response was captured.`);
  return capture;
}

function findSuccessfulCaptures(captures, pathname) {
  return captures.filter(
    (entry) => entry.pathname === pathname && entry.status >= 200 && entry.status < 300,
  );
}

function buildManualCheckUrl({ keywords, geo, timeRange, category, property }) {
  const url = new URL('/trends/explore', GOOGLE_TRENDS_BASE_URL);
  url.searchParams.set('date', timeRange);
  url.searchParams.set('geo', geo);
  url.searchParams.set('q', keywords.join(','));

  if (category !== 0) {
    url.searchParams.set('cat', String(category));
  }

  if (property !== '') {
    url.searchParams.set('gprop', property);
  }

  return url.toString();
}

function extractWidgetKeyword(request) {
  const restriction = isRecord(request.restriction) ? request.restriction : undefined;
  const complexRestriction = isRecord(restriction?.complexKeywordsRestriction)
    ? restriction.complexKeywordsRestriction
    : undefined;
  const keywordList = Array.isArray(complexRestriction?.keyword)
    ? complexRestriction.keyword
    : undefined;
  const firstKeyword = isRecord(keywordList?.[0]) ? keywordList[0] : undefined;
  const value = optionalString(firstKeyword?.value);

  return value?.trim();
}

function isRelatedQueriesWidget(value) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.id === RELATED_QUERIES_WIDGET_ID || value.id.startsWith(`${RELATED_QUERIES_WIDGET_ID}_`))
  );
}

function pairWidgetsWithKeywords(widgets, keywords) {
  const candidates = widgets.filter(isRelatedQueriesWidget);

  assert.ok(candidates.length > 0, 'Explore response had no RELATED_QUERIES widgets.');
  assert.ok(
    candidates.length >= keywords.length,
    `Explore returned ${candidates.length} RELATED_QUERIES widgets for ${keywords.length} keywords.`,
  );

  const unusedWidgets = [...candidates];

  return keywords.map((keyword) => {
    const matchedIndex = unusedWidgets.findIndex(
      (widget) =>
        extractWidgetKeyword(requireRecord(widget.request, 'Widget request was invalid.')) ===
        keyword,
    );
    const selectedIndex = matchedIndex >= 0 ? matchedIndex : 0;
    const widget = unusedWidgets.splice(selectedIndex, 1)[0];

    assert.ok(widget, `No RELATED_QUERIES widget remained for ${keyword}.`);
    assert.equal(
      typeof widget.token,
      'string',
      `RELATED_QUERIES widget for ${keyword} had no token.`,
    );
    assert.ok(widget.token.length > 0, `RELATED_QUERIES widget for ${keyword} had an empty token.`);
    requireRecord(widget.request, `RELATED_QUERIES widget for ${keyword} had no request object.`);

    return { keyword, widget };
  });
}

function normalizeRawQueryItem(rawValue, fieldName) {
  const raw = requireRecord(rawValue, `${fieldName} was not an object.`);
  assert.equal(typeof raw.query, 'string', `${fieldName}.query was not a string.`);

  const query = raw.query.trim();
  assert.ok(query.length > 0, `${fieldName}.query was empty.`);

  const value = finiteNumber(raw.value, `${fieldName}.value`);
  const item = {
    query,
    value,
    formattedValue: optionalString(raw.formattedValue) ?? String(raw.value),
  };
  const link = optionalString(raw.link);

  if (link !== undefined) {
    item.link = link;
  }

  return item;
}

function normalizeRawRankedList(value, fieldName) {
  if (value === undefined) return [];

  const list = requireRecord(value, `${fieldName} was not an object.`);

  if (list.rankedKeyword === undefined) return [];

  assert.ok(Array.isArray(list.rankedKeyword), `${fieldName}.rankedKeyword was not an array.`);
  return list.rankedKeyword.map((item, index) =>
    normalizeRawQueryItem(item, `${fieldName}.rankedKeyword[${index}]`),
  );
}

function expectedListsFromRaw(rawPayload, keyword) {
  const root = requireRecord(
    rawPayload,
    `Related Queries response for ${keyword} was not an object.`,
  );
  const defaultPayload = requireRecord(
    root.default,
    `Related Queries response for ${keyword} had no default object.`,
  );
  const rankedList = defaultPayload.rankedList;

  if (rankedList === undefined) {
    return { top: [], rising: [] };
  }

  assert.ok(
    Array.isArray(rankedList),
    `Related Queries rankedList for ${keyword} was not an array.`,
  );

  return {
    top: normalizeRawRankedList(rankedList[0], `raw[${keyword}].default.rankedList[0]`),
    rising: normalizeRawRankedList(rankedList[1], `raw[${keyword}].default.rankedList[1]`),
  };
}

function validateExploreRequest(exploreCapture, expected) {
  const exploreUrl = new URL(exploreCapture.requestUrl);
  const exploreRequest = requireRecord(
    JSON.parse(exploreUrl.searchParams.get('req') ?? 'null'),
    'Explore request query did not contain a valid req object.',
  );

  assert.equal(exploreUrl.searchParams.get('hl'), expected.locale);
  assert.equal(exploreUrl.searchParams.get('tz'), String(expected.timezone));
  assert.deepEqual(exploreRequest.comparisonItem, expected.comparisonItems);
  assert.equal(exploreRequest.category, expected.category);
  assert.equal(exploreRequest.property, expected.property);
}

function validateRelatedRequests({ pairs, relatedCaptures, locale, timezone }) {
  assert.equal(
    relatedCaptures.length,
    pairs.length,
    `Captured ${relatedCaptures.length} successful related-search requests for ${pairs.length} keywords.`,
  );

  const captureByToken = new Map();

  for (const capture of relatedCaptures) {
    const url = new URL(capture.requestUrl);
    const token = url.searchParams.get('token');
    assert.ok(token, 'A successful Related Queries request had no token.');
    assert.ok(
      !captureByToken.has(token),
      `Related Queries token ${token} was requested more than once.`,
    );
    captureByToken.set(token, capture);
  }

  return pairs.map(({ keyword, widget }) => {
    const widgetRequest = requireRecord(
      widget.request,
      `Widget request for ${keyword} was invalid.`,
    );
    const capture = captureByToken.get(widget.token);
    assert.ok(capture, `No successful Related Queries response was captured for ${keyword}.`);

    const url = new URL(capture.requestUrl);
    const request = requireRecord(
      JSON.parse(url.searchParams.get('req') ?? 'null'),
      `Related Queries request for ${keyword} had no valid req object.`,
    );

    assert.equal(
      url.searchParams.get('hl'),
      locale,
      `Related Queries locale differed for ${keyword}.`,
    );
    assert.equal(
      url.searchParams.get('tz'),
      String(timezone),
      `Related Queries timezone differed for ${keyword}.`,
    );
    assert.equal(
      url.searchParams.get('token'),
      widget.token,
      `Related Queries token differed for ${keyword}.`,
    );
    assert.deepEqual(
      request,
      widgetRequest,
      `Related Queries widget request differed for ${keyword}.`,
    );

    return { keyword, widget, capture };
  });
}

function validatePackageAgainstRaw(result, capturedPairs) {
  assert.equal(
    result.length,
    capturedPairs.length,
    'Package result count differed from keyword count.',
  );

  const expectedResults = capturedPairs.map(({ keyword, capture }) => {
    const lists = expectedListsFromRaw(parseGoogleJson(capture.body), keyword);
    return {
      keyword,
      top: lists.top,
      rising: lists.rising,
    };
  });

  assert.deepEqual(
    result,
    expectedResults,
    'Package Related Queries output differed from the captured raw Google responses.',
  );

  return expectedResults;
}

function validateListIntegrity(items, { keyword, listName }) {
  const normalizedQueries = new Set();
  let linksCount = 0;

  for (const [index, item] of items.entries()) {
    assert.equal(
      typeof item.query,
      'string',
      `${keyword} ${listName}[${index}].query was not a string.`,
    );
    assert.ok(item.query.trim().length > 0, `${keyword} ${listName}[${index}].query was empty.`);
    assert.ok(
      Number.isFinite(item.value),
      `${keyword} ${listName}[${index}].value was not finite.`,
    );
    assert.ok(item.value >= 0, `${keyword} ${listName}[${index}].value was negative.`);
    assert.equal(
      typeof item.formattedValue,
      'string',
      `${keyword} ${listName}[${index}].formattedValue was not a string.`,
    );

    const normalizedQuery = item.query.trim().toLocaleLowerCase('en-US');
    assert.ok(
      !normalizedQueries.has(normalizedQuery),
      `${keyword} ${listName} contained duplicate query ${JSON.stringify(item.query)}.`,
    );
    normalizedQueries.add(normalizedQuery);

    if (item.link !== undefined) {
      assert.equal(
        typeof item.link,
        'string',
        `${keyword} ${listName}[${index}].link was invalid.`,
      );
      assert.ok(item.link.length > 0, `${keyword} ${listName}[${index}].link was empty.`);
      linksCount += 1;
    }
  }

  return {
    count: items.length,
    linksCount,
    minimumValue: items.length > 0 ? Math.min(...items.map((item) => item.value)) : undefined,
    maximumValue: items.length > 0 ? Math.max(...items.map((item) => item.value)) : undefined,
  };
}

function validateSemanticIntegrity(result, keywords) {
  assert.equal(result.length, keywords.length);

  const perKeyword = [];
  let totalTopCount = 0;
  let totalRisingCount = 0;

  for (const [index, keyword] of keywords.entries()) {
    const entry = result[index];
    assert.ok(entry, `Package result for ${keyword} was missing.`);
    assert.equal(entry.keyword, keyword, `Package keyword order changed at index ${index}.`);
    assert.ok(Array.isArray(entry.top), `${keyword}.top was not an array.`);
    assert.ok(Array.isArray(entry.rising), `${keyword}.rising was not an array.`);

    const top = validateListIntegrity(entry.top, { keyword, listName: 'top' });
    const rising = validateListIntegrity(entry.rising, { keyword, listName: 'rising' });
    totalTopCount += top.count;
    totalRisingCount += rising.count;

    perKeyword.push({ keyword, top, rising });
  }

  assert.ok(
    totalTopCount + totalRisingCount > 0,
    'Google returned no top or rising related queries for any requested keyword.',
  );

  return {
    keywordCount: result.length,
    totalTopCount,
    totalRisingCount,
    perKeyword,
  };
}

function toReportItem(item) {
  return {
    query: item.query,
    value: item.value,
    formattedValue: item.formattedValue,
    ...(item.link === undefined ? {} : { link: item.link }),
  };
}

function toReportKeywordResult(entry) {
  return {
    keyword: entry.keyword,
    topCount: entry.top.length,
    risingCount: entry.rising.length,
    topSample: entry.top.slice(0, 3).map(toReportItem),
    risingSample: entry.rising.slice(0, 3).map(toReportItem),
  };
}

const keywords = parseKeywords();
const geo = readNonEmptyEnv('GOOGLE_TRENDS_TEST_GEO', 'US').toUpperCase();
const timeRange = readNonEmptyEnv('GOOGLE_TRENDS_TEST_TIME_RANGE', 'today 12-m');
const locale = readNonEmptyEnv('GOOGLE_TRENDS_TEST_LOCALE', 'en-US');
const timezone = readIntegerEnv('GOOGLE_TRENDS_TEST_TIMEZONE', 0);
const category = readIntegerEnv('GOOGLE_TRENDS_TEST_CATEGORY', 0);
const property = readNonEmptyEnv('GOOGLE_TRENDS_TEST_PROPERTY', '');
const captures = [];
const nativeFetch = globalThis.fetch.bind(globalThis);

const captureFetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
  const response = await nativeFetch(input, init);

  if (
    requestUrl.pathname === EXPLORE_API_PATH ||
    requestUrl.pathname === RELATED_SEARCHES_API_PATH
  ) {
    captures.push({
      pathname: requestUrl.pathname,
      requestUrl: requestUrl.toString(),
      responseUrl: response.url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.clone().text(),
    });
  }

  return response;
};

const startedAt = new Date();

try {
  const client = createClient({
    locale,
    timezone,
    timeoutMs: 30_000,
    retries: 0,
    cache: { enabled: false },
    rateLimit: {
      minIntervalMs: 3_000,
      recovery: false,
    },
    fetch: captureFetch,
  });

  await client.warmup();

  const result = await client.relatedQueries({
    keywords,
    geo,
    timeRange,
    category,
    property,
  });

  const exploreCapture = findSuccessfulCapture(captures, EXPLORE_API_PATH);
  const relatedCaptures = findSuccessfulCaptures(captures, RELATED_SEARCHES_API_PATH);
  const comparisonItems = keywords.map((keyword) => ({ keyword, geo, time: timeRange }));

  validateExploreRequest(exploreCapture, {
    locale,
    timezone,
    comparisonItems,
    category,
    property,
  });

  const explorePayload = requireRecord(
    parseGoogleJson(exploreCapture.body),
    'Explore response was not an object.',
  );
  assert.ok(Array.isArray(explorePayload.widgets), 'Explore response had no widgets array.');

  const pairs = pairWidgetsWithKeywords(explorePayload.widgets, keywords);
  const capturedPairs = validateRelatedRequests({
    pairs,
    relatedCaptures,
    locale,
    timezone,
  });

  validatePackageAgainstRaw(result, capturedPairs);
  const integrity = validateSemanticIntegrity(result, keywords);
  const metadata = getResultMetadata(result);

  assert.deepEqual(metadata, { source: 'network', stale: false });

  const report = {
    status: 'passed',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    packageValidation: {
      builtDistributionUsed: true,
      requestParametersMatchInput: true,
      widgetKeywordPairingValid: true,
      relatedSearchRequestsMatchExploreWidgets: true,
      packageOutputExactlyMatchesRawGoogleResponses: true,
      queryRowsSemanticallyValid: true,
      metadata,
    },
    input: {
      keywords,
      geo,
      timeRange,
      locale,
      timezone,
      category,
      property,
    },
    result: {
      integrity,
      keywords: result.map(toReportKeywordResult),
    },
    rawGoogleResponses: {
      exploreStatus: exploreCapture.status,
      relatedSearchStatus: relatedCaptures.map((capture) => capture.status),
      relatedSearchContentTypes: relatedCaptures.map((capture) => capture.contentType),
      responseCount: relatedCaptures.length,
    },
    manualCheckUrl: buildManualCheckUrl({ keywords, geo, timeRange, category, property }),
  };

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    status: error instanceof RateLimitError ? 'rate-limited' : 'failed',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    input: {
      keywords,
      geo,
      timeRange,
      locale,
      timezone,
      category,
      property,
    },
    error: {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof RateLimitError
        ? { url: error.url, retryAfterMs: error.retryAfterMs }
        : {}),
    },
  };

  console.error(JSON.stringify(report, null, 2));
  process.exitCode = error instanceof RateLimitError ? 2 : 1;
}
