# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added typed `comparisonItems` inputs with per-item geography and time-range overrides for
  interest over time, interest by region, related queries, and related topics.
- Preserved the existing `keywords`, `geo`, and `timeRange` shorthand as a mutually exclusive,
  backward-compatible input form.
- Added a pluggable `CacheStore` interface for sharing completed results across client instances,
  processes, and serverless invocations while retaining the bounded in-memory L1 cache.
- Added versioned opaque serialization, persistent TTL handling, prefix-scoped clearing, and
  fixed-length hashed cache keys. Cached `Date` values and result-cloning behavior are preserved.
- Added optional `CoordinatedCacheStore` atomic leases for cross-instance request coalescing,
  renewable locks, owner-safe release, and lock-expiry recovery.
- Added persistent endpoint-specific HTTP 429 cooldown coordination so one instance can prevent
  another from making an avoidable request and can unlock shared stale-cache fallback.
- Added shared HTTP request serialization and minimum start spacing across coordinated clients,
  including the multiple underlying requests made by tokenized Explore operations.
- Added bounded adaptive pacing that increases the request interval after HTTP 429 responses and
  recovers gradually after a configurable consecutive-success window.
- Persisted adaptive interval and recovery progress for coordinated clients, with
  `requestIntervalMs` exposed for runtime observability.
- Added bounded request admission with configurable pending-work and queue-wait limits.
- Added endpoint-specific protective circuits that open after repeated 429s, remain isolated from
  healthy endpoints, and share state across coordinated clients.
- Added typed `RequestBudgetExceededError` reasons for queue saturation, queue timeout, and open
  circuits, plus pending-request and circuit observability getters.
- Added typed, vendor-neutral lifecycle events for operation sources, in-flight joins, HTTP timing,
  adaptive pacing, budget rejection, and circuit transitions.
- Added immutable `getMetrics()` snapshots with cumulative counters and live gauges, plus
  `resetMetrics()` and listener-error isolation.
- Added `createRedisCacheStore()` with binary-safe persistent caching, incremental namespace
  clearing, and atomic owner-checked coordination leases for node-redis, ioredis, and compatible
  command executors.
- Added typed `client.batch()` workloads with bounded concurrency, ordered settled results,
  duplicate-key coalescing, shared cancellation, and isolated progress reporting.

### Changed

- `clearCache()` now returns `Promise<void>` and clears both the in-memory cache and the configured
  persistent-cache namespace. Existing calls remain valid, but should be awaited when a persistent
  store is configured.

### Testing

- Extended deep Interest Over Time verification to compare per-item geography requests and package
  output directly against Google's raw response without adding extra live requests.
- Added deterministic lease, shared-cooldown, concurrent-client, and coordinated stale-fallback
  coverage.
- Added cross-client coverage proving unrelated request keys obey the shared pacing interval.
- Added deterministic local and cross-client adaptive backoff, recovery, validation, and
  observability coverage.
- Added deterministic queue-capacity, queue-timeout, endpoint isolation, shared-circuit, and stale
  circuit-fallback coverage.
- Added deterministic event, metric, reset, immutability, in-flight, and listener-isolation
  coverage.
- Added deterministic Redis adapter coverage for binary payloads, TTLs, atomic lock scripts,
  namespace scans, bounded deletion, and invalid responses.
- Added deterministic bulk-workload coverage for concurrency bounds, ordering, failures,
  deduplication, progress, cancellation, immutability, and callback isolation.
- Added a real Redis 7.4 CI suite covering TTL expiry, atomic cross-connection leases, escaped
  namespace clearing, and end-to-end request coalescing between clients.

## 0.2.4 - 2026-08-08

### Fixed

- Fixed `relatedTopics()` for multi-keyword requests when Google omits
  `RELATED_TOPICS` widgets from comparison Explore responses.
- Added per-keyword Explore fallback while preserving the original keyword order.

### Testing

- Added deep live verification for Interest By Region.
- Added deep live verification for Related Queries.
- Added deep live verification for Related Topics.
- Added deep live verification for Trending Now.
- Added deep live verification for Autocomplete.
- Verified package output against Google's raw responses for all supported
  Google Trends data endpoints.

## 0.2.3 - 2026-08-07

- Added deep live validation for Interest Over Time.
- Added `npm run verify:interest-live`.
- Documented the live pre-release verification workflow.

## [0.2.2] - 2026-08-07

### Added

- Added a full live-data smoke command covering warm-up, autocomplete, Trending Now, interest over time, interest by region, related queries, and related topics.
- Added a deep Interest Over Time live validator that compares package output with the raw Google timeline response for the same request.
- Expanded scheduled live integration coverage to all public data methods.

### Fixed

- Kept stale-cache fallback endpoint-specific so a cooldown on one Google Trends route does not suppress fresh requests to unrelated routes.

## [0.2.1] - 2026-08-05

### Fixed

- Restored automatic recovery for rate-limited tokenized requests.
- Added progressive recovery delays of 1, 2, 3, 5, 10, 15, 20, 25, and 30 minutes.
- Reset the Google session and performed a fresh warm-up before retrying the complete tokenized request flow.
- Preserved request queueing, caching, deduplication, stale-cache fallback, `Retry-After` handling, and abort support during recovery.

## [0.2.0] - 2026-08-04

### Added

- Serialized request governor with configurable spacing and shared HTTP 429 cooldowns.
- In-memory LRU result cache with fresh and stale windows.
- Identical-request deduplication across concurrent callers.
- `getResultMetadata()`, `clearCache()`, `cacheSize`, and `cooldownRemainingMs`.

### Changed

- Google sessions now warm up lazily only after a session or challenge response.
- HTTP 429 responses are no longer retried immediately and `Retry-After` controls cooldown timing.
- Stale cached results are returned during rate limits when available.

## [0.1.0] - 2026-08-03

### Added

- Modern TypeScript client with ESM and CommonJS builds.
- Cookie-aware HTTP sessions with timeouts, retry handling, and abort signals.
- Typed error hierarchy for network, HTTP, parsing, rate-limit, timeout, cancellation, and missing-widget failures.
- Google anti-XSSI response parsing and Explore widget token discovery.
- Interest over time.
- Interest by region.
- Related queries and related topics.
- Trending Now RSS results.
- Search-term and topic autocomplete.
- Public constants for supported search properties and geographic resolutions.
- Unit tests and package validation with Vitest, Publint, and Are The Types Wrong.
- Cross-platform GitHub Actions CI for supported Node.js versions.
- Weekly Dependabot checks for npm and GitHub Actions updates.
- Opt-in and scheduled live integration smoke tests for Explore, autocomplete, and Trending Now.
- Packed-package consumer tests for both ESM and CommonJS.
- Tag-based npm publishing workflow prepared for Trusted Publishing.

[Unreleased]: https://github.com/arham-rumi/google-trends-api/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/arham-rumi/google-trends-api/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/arham-rumi/google-trends-api/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/arham-rumi/google-trends-api/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/arham-rumi/google-trends-api/releases/tag/v0.1.0
