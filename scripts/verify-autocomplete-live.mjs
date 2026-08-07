import assert from 'node:assert/strict';

import { RateLimitError, createClient, getResultMetadata } from '../dist/index.mjs';

const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com';
const AUTOCOMPLETE_PATH = '/trends/api/autocomplete/';
const XSSI_PREFIX = ")]}'";

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

function stripGoogleXssiPrefix(payload) {
  const normalized = payload.replace(/^\uFEFF/, '').trimStart();

  if (!normalized.startsWith(XSSI_PREFIX)) {
    return normalized;
  }

  let json = normalized.slice(XSSI_PREFIX.length);

  if (json.startsWith(',')) {
    json = json.slice(1);
  }

  return json.trimStart();
}

function parseGoogleJson(payload) {
  const json = stripGoogleXssiPrefix(payload);
  assert.ok(json.trim().length > 0, 'Google returned an empty autocomplete response body.');
  return JSON.parse(json);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value, fieldName) {
  assert.equal(typeof value, 'string', `${fieldName} was not a string.`);
  const normalized = value.trim();
  assert.ok(normalized.length > 0, `${fieldName} was empty.`);
  return normalized;
}

function parseRawSearchTerm(value, index) {
  assert.ok(isRecord(value), `default.searchTerms[${index}] was not an object.`);

  const title = requireNonEmptyString(
    value.title ?? value.query ?? value.keyword,
    `default.searchTerms[${index}].title`,
  );

  const keyword =
    typeof value.query === 'string' && value.query.trim().length > 0
      ? value.query.trim()
      : typeof value.keyword === 'string' && value.keyword.trim().length > 0
        ? value.keyword.trim()
        : title;

  const type =
    typeof value.type === 'string' && value.type.trim().length > 0
      ? value.type.trim()
      : 'Search term';

  return {
    keyword,
    title,
    type,
    kind: 'search-term',
  };
}

function parseRawTopic(value, index) {
  assert.ok(isRecord(value), `default.topics[${index}] was not an object.`);

  const title = requireNonEmptyString(value.title, `default.topics[${index}].title`);
  const type = requireNonEmptyString(value.type, `default.topics[${index}].type`);

  if (typeof value.mid !== 'string' || value.mid.trim().length === 0) {
    return {
      keyword: title,
      title,
      type,
      kind: 'search-term',
    };
  }

  const mid = value.mid.trim();

  return {
    keyword: mid,
    title,
    type,
    kind: 'topic',
    mid,
  };
}

function suggestionIdentity(suggestion) {
  return [suggestion.kind, suggestion.keyword, suggestion.title, suggestion.type].join('\u0000');
}

function parseRawAutocomplete(payload, query, limit) {
  assert.ok(isRecord(payload), 'Autocomplete response root was not an object.');
  assert.ok(isRecord(payload.default), 'Autocomplete response had no valid default object.');

  const searchTerms = payload.default.searchTerms;
  const topics = payload.default.topics;

  if (searchTerms !== undefined) {
    assert.ok(Array.isArray(searchTerms), 'default.searchTerms was not an array.');
  }

  if (topics !== undefined) {
    assert.ok(Array.isArray(topics), 'default.topics was not an array.');
  }

  assert.ok(
    searchTerms !== undefined || topics !== undefined,
    'Autocomplete response contained no suggestion arrays.',
  );

  const parsed = [
    ...(searchTerms ?? []).map(parseRawSearchTerm),
    ...(topics ?? []).map(parseRawTopic),
  ];

  const unique = Array.from(
    new Map(parsed.map((suggestion) => [suggestionIdentity(suggestion), suggestion])).values(),
  );

  return {
    rawSearchTermCount: searchTerms?.length ?? 0,
    rawTopicCount: topics?.length ?? 0,
    parsedBeforeDeduplication: parsed.length,
    uniqueBeforeLimit: unique.length,
    result: {
      query,
      suggestions: unique.slice(0, limit),
    },
  };
}

function captureRequestHeaders(input, init) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);

  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return headers;
}

function validateRequest(capture, { keyword, locale }) {
  const url = new URL(capture.requestUrl);
  const expectedPath = `${AUTOCOMPLETE_PATH}${encodeURIComponent(keyword)}`;

  assert.equal(url.origin, GOOGLE_TRENDS_BASE_URL);
  assert.equal(url.pathname, expectedPath, 'Autocomplete path did not match the encoded keyword.');
  assert.equal(
    url.searchParams.get('hl'),
    locale,
    'Autocomplete hl query did not match client locale.',
  );
  assert.equal(
    url.searchParams.getAll('hl').length,
    1,
    'Autocomplete request contained duplicate hl params.',
  );

  const accept = capture.requestHeaders.get('accept') ?? '';
  assert.ok(
    accept.toLowerCase().includes('application/json'),
    'Autocomplete request Accept header did not advertise JSON.',
  );
}

function validateSemanticIntegrity(result, limit) {
  assert.ok(result.query.trim().length > 0, 'Autocomplete result query was empty.');
  assert.ok(
    result.suggestions.length > 0,
    'Google returned no autocomplete suggestions for the test query.',
  );
  assert.ok(
    result.suggestions.length <= limit,
    'Autocomplete result exceeded the requested limit.',
  );

  const identities = new Set();
  let topicCount = 0;
  let searchTermCount = 0;
  let midCount = 0;

  for (const [index, suggestion] of result.suggestions.entries()) {
    assert.ok(suggestion.keyword.trim().length > 0, `Suggestion ${index} had an empty keyword.`);
    assert.ok(suggestion.title.trim().length > 0, `Suggestion ${index} had an empty title.`);
    assert.ok(suggestion.type.trim().length > 0, `Suggestion ${index} had an empty type.`);
    assert.ok(
      suggestion.kind === 'topic' || suggestion.kind === 'search-term',
      `Suggestion ${index} had an invalid kind.`,
    );

    const identity = suggestionIdentity(suggestion);
    assert.ok(!identities.has(identity), `Suggestion ${index} duplicated a previous suggestion.`);
    identities.add(identity);

    if (suggestion.kind === 'topic') {
      topicCount += 1;
      assert.equal(typeof suggestion.mid, 'string', `Topic suggestion ${index} had no mid.`);
      assert.ok(suggestion.mid.trim().length > 0, `Topic suggestion ${index} had an empty mid.`);
      assert.equal(
        suggestion.keyword,
        suggestion.mid,
        `Topic suggestion ${index} did not use mid as keyword.`,
      );
      midCount += 1;
    } else {
      searchTermCount += 1;
      assert.equal(
        suggestion.mid,
        undefined,
        `Search-term suggestion ${index} unexpectedly had a mid.`,
      );
    }
  }

  return {
    returnedCount: result.suggestions.length,
    uniqueIdentityCount: identities.size,
    topicCount,
    searchTermCount,
    midCount,
    appliedLimit: limit,
  };
}

const keyword = readNonEmptyEnv('GOOGLE_TRENDS_TEST_AUTOCOMPLETE_KEYWORD', 'typescript');
const locale = readNonEmptyEnv('GOOGLE_TRENDS_TEST_LOCALE', 'en-US');
const limit = readPositiveIntegerEnv('GOOGLE_TRENDS_TEST_AUTOCOMPLETE_LIMIT', 10);

const normalizedKeyword = keyword.trim();
const captures = [];
const allGoogleRequests = [];
const nativeFetch = globalThis.fetch.bind(globalThis);

const captureFetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
  const requestHeaders = captureRequestHeaders(input, init);

  if (requestUrl.origin === GOOGLE_TRENDS_BASE_URL) {
    allGoogleRequests.push({
      requestUrl: requestUrl.toString(),
      requestHeaders,
    });
  }

  const response = await nativeFetch(input, init);

  if (requestUrl.pathname.startsWith(AUTOCOMPLETE_PATH)) {
    captures.push({
      requestUrl: requestUrl.toString(),
      status: response.status,
      contentType: response.headers.get('content-type'),
      requestHeaders,
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

  const result = await client.autocomplete({
    keyword: normalizedKeyword,
    limit,
  });

  assert.equal(
    allGoogleRequests.length,
    1,
    `Expected exactly one Google request, got ${allGoogleRequests.length}.`,
  );
  assert.equal(
    captures.length,
    1,
    `Expected exactly one autocomplete request, got ${captures.length}.`,
  );

  const capture = captures[0];
  assert.ok(capture);
  assert.ok(
    capture.status >= 200 && capture.status < 300,
    `Autocomplete returned HTTP ${capture.status}.`,
  );
  validateRequest(capture, { keyword: normalizedKeyword, locale });

  const rawPayload = parseGoogleJson(capture.body);
  const raw = parseRawAutocomplete(rawPayload, normalizedKeyword, limit);

  assert.deepEqual(
    result,
    raw.result,
    "Package autocomplete output differed from Google's raw response.",
  );

  const integrity = validateSemanticIntegrity(result, limit);
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
          singleRequestOnly: true,
          requestParametersMatchInput: true,
          jsonAcceptHeaderValid: true,
          packageOutputExactlyMatchesRawGoogleResponse: true,
          suggestionRowsSemanticallyValid: true,
          deduplicationAndLimitMatchRawResponse: true,
          metadata,
        },
        input: {
          keyword: normalizedKeyword,
          locale,
          limit,
        },
        result: {
          integrity: {
            ...integrity,
            rawSearchTermCount: raw.rawSearchTermCount,
            rawTopicCount: raw.rawTopicCount,
            parsedBeforeDeduplication: raw.parsedBeforeDeduplication,
            uniqueBeforeLimit: raw.uniqueBeforeLimit,
            duplicatesRemoved: raw.parsedBeforeDeduplication - raw.uniqueBeforeLimit,
          },
          suggestions: result.suggestions,
        },
        rawGoogleResponse: {
          status: capture.status,
          contentType: capture.contentType,
          responseCount: captures.length,
          requestUrl: capture.requestUrl,
        },
        manualCheckUrl: new URL(
          `/trends/explore?q=${encodeURIComponent(normalizedKeyword)}`,
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
          input: { keyword: normalizedKeyword, locale, limit },
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
          input: { keyword: normalizedKeyword, locale, limit },
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
