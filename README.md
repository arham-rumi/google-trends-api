# @arham-rumi/google-trends-api

[![CI](https://github.com/arham-rumi/google-trends-api/actions/workflows/ci.yml/badge.svg)](https://github.com/arham-rumi/google-trends-api/actions/workflows/ci.yml)
[![Live Integration](https://github.com/arham-rumi/google-trends-api/actions/workflows/live-integration.yml/badge.svg)](https://github.com/arham-rumi/google-trends-api/actions/workflows/live-integration.yml)

A modern, typed, unofficial Google Trends client for Node.js.

> This package is not affiliated with, maintained by, or endorsed by Google.
> It uses endpoints that Google may change without notice.

## Features

- TypeScript-first API with generated declarations
- ESM and CommonJS builds
- Interest over time for up to five terms or topics
- Interest by country, region, city, or DMA
- Related queries and related topics
- Trending Now RSS data
- Search-term and topic autocomplete
- Cookie-aware sessions, timeouts, retries, abort signals, and typed errors

## Requirements

- Node.js 22.14.0 or newer

## Installation

```bash
npm install @arham-rumi/google-trends-api
```

## Quick start

```ts
import { createClient } from '@arham-rumi/google-trends-api';

const trends = createClient({
  locale: 'en-US',
  timeoutMs: 15_000,
  retries: 2,
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

Google Trends values are normalized relative scores, usually from `0` to `100`. They are not absolute search volumes.

## Client configuration

```ts
const trends = createClient({
  locale: 'en-US',
  timezone: 0,
  timeoutMs: 10_000,
  retries: 2,
  userAgent: 'my-app/1.0 (+https://example.com)',
});
```

| Option      | Default         | Description                                 |
| ----------- | --------------- | ------------------------------------------- |
| `locale`    | `en-US`         | Locale sent to Google Trends.               |
| `timezone`  | `0`             | Google Trends timezone offset in minutes.   |
| `timeoutMs` | `10000`         | Timeout for each HTTP attempt.              |
| `retries`   | `2`             | Additional attempts for temporary failures. |
| `userAgent` | Package default | User agent sent with requests.              |
| `fetch`     | Native `fetch`  | Optional custom fetch implementation.       |

## Interest over time

```ts
const result = await trends.interestOverTime({
  keywords: ['typescript', 'javascript'],
  geo: 'PK',
  timeRange: 'now 7-d',
  category: 0,
  property: '',
});

console.log(result.timeline);
console.log(result.averages);
```

`keywords` accepts one value or up to five values. A topic machine ID returned by `autocomplete()` can also be used as a keyword.

## Interest by region

```ts
import { INTEREST_BY_REGION_RESOLUTIONS, createClient } from '@arham-rumi/google-trends-api';

console.log(INTEREST_BY_REGION_RESOLUTIONS);

const result = await trends.interestByRegion({
  keywords: 'artificial intelligence',
  geo: 'US',
  resolution: 'REGION',
  includeLowSearchVolumeGeos: true,
});

console.log(result.regions);
```

Supported resolutions are `COUNTRY`, `REGION`, `CITY`, and `DMA`. Availability depends on the selected geography and Google Trends data.

## Related queries

```ts
const results = await trends.relatedQueries({
  keywords: ['node.js', 'bun'],
  geo: 'US',
  timeRange: 'today 3-m',
});

for (const result of results) {
  console.log(result.keyword, result.top, result.rising);
}
```

## Related topics

```ts
const results = await trends.relatedTopics({
  keywords: 'machine learning',
  geo: 'US',
});

console.log(results[0]?.top);
console.log(results[0]?.rising);
```

## Trending Now

```ts
const result = await trends.trendingNow({
  geo: 'PK',
  limit: 10,
});

for (const trend of result.trends) {
  console.log(trend.title, trend.approxTraffic, trend.publishedAt);
}
```

`geo` must be a two-letter country or territory code.

## Autocomplete

```ts
const result = await trends.autocomplete({
  keyword: 'tesla',
  limit: 10,
});

for (const suggestion of result.suggestions) {
  console.log(suggestion.kind, suggestion.title, suggestion.keyword);
}
```

For topic suggestions, `suggestion.keyword` is the Google Knowledge Graph machine ID that can be passed to other methods.

## Search properties

```ts
import { GOOGLE_TRENDS_PROPERTIES } from '@arham-rumi/google-trends-api';

console.log(GOOGLE_TRENDS_PROPERTIES);
```

Valid `property` values are:

| Value       | Search surface  |
| ----------- | --------------- |
| `''`        | Web Search      |
| `'images'`  | Image Search    |
| `'news'`    | News Search     |
| `'youtube'` | YouTube Search  |
| `'froogle'` | Google Shopping |

## Cancellation

Every public request method accepts an `AbortSignal`:

```ts
const controller = new AbortController();

const request = trends.interestOverTime({
  keywords: 'node.js',
  signal: controller.signal,
});

controller.abort();
await request;
```

## Error handling

```ts
import {
  GoogleTrendsError,
  RateLimitError,
  RequestTimeoutError,
  createClient,
} from '@arham-rumi/google-trends-api';

try {
  await createClient().trendingNow({ geo: 'US' });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error('Rate limited. Retry later.', error.retryAfterMs);
  } else if (error instanceof RequestTimeoutError) {
    console.error('Request timed out.');
  } else if (error instanceof GoogleTrendsError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

Exported error classes include:

- `HttpStatusError`
- `RateLimitError`
- `RequestTimeoutError`
- `RequestAbortedError`
- `NetworkError`
- `InvalidResponseError`
- `WidgetNotFoundError`

## CommonJS

```js
const { createClient } = require('@arham-rumi/google-trends-api');

const trends = createClient();
```

## Development

```bash
npm install
npm run check
```

Run the repository example after building:

```bash
npm run build
node examples/basic.mjs
```

Run the opt-in live smoke tests:

```bash
npm run test:integration
```

The live suite calls Google endpoints and may fail when Google changes an endpoint, presents a challenge page, or rate-limits the runner. GitHub Actions runs this suite weekly and also supports manual runs.

## Limitations and responsible use

Google Trends does not provide these internal endpoints as a stable public contract. Responses, tokens, rate limits, or endpoint behavior can change. Applications should handle errors, cache appropriate results, avoid high-frequency polling, and comply with applicable Google terms and policies.

## License

MIT © 2026 arham-rumi contributors
