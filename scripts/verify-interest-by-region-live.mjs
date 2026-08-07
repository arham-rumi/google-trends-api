import assert from 'node:assert/strict';

import { RateLimitError, createClient, getResultMetadata } from '../dist/index.mjs';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';
const EXPLORE_API_PATH = '/trends/api/explore';
const GEO_API_PATH = '/trends/api/widgetdata/comparedgeo';
const SUPPORTED_RESOLUTIONS = new Set(['COUNTRY', 'REGION', 'CITY', 'DMA']);

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

function readBooleanEnv(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;

  throw new RangeError(`${name} must be true or false.`);
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

function parseResolution() {
  const resolution = readNonEmptyEnv('GOOGLE_TRENDS_TEST_RESOLUTION', 'REGION').toUpperCase();

  if (!SUPPORTED_RESOLUTIONS.has(resolution)) {
    throw new RangeError('GOOGLE_TRENDS_TEST_RESOLUTION must be COUNTRY, REGION, CITY, or DMA.');
  }

  return resolution;
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

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeGeoCode(value, fieldName) {
  if (value === undefined) return undefined;

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  assert.fail(`${fieldName} must be a non-empty string or finite number.`);
}

function normalizeCoordinates(value, fieldName) {
  if (value === undefined) return undefined;

  const coordinates = requireRecord(value, `${fieldName} was not an object.`);
  assert.equal(typeof coordinates.lat, 'number', `${fieldName}.lat was not a number.`);
  assert.equal(typeof coordinates.lng, 'number', `${fieldName}.lng was not a number.`);
  assert.ok(Number.isFinite(coordinates.lat), `${fieldName}.lat was not finite.`);
  assert.ok(Number.isFinite(coordinates.lng), `${fieldName}.lng was not finite.`);

  return {
    lat: coordinates.lat,
    lng: coordinates.lng,
  };
}

function normalizeMaxValueIndex(value, keywordCount, fieldName) {
  if (value === undefined) return undefined;

  assert.ok(Number.isInteger(value), `${fieldName} was not an integer.`);
  assert.ok(value >= 0 && value < keywordCount, `${fieldName} was outside the keyword range.`);
  return value;
}

function expectedRegionFromRaw(rawValue, keywords, index) {
  const raw = requireRecord(rawValue, `Raw geoMapData[${index}] was not an object.`);
  const geoName = normalizeOptionalString(raw.geoName);

  assert.ok(geoName, `Raw geoMapData[${index}].geoName was invalid.`);
  assert.ok(Array.isArray(raw.value), `Raw geoMapData[${index}].value was not an array.`);
  assert.equal(
    raw.value.length,
    keywords.length,
    `Raw geoMapData[${index}].value did not match the keyword count.`,
  );
  assert.ok(
    raw.value.every((value) => typeof value === 'number' && Number.isFinite(value)),
    `Raw geoMapData[${index}].value contained a non-finite number.`,
  );

  let formattedValues;

  if (raw.formattedValue === undefined) {
    formattedValues = raw.value.map(String);
  } else {
    assert.ok(
      Array.isArray(raw.formattedValue),
      `Raw geoMapData[${index}].formattedValue was not an array.`,
    );
    assert.ok(
      raw.formattedValue.every((value) => typeof value === 'string'),
      `Raw geoMapData[${index}].formattedValue contained a non-string value.`,
    );
    assert.equal(
      raw.formattedValue.length,
      keywords.length,
      `Raw geoMapData[${index}].formattedValue did not match the keyword count.`,
    );
    formattedValues = raw.formattedValue;
  }

  const expected = {
    geoName,
    values: keywords.map((keyword, keywordIndex) => ({
      keyword,
      value: raw.value[keywordIndex],
      formattedValue: formattedValues[keywordIndex],
    })),
  };
  const geoCode = normalizeGeoCode(raw.geoCode, `Raw geoMapData[${index}].geoCode`);
  const coordinates = normalizeCoordinates(raw.coordinates, `Raw geoMapData[${index}].coordinates`);
  const maxValueIndex = normalizeMaxValueIndex(
    raw.maxValueIndex,
    keywords.length,
    `Raw geoMapData[${index}].maxValueIndex`,
  );

  if (geoCode !== undefined) expected.geoCode = geoCode;
  if (coordinates !== undefined) expected.coordinates = coordinates;
  if (maxValueIndex !== undefined) expected.maxValueIndex = maxValueIndex;

  return expected;
}

function validateRequestInputs({ exploreCapture, geoCapture, expected }) {
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
      (candidate.id === 'GEO_MAP' || candidate.id.startsWith('GEO_MAP_')),
  );
  const geoWidget = requireRecord(widget, 'Explore response had no GEO_MAP widget.');
  assert.equal(typeof geoWidget.token, 'string', 'GEO_MAP widget had no token.');
  const widgetRequest = requireRecord(geoWidget.request, 'GEO_MAP widget had no request object.');

  const geoUrl = new URL(geoCapture.requestUrl);
  const geoRequest = requireRecord(
    JSON.parse(geoUrl.searchParams.get('req') ?? 'null'),
    'Geographic request query did not contain a valid req object.',
  );
  const widgetRequestOptions = isRecord(widgetRequest.requestOptions)
    ? widgetRequest.requestOptions
    : {};

  assert.equal(geoUrl.searchParams.get('hl'), expected.locale);
  assert.equal(geoUrl.searchParams.get('tz'), String(expected.timezone));
  assert.equal(geoUrl.searchParams.get('token'), geoWidget.token);
  assert.deepEqual(geoRequest, {
    ...widgetRequest,
    resolution: expected.resolution,
    includeLowSearchVolumeGeos: expected.includeLowSearchVolumeGeos,
    requestOptions: {
      ...widgetRequestOptions,
      category: expected.category,
      property: expected.property,
    },
  });
}

function validatePackageAgainstRaw(result, rawPayload, keywords) {
  const root = requireRecord(rawPayload, 'Geographic response was not an object.');
  const defaultPayload = requireRecord(root.default, 'Geographic response had no default object.');
  assert.ok(
    Array.isArray(defaultPayload.geoMapData),
    'Geographic response had no geoMapData array.',
  );

  const expectedRegions = defaultPayload.geoMapData.map((rawRegion, index) =>
    expectedRegionFromRaw(rawRegion, keywords, index),
  );

  assert.deepEqual(
    result.regions,
    expectedRegions,
    'Package geographic output differed from the raw Google geoMapData response.',
  );

  return expectedRegions;
}

function validateSemanticIntegrity(result, { keywords }) {
  assert.ok(result.regions.length > 0, 'Google returned no geographic interest rows.');

  const identities = new Set();
  const geoCodes = new Set();
  const allValues = [];
  let coordinatesCount = 0;
  let maxValueIndexCount = 0;

  for (const [regionIndex, region] of result.regions.entries()) {
    assert.ok(region.geoName.trim().length > 0, `Region ${regionIndex} has an empty geoName.`);
    assert.equal(
      region.values.length,
      keywords.length,
      `Region ${regionIndex} does not contain one value per keyword.`,
    );

    const identity = region.geoCode ?? region.geoName;
    assert.ok(!identities.has(identity), `Duplicate geographic identity returned: ${identity}`);
    identities.add(identity);

    if (region.geoCode !== undefined) {
      assert.ok(region.geoCode.length > 0, `Region ${regionIndex} has an empty geoCode.`);
      assert.ok(!geoCodes.has(region.geoCode), `Duplicate geoCode returned: ${region.geoCode}`);
      geoCodes.add(region.geoCode);
    }

    if (region.coordinates !== undefined) {
      coordinatesCount += 1;
      assert.ok(Number.isFinite(region.coordinates.lat));
      assert.ok(Number.isFinite(region.coordinates.lng));
      assert.ok(
        region.coordinates.lat >= -90 && region.coordinates.lat <= 90,
        `Region ${regionIndex} latitude is outside -90..90.`,
      );
      assert.ok(
        region.coordinates.lng >= -180 && region.coordinates.lng <= 180,
        `Region ${regionIndex} longitude is outside -180..180.`,
      );
    }

    const regionValues = [];

    for (const [keywordIndex, value] of region.values.entries()) {
      assert.equal(value.keyword, keywords[keywordIndex]);
      assert.ok(
        Number.isFinite(value.value),
        `Region ${regionIndex}, keyword ${keywordIndex} has a non-finite value.`,
      );
      assert.ok(
        value.value >= 0 && value.value <= 100,
        `Region ${regionIndex}, keyword ${keywordIndex} is outside Google Trends' 0-100 scale.`,
      );
      assert.equal(typeof value.formattedValue, 'string');
      regionValues.push(value.value);
      allValues.push(value.value);
    }

    if (region.maxValueIndex !== undefined) {
      maxValueIndexCount += 1;
      assert.ok(Number.isInteger(region.maxValueIndex));
      assert.ok(region.maxValueIndex >= 0 && region.maxValueIndex < keywords.length);
      assert.equal(
        regionValues[region.maxValueIndex],
        Math.max(...regionValues),
        `Region ${regionIndex} maxValueIndex does not point to a maximum keyword value.`,
      );
    }
  }

  assert.ok(allValues.length > 0, 'No geographic values were returned.');

  const observedMaximumValue = Math.max(...allValues);
  const observedMinimumValue = Math.min(...allValues);

  // Google Trends guarantees a 0-100 scale, but not that every regional response
  // contains a value of exactly 100. In multi-keyword comparisons, regional
  // values represent comparison percentages, so the leading term in the
  // strongest returned region can legitimately peak below 100.
  assert.ok(
    observedMinimumValue >= 0 && observedMaximumValue <= 100,
    "Geographic values were outside Google Trends' documented 0-100 range.",
  );

  const primaryKeywordValues = result.regions.map((region) => region.values[0]?.value ?? 0);
  const topPrimaryRegions = [...result.regions]
    .sort((left, right) => (right.values[0]?.value ?? 0) - (left.values[0]?.value ?? 0))
    .slice(0, 5)
    .map((region) => ({
      geoName: region.geoName,
      geoCode: region.geoCode,
      value: region.values[0]?.value,
      formattedValue: region.values[0]?.formattedValue,
    }));

  return {
    regionCount: result.regions.length,
    uniqueIdentityCount: identities.size,
    geoCodeCount: geoCodes.size,
    coordinatesCount,
    maxValueIndexCount,
    minimumValue: observedMinimumValue,
    maximumValue: observedMaximumValue,
    primaryKeywordMinimum: Math.min(...primaryKeywordValues),
    primaryKeywordMaximum: Math.max(...primaryKeywordValues),
    topPrimaryRegions,
  };
}

function toReportRegion(region) {
  return {
    geoName: region.geoName,
    geoCode: region.geoCode,
    coordinates: region.coordinates,
    maxValueIndex: region.maxValueIndex,
    values: region.values.map(({ keyword, value, formattedValue }) => ({
      keyword,
      value,
      formattedValue,
    })),
  };
}

const keywords = parseKeywords();
const geo = readNonEmptyEnv('GOOGLE_TRENDS_TEST_GEO', 'US').toUpperCase();
const timeRange = readNonEmptyEnv('GOOGLE_TRENDS_TEST_TIME_RANGE', 'today 12-m');
const locale = readNonEmptyEnv('GOOGLE_TRENDS_TEST_LOCALE', 'en-US');
const timezone = readIntegerEnv('GOOGLE_TRENDS_TEST_TIMEZONE', 0);
const category = readIntegerEnv('GOOGLE_TRENDS_TEST_CATEGORY', 0);
const property = readNonEmptyEnv('GOOGLE_TRENDS_TEST_PROPERTY', '');
const resolution = parseResolution();
const includeLowSearchVolumeGeos = readBooleanEnv(
  'GOOGLE_TRENDS_TEST_INCLUDE_LOW_SEARCH_VOLUME_GEOS',
  false,
);
const captures = [];
const nativeFetch = globalThis.fetch.bind(globalThis);

const captureFetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
  const response = await nativeFetch(input, init);

  if (requestUrl.pathname === EXPLORE_API_PATH || requestUrl.pathname === GEO_API_PATH) {
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

  const result = await client.interestByRegion({
    keywords,
    geo,
    timeRange,
    resolution,
    includeLowSearchVolumeGeos,
    category,
    property,
  });

  const exploreCapture = findSuccessfulCapture(captures, EXPLORE_API_PATH);
  const geoCapture = findSuccessfulCapture(captures, GEO_API_PATH);
  const comparisonItems = keywords.map((keyword) => ({ keyword, geo, time: timeRange }));

  validateRequestInputs({
    exploreCapture,
    geoCapture,
    expected: {
      locale,
      timezone,
      comparisonItems,
      category,
      property,
      resolution,
      includeLowSearchVolumeGeos,
    },
  });

  const rawGeoPayload = parseGoogleJson(geoCapture.body);
  validatePackageAgainstRaw(result, rawGeoPayload, keywords);
  const integrity = validateSemanticIntegrity(result, { keywords });
  const metadata = getResultMetadata(result);

  assert.deepEqual(metadata, { source: 'network', stale: false });

  const middleIndex = Math.floor(result.regions.length / 2);
  const report = {
    status: 'passed',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    packageValidation: {
      builtDistributionUsed: true,
      requestParametersMatchInput: true,
      packageOutputExactlyMatchesRawGoogleResponse: true,
      geographicRowsUnique: true,
      valuesWithinNormalizedRange: true,
      normalizedPeakRequired: false,
      maxValueIndexesValid: true,
      metadata,
    },
    input: {
      keywords,
      geo,
      timeRange,
      resolution,
      includeLowSearchVolumeGeos,
      locale,
      timezone,
      category,
      property,
    },
    result: {
      regionCount: result.regions.length,
      integrity,
      samples: {
        first: result.regions[0] ? toReportRegion(result.regions[0]) : undefined,
        middle: result.regions[middleIndex]
          ? toReportRegion(result.regions[middleIndex])
          : undefined,
        last: result.regions.at(-1) ? toReportRegion(result.regions.at(-1)) : undefined,
      },
    },
    rawGoogleResponses: {
      exploreStatus: exploreCapture.status,
      geoStatus: geoCapture.status,
      geoContentType: geoCapture.contentType,
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
      resolution,
      includeLowSearchVolumeGeos,
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
