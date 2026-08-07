import assert from 'node:assert/strict';

import { RateLimitError, createClient, getResultMetadata } from '../dist/index.mjs';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';
const EXPLORE_API_PATH = '/trends/api/explore';
const TIMELINE_API_PATH = '/trends/api/widgetdata/multiline';

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

function findSuccessfulCapture(captures, pathname) {
  const capture = [...captures]
    .reverse()
    .find((entry) => entry.pathname === pathname && entry.status >= 200 && entry.status < 300);

  assert.ok(capture, `No successful ${pathname} response was captured.`);
  return capture;
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

function validateRequestInputs({ exploreCapture, timelineCapture, expected }) {
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

  const explorePayload = requireRecord(
    parseGoogleJson(exploreCapture.body),
    'Explore response was not an object.',
  );
  assert.ok(Array.isArray(explorePayload.widgets), 'Explore response had no widgets array.');

  const widget = explorePayload.widgets.find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.id === 'string' &&
      (candidate.id === 'TIMESERIES' || candidate.id.startsWith('TIMESERIES_')),
  );

  const timelineWidget = requireRecord(widget, 'Explore response had no TIMESERIES widget.');
  assert.equal(typeof timelineWidget.token, 'string', 'TIMESERIES widget had no token.');
  const widgetRequest = requireRecord(
    timelineWidget.request,
    'TIMESERIES widget had no request object.',
  );

  const timelineUrl = new URL(timelineCapture.requestUrl);
  const timelineRequest = requireRecord(
    JSON.parse(timelineUrl.searchParams.get('req') ?? 'null'),
    'Timeline request query did not contain a valid req object.',
  );
  const widgetRequestOptions = isRecord(widgetRequest.requestOptions)
    ? widgetRequest.requestOptions
    : {};

  assert.equal(timelineUrl.searchParams.get('hl'), expected.locale);
  assert.equal(timelineUrl.searchParams.get('tz'), String(expected.timezone));
  assert.equal(timelineUrl.searchParams.get('token'), timelineWidget.token);
  assert.deepEqual(timelineRequest, {
    ...widgetRequest,
    requestOptions: {
      ...widgetRequestOptions,
      category: expected.category,
      property: expected.property,
    },
  });
}

function validatePackageAgainstRaw(result, rawPayload, keywords) {
  const root = requireRecord(rawPayload, 'Timeline response was not an object.');
  const defaultPayload = requireRecord(root.default, 'Timeline response had no default object.');
  assert.ok(Array.isArray(defaultPayload.timelineData), 'Timeline response had no timelineData.');

  const rawTimeline = defaultPayload.timelineData;
  const rawAverages = defaultPayload.averages ?? [];

  assert.ok(Array.isArray(rawAverages), 'Timeline averages was not an array.');
  assert.equal(
    result.timeline.length,
    rawTimeline.length,
    'Timeline point count changed in parsing.',
  );
  assert.equal(result.averages.length, rawAverages.length, 'Average count changed in parsing.');

  for (const [index, rawPointValue] of rawTimeline.entries()) {
    const rawPoint = requireRecord(rawPointValue, `Raw timeline point ${index} was not an object.`);
    const packagePoint = result.timeline[index];
    assert.ok(packagePoint, `Package timeline point ${index} was missing.`);

    const timestamp = Number(rawPoint.time);
    assert.ok(Number.isFinite(timestamp), `Raw timeline point ${index} had an invalid timestamp.`);
    assert.ok(Array.isArray(rawPoint.value), `Raw timeline point ${index} had no value array.`);

    const rawValues = rawPoint.value;
    const rawHasData = Array.isArray(rawPoint.hasData)
      ? rawPoint.hasData
      : rawValues.map(() => true);
    const rawFormattedValues = Array.isArray(rawPoint.formattedValue)
      ? rawPoint.formattedValue
      : rawValues.map(String);

    assert.equal(packagePoint.timestamp, timestamp, `Timestamp differed at point ${index}.`);
    assert.equal(
      packagePoint.date.getTime(),
      timestamp * 1_000,
      `Date conversion differed at point ${index}.`,
    );
    assert.equal(
      packagePoint.formattedTime,
      typeof rawPoint.formattedTime === 'string' && rawPoint.formattedTime.length > 0
        ? rawPoint.formattedTime
        : String(timestamp),
      `formattedTime differed at point ${index}.`,
    );
    assert.equal(
      packagePoint.formattedAxisTime,
      typeof rawPoint.formattedAxisTime === 'string' && rawPoint.formattedAxisTime.length > 0
        ? rawPoint.formattedAxisTime
        : undefined,
      `formattedAxisTime differed at point ${index}.`,
    );
    assert.equal(
      packagePoint.isPartial,
      rawPoint.isPartial === true,
      `isPartial differed at point ${index}.`,
    );
    assert.equal(packagePoint.values.length, keywords.length);

    for (const [keywordIndex, keyword] of keywords.entries()) {
      const packageValue = packagePoint.values[keywordIndex];
      assert.ok(packageValue, `Package value ${keywordIndex} was missing at point ${index}.`);
      assert.equal(packageValue.keyword, keyword);
      assert.equal(packageValue.value, rawValues[keywordIndex]);
      assert.equal(packageValue.hasData, rawHasData[keywordIndex]);
      assert.equal(packageValue.formattedValue, rawFormattedValues[keywordIndex]);
    }
  }

  for (const [index, rawAverage] of rawAverages.entries()) {
    assert.deepEqual(result.averages[index], {
      keyword: keywords[index],
      value: rawAverage,
    });
  }
}

function validateSemanticIntegrity(result, { keywords, timeRange }) {
  assert.ok(result.timeline.length > 0, 'Google returned no timeline points.');

  const timestamps = result.timeline.map((point) => point.timestamp);
  const uniqueTimestamps = new Set(timestamps);
  assert.equal(uniqueTimestamps.size, timestamps.length, 'Timeline contains duplicate timestamps.');

  for (let index = 1; index < timestamps.length; index += 1) {
    assert.ok(
      timestamps[index] > timestamps[index - 1],
      `Timeline is not strictly ascending at index ${index}.`,
    );
  }

  const dataValues = [];

  for (const [pointIndex, point] of result.timeline.entries()) {
    assert.ok(!Number.isNaN(point.date.getTime()), `Point ${pointIndex} has an invalid Date.`);
    assert.equal(point.values.length, keywords.length);

    for (const [valueIndex, value] of point.values.entries()) {
      assert.ok(
        Number.isFinite(value.value),
        `Point ${pointIndex}, value ${valueIndex} is not finite.`,
      );
      assert.ok(
        value.value >= 0 && value.value <= 100,
        `Point ${pointIndex}, value ${valueIndex} is outside Google Trends' 0-100 scale.`,
      );

      if (value.hasData) {
        dataValues.push(value.value);
      }
    }
  }

  assert.ok(dataValues.length > 0, 'No timeline values were marked as having data.');
  assert.equal(Math.max(...dataValues), 100, 'Normalized live data did not contain a peak of 100.');

  const first = result.timeline[0];
  const last = result.timeline.at(-1);
  assert.ok(first && last);

  const spanDays = (last.timestamp - first.timestamp) / 86_400;
  const latestAgeHours = (Date.now() - last.date.getTime()) / 3_600_000;

  assert.ok(latestAgeHours >= -24, 'Latest timeline point is unexpectedly far in the future.');
  assert.ok(latestAgeHours <= 72, 'Latest timeline point is more than 72 hours old.');

  if (timeRange === 'today 3-m') {
    assert.ok(result.timeline.length >= 80, 'today 3-m returned fewer than 80 timeline points.');
    assert.ok(spanDays >= 75 && spanDays <= 100, 'today 3-m did not span roughly three months.');
  }

  const calculatedMeans = keywords.map((keyword, keywordIndex) => {
    const values = result.timeline
      .map((point) => point.values[keywordIndex])
      .filter((value) => value?.hasData === true)
      .map((value) => value.value);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const googleAverage = result.averages.find((average) => average.keyword === keyword)?.value;

    return {
      keyword,
      calculatedMean: Number(mean.toFixed(3)),
      googleAverage,
      difference:
        googleAverage === undefined ? undefined : Number(Math.abs(mean - googleAverage).toFixed(3)),
    };
  });

  return {
    spanDays: Number(spanDays.toFixed(2)),
    latestAgeHours: Number(latestAgeHours.toFixed(2)),
    minimumValue: Math.min(...dataValues),
    maximumValue: Math.max(...dataValues),
    calculatedMeans,
  };
}

function toReportPoint(point) {
  return {
    date: point.date.toISOString(),
    formattedTime: point.formattedTime,
    isPartial: point.isPartial,
    values: point.values.map(({ keyword, value, hasData, formattedValue }) => ({
      keyword,
      value,
      hasData,
      formattedValue,
    })),
  };
}

const keywords = parseKeywords();
const geo = readNonEmptyEnv('GOOGLE_TRENDS_TEST_GEO', 'US').toUpperCase();
const timeRange = readNonEmptyEnv('GOOGLE_TRENDS_TEST_TIME_RANGE', 'today 3-m');
const locale = readNonEmptyEnv('GOOGLE_TRENDS_TEST_LOCALE', 'en-US');
const timezone = readIntegerEnv('GOOGLE_TRENDS_TEST_TIMEZONE', 0);
const category = readIntegerEnv('GOOGLE_TRENDS_TEST_CATEGORY', 0);
const property = readNonEmptyEnv('GOOGLE_TRENDS_TEST_PROPERTY', '');
const captures = [];
const nativeFetch = globalThis.fetch.bind(globalThis);

const captureFetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
  const response = await nativeFetch(input, init);

  if (requestUrl.pathname === EXPLORE_API_PATH || requestUrl.pathname === TIMELINE_API_PATH) {
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

  const result = await client.interestOverTime({
    keywords,
    geo,
    timeRange,
    category,
    property,
  });

  const exploreCapture = findSuccessfulCapture(captures, EXPLORE_API_PATH);
  const timelineCapture = findSuccessfulCapture(captures, TIMELINE_API_PATH);
  const comparisonItems = keywords.map((keyword) => ({ keyword, geo, time: timeRange }));

  validateRequestInputs({
    exploreCapture,
    timelineCapture,
    expected: {
      locale,
      timezone,
      comparisonItems,
      category,
      property,
    },
  });

  const rawTimelinePayload = parseGoogleJson(timelineCapture.body);
  validatePackageAgainstRaw(result, rawTimelinePayload, keywords);
  const integrity = validateSemanticIntegrity(result, { keywords, timeRange });
  const metadata = getResultMetadata(result);

  assert.deepEqual(metadata, { source: 'network', stale: false });

  const middleIndex = Math.floor(result.timeline.length / 2);
  const report = {
    status: 'passed',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    packageValidation: {
      builtDistributionUsed: true,
      requestParametersMatchInput: true,
      packageOutputExactlyMatchesRawGoogleResponse: true,
      timelineOrderingAndDatesValid: true,
      valuesWithinNormalizedRange: true,
      liveNormalizedPeakFound: true,
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
      pointCount: result.timeline.length,
      firstDate: result.timeline[0]?.date.toISOString(),
      lastDate: result.timeline.at(-1)?.date.toISOString(),
      averages: result.averages,
      integrity,
      samples: {
        first: result.timeline[0] ? toReportPoint(result.timeline[0]) : undefined,
        middle: result.timeline[middleIndex]
          ? toReportPoint(result.timeline[middleIndex])
          : undefined,
        latest: result.timeline.at(-1) ? toReportPoint(result.timeline.at(-1)) : undefined,
      },
    },
    rawGoogleResponses: {
      exploreStatus: exploreCapture.status,
      timelineStatus: timelineCapture.status,
      timelineContentType: timelineCapture.contentType,
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
