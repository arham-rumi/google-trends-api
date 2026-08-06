# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-08-05

### Added

- Added a full live-data smoke command covering warm-up, autocomplete, Trending Now, interest over time, interest by region, related queries, and related topics.
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
