import assert from 'node:assert/strict';

import { RateLimitError, createClient, getResultMetadata } from '../dist/index.mjs';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';
const EXPLORE_API_PATH = '/trends/api/explore';
const RELATED_SEARCHES_API_PATH = '/trends/api/widgetdata/relatedsearches';
const RELATED_TOPICS_WIDGET_ID = 'RELATED_TOPICS';

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

function isRelatedTopicsWidget(value) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.id === RELATED_TOPICS_WIDGET_ID || value.id.startsWith(`${RELATED_TOPICS_WIDGET_ID}_`))
  );
}

function pairWidgetsWithKeywords(widgets, keywords) {
  const candidates = widgets.filter(isRelatedTopicsWidget);

  assert.ok(candidates.length > 0, 'Explore response had no RELATED_TOPICS widgets.');
  assert.ok(
    candidates.length >= keywords.length,
    `Explore returned ${candidates.length} RELATED_TOPICS widgets for ${keywords.length} keywords.`,
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

    assert.ok(widget, `No RELATED_TOPICS widget remained for ${keyword}.`);
    assert.equal(
      typeof widget.token,
      'string',
      `RELATED_TOPICS widget for ${keyword} had no token.`,
    );
    assert.ok(widget.token.length > 0, `RELATED_TOPICS widget for ${keyword} had an empty token.`);
    requireRecord(widget.request, `RELATED_TOPICS widget for ${keyword} had no request object.`);

    return { keyword, widget };
  });
}

function normalizeRawTopicItem(rawValue, fieldName) {
  const raw = requireRecord(rawValue, `${fieldName} was not an object.`);
  const rawTopic = requireRecord(raw.topic, `${fieldName}.topic was not an object.`);

  assert.equal(typeof rawTopic.title, 'string', `${fieldName}.topic.title was not a string.`);
  const title = rawTopic.title.trim();
  assert.ok(title.length > 0, `${fieldName}.topic.title was empty.`);

  const topic = { title };
  const mid = optionalString(rawTopic.mid);
  const type = optionalString(rawTopic.type);

  if (mid !== undefined) {
    topic.mid = mid;
  }

  if (type !== undefined) {
    topic.type = type;
  }

  const value = finiteNumber(raw.value, `${fieldName}.value`);
  const item = {
    topic,
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
    normalizeRawTopicItem(item, `${fieldName}.rankedKeyword[${index}]`),
  );
}

function expectedListsFromRaw(rawPayload, keyword) {
  const root = requireRecord(
    rawPayload,
    `Related Topics response for ${keyword} was not an object.`,
  );
  const defaultPayload = requireRecord(
    root.default,
    `Related Topics response for ${keyword} had no default object.`,
  );
  const rankedList = defaultPayload.rankedList;

  if (rankedList === undefined) {
    return { top: [], rising: [] };
  }

  assert.ok(
    Array.isArray(rankedList),
    `Related Topics rankedList for ${keyword} was not an array.`,
  );

  return {
    top: normalizeRawRankedList(rankedList[0], `raw[${keyword}].default.rankedList[0]`),
    rising: normalizeRawRankedList(rankedList[1], `raw[${keyword}].default.rankedList[1]`),
  };
}

function parseExploreCapture(capture) {
  const url = new URL(capture.requestUrl);
  const request = requireRecord(
    JSON.parse(url.searchParams.get('req') ?? 'null'),
    'Explore request query did not contain a valid req object.',
  );
  const payload = requireRecord(
    parseGoogleJson(capture.body),
    'Explore response was not an object.',
  );

  assert.ok(Array.isArray(payload.widgets), 'Explore response had no widgets array.');

  return { capture, url, request, widgets: payload.widgets };
}

function validateExploreRequest(detail, expected, label) {
  assert.equal(detail.url.searchParams.get('hl'), expected.locale, `${label} locale differed.`);
  assert.equal(
    detail.url.searchParams.get('tz'),
    String(expected.timezone),
    `${label} timezone differed.`,
  );
  assert.deepEqual(
    detail.request.comparisonItem,
    expected.comparisonItems,
    `${label} comparison items differed.`,
  );
  assert.equal(detail.request.category, expected.category, `${label} category differed.`);
  assert.equal(detail.request.property, expected.property, `${label} property differed.`);
}

function resolveTopicPairsFromExploreCaptures({
  exploreCaptures,
  keywords,
  comparisonItems,
  locale,
  timezone,
  category,
  property,
}) {
  assert.ok(exploreCaptures.length > 0, 'No successful Explore response was captured.');

  const details = exploreCaptures.map(parseExploreCapture);
  const primary = details[0];

  validateExploreRequest(
    primary,
    { locale, timezone, comparisonItems, category, property },
    'Primary Explore request',
  );

  const primaryTopicCount = primary.widgets.filter(isRelatedTopicsWidget).length;

  if (primaryTopicCount >= keywords.length) {
    return {
      pairs: pairWidgetsWithKeywords(primary.widgets, keywords),
      fallbackUsed: false,
      primaryTopicCount,
      exploreRequestCount: details.length,
    };
  }

  assert.ok(keywords.length > 1, 'Single-keyword Explore response had no RELATED_TOPICS widget.');

  const pairs = [];
  const usedDetails = new Set([primary]);

  for (const [index, keyword] of keywords.entries()) {
    const expectedItem = comparisonItems[index];
    assert.ok(expectedItem, `No expected comparison item exists for ${keyword}.`);

    const detail = details.find((candidate) => {
      if (usedDetails.has(candidate)) return false;
      const items = candidate.request.comparisonItem;
      return (
        Array.isArray(items) &&
        items.length === 1 &&
        isRecord(items[0]) &&
        items[0].keyword === keyword
      );
    });

    assert.ok(detail, `No single-keyword Explore fallback was captured for ${keyword}.`);
    validateExploreRequest(
      detail,
      {
        locale,
        timezone,
        comparisonItems: [expectedItem],
        category,
        property,
      },
      `Single-keyword Explore fallback for ${keyword}`,
    );
    usedDetails.add(detail);

    const [pair] = pairWidgetsWithKeywords(detail.widgets, [keyword]);
    assert.ok(pair, `Single-keyword Explore fallback produced no topic pair for ${keyword}.`);
    pairs.push(pair);
  }

  return {
    pairs,
    fallbackUsed: true,
    primaryTopicCount,
    exploreRequestCount: details.length,
  };
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
    assert.ok(token, 'A successful Related Topics request had no token.');
    assert.ok(
      !captureByToken.has(token),
      `Related Topics token ${token} was requested more than once.`,
    );
    captureByToken.set(token, capture);
  }

  return pairs.map(({ keyword, widget }) => {
    const widgetRequest = requireRecord(
      widget.request,
      `Widget request for ${keyword} was invalid.`,
    );
    const capture = captureByToken.get(widget.token);
    assert.ok(capture, `No successful Related Topics response was captured for ${keyword}.`);

    const url = new URL(capture.requestUrl);
    const request = requireRecord(
      JSON.parse(url.searchParams.get('req') ?? 'null'),
      `Related Topics request for ${keyword} had no valid req object.`,
    );

    assert.equal(
      url.searchParams.get('hl'),
      locale,
      `Related Topics locale differed for ${keyword}.`,
    );
    assert.equal(
      url.searchParams.get('tz'),
      String(timezone),
      `Related Topics timezone differed for ${keyword}.`,
    );
    assert.equal(
      url.searchParams.get('token'),
      widget.token,
      `Related Topics token differed for ${keyword}.`,
    );
    assert.deepEqual(
      request,
      widgetRequest,
      `Related Topics widget request differed for ${keyword}.`,
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
    'Package Related Topics output differed from the captured raw Google responses.',
  );

  return expectedResults;
}

function topicIdentity(item) {
  if (item.topic.mid !== undefined) {
    return `mid:${item.topic.mid}`;
  }

  return `title:${item.topic.title.trim().toLocaleLowerCase('en-US')}|type:${(
    item.topic.type ?? ''
  ).toLocaleLowerCase('en-US')}`;
}

function validateListIntegrity(items, { keyword, listName }) {
  const identities = new Set();
  let linksCount = 0;
  let midsCount = 0;
  let typesCount = 0;
  let breakoutCount = 0;

  for (const [index, item] of items.entries()) {
    assert.ok(isRecord(item.topic), `${keyword} ${listName}[${index}].topic was not an object.`);
    assert.equal(
      typeof item.topic.title,
      'string',
      `${keyword} ${listName}[${index}].topic.title was not a string.`,
    );
    assert.ok(
      item.topic.title.trim().length > 0,
      `${keyword} ${listName}[${index}].topic.title was empty.`,
    );
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

    if (item.topic.mid !== undefined) {
      assert.equal(
        typeof item.topic.mid,
        'string',
        `${keyword} ${listName}[${index}].topic.mid was invalid.`,
      );
      assert.ok(item.topic.mid.length > 0, `${keyword} ${listName}[${index}].topic.mid was empty.`);
      midsCount += 1;
    }

    if (item.topic.type !== undefined) {
      assert.equal(
        typeof item.topic.type,
        'string',
        `${keyword} ${listName}[${index}].topic.type was invalid.`,
      );
      assert.ok(
        item.topic.type.length > 0,
        `${keyword} ${listName}[${index}].topic.type was empty.`,
      );
      typesCount += 1;
    }

    const identity = topicIdentity(item);
    assert.ok(
      !identities.has(identity),
      `${keyword} ${listName} contained duplicate topic identity ${JSON.stringify(identity)}.`,
    );
    identities.add(identity);

    if (item.link !== undefined) {
      assert.equal(
        typeof item.link,
        'string',
        `${keyword} ${listName}[${index}].link was invalid.`,
      );
      assert.ok(item.link.length > 0, `${keyword} ${listName}[${index}].link was empty.`);
      linksCount += 1;
    }

    if (item.formattedValue === 'Breakout') {
      breakoutCount += 1;
    }
  }

  return {
    count: items.length,
    linksCount,
    midsCount,
    typesCount,
    breakoutCount,
    minimumValue: items.length > 0 ? Math.min(...items.map((item) => item.value)) : undefined,
    maximumValue: items.length > 0 ? Math.max(...items.map((item) => item.value)) : undefined,
  };
}

function validateSemanticIntegrity(result, keywords) {
  assert.equal(result.length, keywords.length);

  const perKeyword = [];
  let totalTopCount = 0;
  let totalRisingCount = 0;
  let emptyKeywordCount = 0;

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

    if (top.count === 0 && rising.count === 0) {
      emptyKeywordCount += 1;
    }

    perKeyword.push({ keyword, top, rising });
  }

  return {
    keywordCount: result.length,
    totalTopCount,
    totalRisingCount,
    emptyKeywordCount,
    allTopicListsEmpty: emptyKeywordCount === result.length,
    perKeyword,
  };
}

function toReportItem(item) {
  return {
    topic: item.topic,
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

  const result = await client.relatedTopics({
    keywords,
    geo,
    timeRange,
    category,
    property,
  });

  const exploreCaptures = findSuccessfulCaptures(captures, EXPLORE_API_PATH);
  const relatedCaptures = findSuccessfulCaptures(captures, RELATED_SEARCHES_API_PATH);
  const comparisonItems = keywords.map((keyword) => ({ keyword, geo, time: timeRange }));
  const topicPairResolution = resolveTopicPairsFromExploreCaptures({
    exploreCaptures,
    keywords,
    comparisonItems,
    locale,
    timezone,
    category,
    property,
  });

  const capturedPairs = validateRelatedRequests({
    pairs: topicPairResolution.pairs,
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
      multiKeywordExploreFallbackHandled: true,
      singleKeywordExploreFallbackUsed: topicPairResolution.fallbackUsed,
      relatedSearchRequestsMatchExploreWidgets: true,
      packageOutputExactlyMatchesRawGoogleResponses: true,
      topicRowsSemanticallyValid: true,
      emptyTopicListsAcceptedWhenGoogleReturnedEmpty: true,
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
      exploreStatuses: exploreCaptures.map((capture) => capture.status),
      exploreRequestCount: topicPairResolution.exploreRequestCount,
      primaryRelatedTopicsWidgetCount: topicPairResolution.primaryTopicCount,
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
