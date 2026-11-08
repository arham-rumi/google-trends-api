# @arham-rumi/google-trends-api

[![CI](https://github.com/arham-rumi/google-trends-api/actions/workflows/ci.yml/badge.svg)](https://github.com/arham-rumi/google-trends-api/actions/workflows/ci.yml)
[![Live Integration](https://github.com/arham-rumi/google-trends-api/actions/workflows/live-integration.yml/badge.svg)](https://github.com/arham-rumi/google-trends-api/actions/workflows/live-integration.yml)

A modern, typed, unofficial Google Trends client for Node.js.

Use it to retrieve interest over time, geographic interest, related queries and topics, current
trends, and Google Trends autocomplete suggestions without driving a browser.

> **Important:** This package is not affiliated with, maintained by, or endorsed by Google. It uses
> undocumented Google Trends web endpoints that can change without notice. Build applications to
> tolerate rate limits, temporary failures, and response changes.

## Contents

- [Why use this package?](#why-use-this-package)
- [Requirements and installation](#requirements-and-installation)
- [Quick start](#quick-start)
- [API at a glance](#api-at-a-glance)
- [Terms, topics, and comparison inputs](#terms-topics-and-comparison-inputs)
- [API guide](#api-guide)
- [Client configuration](#client-configuration)
- [Caching, deduplication, and rate limits](#caching-deduplication-and-rate-limits)
- [Cancellation](#cancellation)
- [Error handling](#error-handling)
- [CommonJS](#commonjs)
- [Production guidance](#production-guidance)
- [Development and verification](#development-and-verification)
- [Limitations and responsible use](#limitations-and-responsible-use)
- [Collaboration and contact](#collaboration-and-contact)

## Why use this package?

- TypeScript-first public API with generated declarations
- ESM and CommonJS builds
- Interest over time for up to five terms or topics
- Interest by country, region, city, or DMA
- Top and rising related queries and topics
- Trending Now RSS results, including news items when Google provides them
- Search-term and Knowledge Graph topic autocomplete
- Cookie-aware HTTP sessions, timeouts, retry handling, and abort signals
- Typed errors for HTTP, rate-limit, timeout, cancellation, network, and parsing failures
- Conservative request serialization and spacing
- Identical-request deduplication and per-client in-memory caching
- Endpoint-specific HTTP 429 cooldowns and stale-cache fallback
- Deterministic tests plus separate live validators that compare parsed output with raw Google data

## Requirements and installation

- Node.js 22.14.0 or newer
- No API key is required

```bash
npm install @arham-rumi/google-trends-api
```

The package uses the native Node.js `fetch` implementation by default.

## Quick start

```ts
import { createClient } from '@arham-rumi/google-trends-api';

const trends = createClient({
  locale: 'en-US',
  timezone: 0,
});

const result = await trends.interestOverTime({
  keywords: ['node.js', 'deno'],
  geo: 'US',
  timeRange: 'today 12-m',
});

for (const point of result.timeline) {
  console.log(point.date, point.values);
}
```

Google Trends values are relative scores, normally from `0` to `100`. They are not absolute search
volumes. A value of `100` marks peak popularity within the requested comparison, geography, and
time range.

## API at a glance

| Method                | Use it for                                          | Main result                        |
| --------------------- | --------------------------------------------------- | ---------------------------------- |
| `interestOverTime()`  | Relative interest across a timeline                 | Timeline points and averages       |
| `interestByRegion()`  | Relative interest by geographic area                | Ranked geographic rows             |
| `relatedQueries()`    | Searches associated with each term or topic         | Top and rising query lists         |
| `relatedTopics()`     | Topics associated with each term or topic           | Top and rising topic lists         |
| `trendingNow()`       | Searches currently surging in a country/territory   | RSS trends and related news        |
| `autocomplete()`      | Search-term suggestions and topic machine IDs       | Terms and topics                   |
| `warmup()`            | Explicitly establish the cookie-aware session       | `Promise<void>`                    |
| `clearCache()`        | Remove results from the memory and persistent cache | `Promise<void>`                    |
| `getResultMetadata()` | Identify network, fresh-cache, or stale-cache data  | Source, stale flag, and cache time |

All public request methods support `AbortSignal`. Explore-based methods accept either the concise
`keywords` form or explicit `comparisonItems`.

## Terms, topics, and comparison inputs

### Search terms versus topics

A search term is the literal text people searched for. A topic is a Google Knowledge Graph entity
that can combine languages and related spellings around one concept.

Use `autocomplete()` when you want to discover the correct topic ID:

```ts
const suggestions = await trends.autocomplete({
  keyword: 'tesla',
  limit: 10,
});

for (const suggestion of suggestions.suggestions) {
  console.log({
    title: suggestion.title,
    kind: suggestion.kind,
    keyword: suggestion.keyword,
    mid: suggestion.mid,
  });
}

const topic = suggestions.suggestions.find((item) => item.kind === 'topic');

if (topic) {
  const result = await trends.interestOverTime({
    keywords: topic.keyword,
    geo: 'US',
  });

  console.log(result.timeline);
}
```

For topic suggestions, `suggestion.keyword` is the machine ID to pass to the Explore-based methods.

### Shared filters with `keywords`

Use `keywords` when all series share the same geography and time range:

```ts
const result = await trends.interestOverTime({
  keywords: ['typescript', 'javascript'],
  geo: 'US',
  timeRange: 'today 3-m',
});
```

`keywords` accepts one string or an array of one to five strings.

### Per-series filters with `comparisonItems`

Use `comparisonItems` to compare locations or time periods. Operation-level `geo` and `timeRange`
values are defaults; an item can override either value.

```ts
const result = await trends.interestOverTime({
  comparisonItems: [
    { keyword: 'typescript', geo: 'US' },
    { keyword: 'typescript', geo: 'GB', timeRange: 'now 7-d' },
  ],
  timeRange: 'today 3-m',
});

console.log(result.timeline);
```

`keywords` and `comparisonItems` are mutually exclusive. `comparisonItems` accepts one to five
items and is supported by:

- `interestOverTime()`
- `interestByRegion()`
- `relatedQueries()`
- `relatedTopics()`

Results preserve the input order, including when the same keyword is compared with different
filters.

### Common Explore filters

| Option      | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `geo`       | Google Trends geography, such as `US`, `PK`, or `US-CA`; omit for worldwide |
| `timeRange` | Google Trends time expression, such as `now 7-d` or `today 12-m`            |
| `category`  | Numeric Google Trends category ID; `0` means all categories                 |
| `property`  | Search surface: web, images, news, YouTube, or Shopping                     |
| `signal`    | `AbortSignal` used to cancel this caller's request                          |

These endpoints follow Google Trends conventions. Data availability and supported geography/time
combinations depend on Google. The package validates that a time range is non-empty but otherwise
passes it through to Google. Common values include `now 7-d`, `today 3-m`, and `today 12-m`.
Geography codes are also Google-defined; use an empty or omitted `geo` for worldwide data.

## API guide

### Interest over time

```ts
const result = await trends.interestOverTime({
  keywords: ['typescript', 'javascript'],
  geo: 'PK',
  timeRange: 'now 7-d',
  category: 0,
  property: '',
});

for (const point of result.timeline) {
  console.log({
    timestamp: point.timestamp,
    date: point.date,
    label: point.formattedTime,
    partial: point.isPartial,
    values: point.values,
  });
}

console.log(result.averages);
```

Each timeline value contains:

- `keyword`: the corresponding input term or topic ID
- `value`: Google's normalized numeric value
- `hasData`: whether Google marked the series as having data at that point
- `formattedValue`: Google's display-ready value

`date` is a JavaScript `Date`; `timestamp` is Google's Unix timestamp in seconds. The latest point
may have `isPartial: true`. Google can omit averages for a valid response, so `averages` may be an
empty array.

### Interest by region

```ts
import { INTEREST_BY_REGION_RESOLUTIONS, createClient } from '@arham-rumi/google-trends-api';

console.log(INTEREST_BY_REGION_RESOLUTIONS);
// ['COUNTRY', 'REGION', 'CITY', 'DMA']

const result = await trends.interestByRegion({
  keywords: 'artificial intelligence',
  geo: 'US',
  timeRange: 'today 12-m',
  resolution: 'REGION',
  includeLowSearchVolumeGeos: true,
});

for (const region of result.regions) {
  console.log(region.geoName, region.geoCode, region.values);
}
```

Supported resolution names are `COUNTRY`, `REGION`, `CITY`, and `DMA`. Google does not make every
resolution available for every geography. A row may include `geoCode`, coordinates, and
`maxValueIndex` when those fields are present in Google's response.

For multi-keyword regional comparisons, values can be percentage shares between the compared
series. Do not assume that one regional value must equal `100`.

### Related queries

```ts
const results = await trends.relatedQueries({
  keywords: ['node.js', 'bun'],
  geo: 'US',
  timeRange: 'today 3-m',
});

for (const result of results) {
  console.log(`Related to ${result.keyword}`);

  for (const item of result.top) {
    console.log('top', item.query, item.value, item.formattedValue);
  }

  for (const item of result.rising) {
    console.log('rising', item.query, item.value, item.formattedValue);
  }
}
```

Each input produces one result containing `top` and `rising` lists. Rising results may have a
display value such as `Breakout`; use `formattedValue` when presenting Google's label.

### Related topics

```ts
const results = await trends.relatedTopics({
  keywords: 'machine learning',
  geo: 'US',
});

for (const item of results[0]?.top ?? []) {
  console.log(item.topic.title, item.topic.mid, item.topic.type);
}

console.log(results[0]?.rising);
```

Related topics have a title and may include a Knowledge Graph machine ID and type. Empty `top` or
`rising` lists are valid when Google returns no rows; they do not necessarily indicate a parsing
failure.

### Trending Now

```ts
const result = await trends.trendingNow({
  geo: 'PK',
  limit: 10,
});

for (const trend of result.trends) {
  console.log({
    title: trend.title,
    traffic: trend.approxTraffic,
    minimumTraffic: trend.approxTrafficMin,
    publishedAt: trend.publishedAt,
    link: trend.link,
    news: trend.news,
  });
}
```

`geo` must be a two-letter country or territory code. `limit`, when supplied, must be a positive
integer.

This method reads Google's Trending Now RSS feed. It returns the fields present in that feed, not
every filter and chart shown in the interactive Trending Now website. `approxTrafficMin` is a
parsed lower bound when the traffic label is recognizable; keep `approxTraffic` when displaying
Google's original text.

### Autocomplete

```ts
const result = await trends.autocomplete({
  keyword: 'tesla',
  limit: 10,
});

for (const suggestion of result.suggestions) {
  console.log(
    suggestion.kind, // 'search-term' | 'topic'
    suggestion.title,
    suggestion.type,
    suggestion.keyword,
  );
}
```

Autocomplete returns both literal search terms and topics. Topic suggestions normally contain a
`mid`, while `keyword` always contains the value accepted by other package methods.

### Search properties

```ts
import { GOOGLE_TRENDS_PROPERTIES } from '@arham-rumi/google-trends-api';

console.log(GOOGLE_TRENDS_PROPERTIES);
```

| Value       | Search surface  |
| ----------- | --------------- |
| `''`        | Web Search      |
| `'images'`  | Image Search    |
| `'news'`    | News Search     |
| `'youtube'` | YouTube Search  |
| `'froogle'` | Google Shopping |

## Client configuration

```ts
const trends = createClient({
  locale: 'en-US',
  timezone: 0,
  timeoutMs: 10_000,
  retries: 2,
  userAgent: 'my-app/1.0 (+https://example.com)',
  rateLimit: {
    enabled: true,
    minIntervalMs: 2_500,
    cooldownMs: 60_000,
    recovery: true,
    adaptivePacing: {
      enabled: true,
      maxIntervalMs: 30_000,
      increaseFactor: 2,
      recoveryFactor: 0.75,
      successThreshold: 4,
    },
  },
  cache: {
    enabled: true,
    ttlMs: 15 * 60_000,
    staleIfErrorMs: 24 * 60 * 60_000,
    maxEntries: 100,
  },
});
```

### Top-level options

| Option      | Default         | Description                                             |
| ----------- | --------------- | ------------------------------------------------------- |
| `locale`    | `'en-US'`       | Locale sent to Google Trends                            |
| `timezone`  | `0`             | Google Trends timezone offset in minutes (`-840`–`840`) |
| `timeoutMs` | `10000`         | Timeout for each HTTP attempt                           |
| `retries`   | `2`             | Additional attempts for retryable non-429 failures      |
| `userAgent` | Package default | User agent sent to Google                               |
| `rateLimit` | See below       | Adaptive spacing, cooldown, and tokenized-flow recovery |
| `cache`     | See below       | In-memory cache with an optional persistent store       |
| `fetch`     | Native `fetch`  | Custom fetch-compatible implementation                  |

`client.options` exposes the resolved, read-only configuration.

### Rate-limit options

| Option             | Default                                    | Description                                    |
| ------------------ | ------------------------------------------ | ---------------------------------------------- |
| `enabled`          | `true`                                     | Enable serialized request pacing and cooldowns |
| `minIntervalMs`    | `2500`                                     | Minimum time between starts of Google requests |
| `cooldownMs`       | `60000`                                    | Fallback cooldown when recovery is disabled    |
| `recovery`         | `true`                                     | Recover tokenized Explore flows after HTTP 429 |
| `recoveryDelaysMs` | 1, 2, 3, 5, 10, 15, 20, 25, and 30 minutes | Delays before successive recovery attempts     |
| `adaptivePacing`   | See below                                  | Increase spacing after 429s and recover slowly |

Adaptive pacing is enabled by default. It starts at `minIntervalMs`, doubles the current interval
after each HTTP 429, caps it at 30 seconds by default, and reduces it by 25% only after four
consecutive successful HTTP requests. Ordinary failures reset the success streak without reducing
the interval.

| Adaptive option    | Default                     | Description                                    |
| ------------------ | --------------------------- | ---------------------------------------------- |
| `enabled`          | `true`                      | Enable response-aware interval changes         |
| `maxIntervalMs`    | `max(30000, minIntervalMs)` | Upper bound for the adaptive interval          |
| `increaseFactor`   | `2`                         | Multiplier applied after each HTTP 429         |
| `recoveryFactor`   | `0.75`                      | Multiplier applied after a successful window   |
| `successThreshold` | `4`                         | Consecutive successes required before recovery |

The adaptive interval is local for an in-memory client. With `CoordinatedCacheStore` and shared
request pacing enabled, the interval and success streak are persisted and updated under the pacing
lease, so all coordinated processes respond to the same backoff state. That state expires after 24
hours without traffic.

Disable only the adaptive changes while keeping fixed request spacing and cooldown handling:

```ts
const trends = createClient({
  rateLimit: {
    minIntervalMs: 2_500,
    adaptivePacing: { enabled: false },
  },
});
```

Automatic recovery applies to tokenized Explore operations. It waits for the relevant endpoint's
cooldown, resets the cookie session, performs a fresh warm-up, and restarts the complete tokenized
request flow. A caller can cancel this wait with its `AbortSignal`.

For latency-sensitive applications, you can disable automatic recovery and handle
`RateLimitError` yourself:

```ts
const trends = createClient({
  rateLimit: {
    recovery: false,
  },
});
```

Disabling all rate-limit protection is possible but is not recommended for normal production use.

### Cache options

| Option           | Default                   | Description                                                   |
| ---------------- | ------------------------- | ------------------------------------------------------------- |
| `enabled`        | `true`                    | Enable result caching                                         |
| `ttlMs`          | 15 minutes                | How long a successful result remains fresh                    |
| `staleIfErrorMs` | 24 hours                  | How long an expired result remains eligible after a 429       |
| `maxEntries`     | `100`                     | Maximum results kept in this client's in-memory L1 cache      |
| `store`          | `undefined`               | Optional synchronous or asynchronous persistent cache adapter |
| `keyPrefix`      | `'google-trends-api:v1:'` | Namespace used for persistent cache entries                   |
| `coordination`   | Auto-detected             | Cross-instance locks and shared cooldown settings             |

Use a long-lived client instance to benefit from its session, request governor, deduplication, and
cache. Creating a new client for every call defeats those protections.

#### Persistent cache stores

Add a `CacheStore` when several client instances, serverless invocations, or application processes
need to reuse completed results. The package keeps its bounded in-memory cache as L1 and consults
the supplied store as L2:

```ts
import { createClient, type CacheStore } from '@arham-rumi/google-trends-api';

const store: CacheStore = {
  async get(key) {
    // Return the exact bytes previously passed to set(), or undefined on a miss.
    return database.get(key);
  },
  async set(key, value, ttlMs) {
    await database.set(key, value, { ttlMs });
  },
  async delete(key) {
    await database.delete(key);
  },
  async clear(keyPrefix) {
    await database.deleteByPrefix(keyPrefix);
  },
};

const trends = createClient({
  cache: {
    store,
    keyPrefix: 'my-service:google-trends:v1:',
  },
});
```

The adapter must treat values as opaque `Uint8Array` bytes, preserve them exactly, and enforce the
provided TTL. `clear(keyPrefix)` must delete only keys in that namespace. The package handles
serialization, restores values such as `Date` objects, hashes request details into safe fixed-length
keys, and removes invalid or expired persistent entries. Use a distinct `keyPrefix` when deployments
must not share cached data.

Cache-store errors reject the request instead of silently bypassing the shared cache. This makes a
broken adapter visible and avoids an unnoticed burst of requests to Google.

#### Cross-instance coordination

To prevent identical cache misses in different processes from all reaching Google, implement the
three atomic lease methods in `CoordinatedCacheStore`:

```ts
import type { CoordinatedCacheStore } from '@arham-rumi/google-trends-api';

const store: CoordinatedCacheStore = {
  // get(), set(), delete(), and clear() are the CacheStore methods shown above.
  ...persistentStore,

  async acquireLock(key, owner, ttlMs) {
    // Atomically create the lock only when it does not already exist.
    return locks.setIfAbsent(key, owner, { ttlMs });
  },
  async refreshLock(key, owner, ttlMs) {
    // Atomically extend the TTL only when the stored owner still matches.
    return locks.refreshIfOwner(key, owner, { ttlMs });
  },
  async releaseLock(key, owner) {
    // Atomically delete only when the stored owner still matches.
    await locks.deleteIfOwner(key, owner);
  },
};
```

These operations must be atomic; for Redis-like stores, use compare-and-delete/refresh scripts
rather than a separate `GET` followed by `DEL` or `EXPIRE`. Coordination is enabled automatically
when all three methods are present. It provides:

- Cross-instance singleflight for identical requests, with cache rechecks before and after locking.
- Renewable leases so a normal long-running request does not lose its lock.
- Lock-expiry recovery when an owner process exits unexpectedly.
- Endpoint-specific shared HTTP 429 cooldowns, keeping the longest observed deadline.
- Stale-cache fallback in one instance when another instance has already observed a cooldown.
- Shared serialization and minimum start spacing for every underlying HTTP request, including the
  separate Explore and data requests made by one high-level operation.

Tune or disable it with:

```ts
const trends = createClient({
  cache: {
    store,
    coordination: {
      enabled: true,
      sharedRequestPacing: true,
      lockTtlMs: 30_000,
      pollIntervalMs: 100,
    },
  },
});
```

| Coordination option   | Default | Description                                                     |
| --------------------- | ------- | --------------------------------------------------------------- |
| `enabled`             | Auto    | Enabled when the store implements all atomic lease methods      |
| `sharedRequestPacing` | `true`  | Serialize and space HTTP starts across coordinated clients      |
| `lockTtlMs`           | `30000` | Lease TTL, renewed while the owner is still working             |
| `pollIntervalMs`      | `100`   | Delay before a waiter rechecks a contested lock or cached value |

`pollIntervalMs` must be shorter than `lockTtlMs`. A regular `CacheStore` remains fully supported;
it shares completed results without cross-instance locking, cooldown coordination, or request
pacing. Coordinated clients sharing a `keyPrefix` should use the same `minIntervalMs`; set
`sharedRequestPacing: false` only when another infrastructure layer already enforces a global
request budget.

## Caching, deduplication, and rate limits

The default request path works as follows:

1. Return a fresh cached result when available.
2. Join an identical in-flight request rather than sending another Google request.
3. Serialize and space outgoing requests.
4. Cache successful results.
5. Track HTTP 429 cooldowns per relevant Google endpoint.
6. Return an eligible stale cached result during that endpoint's cooldown when possible.

Inspect the source of a returned result with `getResultMetadata()`:

```ts
import { getResultMetadata } from '@arham-rumi/google-trends-api';

const result = await trends.interestOverTime({ keywords: 'node.js' });
const metadata = getResultMetadata(result);

console.log(metadata);
// {
//   source: 'network' | 'cache' | 'stale-cache',
//   stale: boolean,
//   cachedAt?: Date
// }
```

The metadata is attached out-of-band and does not alter Google's normalized result shape.

```ts
console.log(trends.cacheSize);
console.log(trends.cooldownRemainingMs);
console.log(trends.requestIntervalMs);

await trends.clearCache();
```

- `cacheSize` is the number of entries in this client's in-memory L1 cache.
- `cooldownRemainingMs` is the largest current endpoint cooldown observed by this client.
- `requestIntervalMs` is the request interval currently observed by this client, including adaptive
  backoff learned from coordinated peers.
- `clearCache()` clears L1 and the configured persistent result entries. It does not reset cookies,
  locks, or cooldowns.

Without a `store`, the cache is local to one client instance. A regular persistent store shares
completed results. A `CoordinatedCacheStore` also coalesces identical misses and shares observed
cooldowns and request pacing, but it does not bypass Google's rate limits. Returned results are
cloned, so changing one result does not mutate the cached value returned to another caller.

## Cancellation

Every public request method accepts an `AbortSignal`:

```ts
const controller = new AbortController();

const request = trends.interestOverTime({
  keywords: 'node.js',
  signal: controller.signal,
});

controller.abort();

try {
  await request;
} catch (error) {
  console.error(error);
}
```

When identical callers share one in-flight request, canceling one caller does not cancel the other
callers. The underlying request is aborted only after all consumers have canceled.

You can also set a deadline without creating a controller:

```ts
await trends.trendingNow({
  geo: 'US',
  signal: AbortSignal.timeout(5_000),
});
```

## Error handling

```ts
import {
  GoogleTrendsError,
  RateLimitError,
  RequestAbortedError,
  RequestTimeoutError,
  createClient,
} from '@arham-rumi/google-trends-api';

try {
  await createClient().trendingNow({ geo: 'US' });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error('Rate limited:', error.url, error.retryAfterMs);
  } else if (error instanceof RequestTimeoutError) {
    console.error('Timed out:', error.url, error.timeoutMs);
  } else if (error instanceof RequestAbortedError) {
    console.error('Request canceled:', error.url);
  } else if (error instanceof GoogleTrendsError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

| Error class            | Code               | Meaning                                               |
| ---------------------- | ------------------ | ----------------------------------------------------- |
| `HttpStatusError`      | `HTTP_STATUS`      | Non-success HTTP status other than the typed 429 case |
| `RateLimitError`       | `RATE_LIMITED`     | Google returned HTTP 429                              |
| `RequestTimeoutError`  | `REQUEST_TIMEOUT`  | An HTTP attempt exceeded its timeout                  |
| `RequestAbortedError`  | `REQUEST_ABORTED`  | The request was canceled                              |
| `NetworkError`         | `NETWORK_ERROR`    | The network request failed                            |
| `InvalidResponseError` | `INVALID_RESPONSE` | Google's response could not be parsed or validated    |
| `WidgetNotFoundError`  | `WIDGET_NOT_FOUND` | Explore omitted a required widget                     |

Invalid local inputs such as an empty keyword, unsupported property, or non-positive limit throw a
standard `RangeError` before making the affected Google request.

Do not treat a `RateLimitError` as evidence of a parser bug. Wait for the suggested or configured
cooldown and avoid immediate retry loops.

## CommonJS

```js
const { createClient, getResultMetadata } = require('@arham-rumi/google-trends-api');

(async () => {
  const trends = createClient();
  const result = await trends.trendingNow({ geo: 'US', limit: 5 });

  console.log(result.trends);
  console.log(getResultMetadata(result));
})().catch(console.error);
```

## Production guidance

### Reuse one client

Create a client per configuration or service boundary and reuse it:

```ts
// trends.ts
import { createClient } from '@arham-rumi/google-trends-api';

export const trends = createClient({
  locale: 'en-US',
  cache: {
    ttlMs: 30 * 60_000,
    maxEntries: 250,
  },
});
```

This preserves cookies and lets related calls share pacing, cooldowns, cache entries, and in-flight
requests.

### Warm-up is normally automatic

Explore operations warm up the Google session lazily when Google returns a session or challenge
response. Most applications do not need to call `warmup()` manually.

Call it during startup only when you intentionally want to establish the session early:

```ts
await trends.warmup();
```

### Choose cache settings for your data freshness

- Use a longer `ttlMs` for dashboards that do not need minute-by-minute updates.
- Keep `staleIfErrorMs` long enough to serve useful fallback data during a temporary 429.
- Keep `maxEntries` bounded when accepting arbitrary user-supplied comparisons.
- Supply a persistent `CacheStore` when multiple processes or serverless invocations should reuse
  completed results.
- Implement `CoordinatedCacheStore` atomic leases to deduplicate identical cross-process misses and
  share endpoint cooldowns and request pacing.
- Reuse one client inside each process; cookie sessions remain process-local.

### Preserve Google semantics

- Display `formattedValue` when Google provides labels such as `Breakout`.
- Respect `hasData` and `isPartial` instead of converting them into zero or complete data.
- Expect valid empty related-query/topic lists.
- Do not interpret normalized scores as absolute traffic.
- Store the query inputs alongside cached or persisted results; normalization depends on the entire
  comparison.

### Custom networking

Advanced users can provide a fetch-compatible function for controlled networking, instrumentation,
or tests:

```ts
const trends = createClient({
  fetch: async (input, init) => {
    const startedAt = Date.now();

    try {
      return await fetch(input, init);
    } finally {
      console.log('Google Trends request duration:', Date.now() - startedAt);
    }
  },
});
```

The custom function must behave like native `fetch` and return a standard `Response`. Do not strip
cookies, abort signals, or request headers supplied by the client.

## Development and verification

Install dependencies and run the deterministic project gate:

```bash
npm install
npm run check
```

Useful deterministic commands:

| Command                 | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `npm run format:check`  | Check Prettier formatting                         |
| `npm run lint`          | Run ESLint                                        |
| `npm run typecheck`     | Run TypeScript without emitting files             |
| `npm test`              | Run deterministic Vitest tests                    |
| `npm run package:check` | Build and validate package/types                  |
| `npm run test:package`  | Test packed ESM and CommonJS consumers            |
| `npm run release:check` | Run the complete pre-release gate and npm dry run |

Build and run the basic example:

```bash
npm run build
node examples/basic.mjs
```

### Live checks

Live checks call Google and are intentionally separate from deterministic CI. Run them sparingly:

```bash
npm run smoke:live
npm run verify:live
```

Individual deep validators:

```bash
npm run verify:interest-live
npm run verify:region-live
npm run verify:related-queries-live
npm run verify:related-topics-live
npm run verify:trending-live
npm run verify:autocomplete-live
```

The deep validators compare package output with the raw Google response for the same request. The
Interest Over Time validator also checks per-comparison geography by default. Override its list by
supplying one comma-separated geography per keyword:

```powershell
$env:GOOGLE_TRENDS_TEST_COMPARISON_GEOS="US,GB"
npm run verify:interest-live
```

Verify the exact package installed from npm in a clean temporary project:

```bash
npm run verify:published
```

Live validator exit codes are:

- `0`: passed
- `1`: request, parser, or validation failure
- `2`: rate-limited/inconclusive

A live check may fail because Google changed an endpoint, presented a challenge page, temporarily
blocked the runner's IP, or returned HTTP 429. Do not weaken a validator merely to make it pass;
first determine whether Google changed behavior, the validator made an invalid assumption, or the
package has a real bug.

## Limitations and responsible use

- Google does not offer these web endpoints as a stable public API contract.
- Response schemas, widget availability, tokens, URLs, and rate-limit behavior may change.
- Results vary by geography, language, time, and Google's sampling.
- Low-volume searches and optional fields may be omitted.
- The Trending Now method reflects the RSS feed rather than every interactive UI feature.
- This library does not provide absolute search volume or Google Ads data.

Applications should handle typed errors, cache appropriate results, avoid high-frequency polling,
respect cooldowns, and comply with applicable Google terms and policies.

## Collaboration and contact

Contributions, implementation ideas, bug reports, and collaboration proposals are welcome. To
discuss working together on this project, contact [info@arhamrumi.com](mailto:info@arhamrumi.com).

## License

MIT © 2026 arham-rumi contributors
