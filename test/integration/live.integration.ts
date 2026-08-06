import { describe, expect, it } from 'vitest';

import { RateLimitError, createClient } from '../../src/index.js';

const MIN_CHECK_INTERVAL_MS = 3_000;
const RATE_LIMIT_SKIP_MESSAGE =
  'Google returned HTTP 429, so this live check is inconclusive rather than a package failure.';

let previousCheckFinishedAt = 0;

function createLiveClient() {
  return createClient({
    locale: 'en-US',
    timeoutMs: 30_000,
    retries: 0,
    cache: { enabled: false },
    rateLimit: {
      minIntervalMs: MIN_CHECK_INTERVAL_MS,
      recovery: false,
    },
  });
}

async function waitBeforeNextCheck(): Promise<void> {
  const remainingMs = previousCheckFinishedAt + MIN_CHECK_INTERVAL_MS - Date.now();

  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
}

async function runLiveCheck<T>(
  operation: (client: ReturnType<typeof createLiveClient>) => Promise<T>,
  skip: (message?: string) => void,
): Promise<T> {
  await waitBeforeNextCheck();
  const client = createLiveClient();

  try {
    return await operation(client);
  } catch (error) {
    if (error instanceof RateLimitError) {
      skip(RATE_LIMIT_SKIP_MESSAGE);
    }

    throw error;
  } finally {
    previousCheckFinishedAt = Date.now();
  }
}

describe.sequential('live Google Trends smoke tests', () => {
  it('warms up the Google Trends session', async ({ skip }) => {
    await runLiveCheck((client) => client.warmup(), skip);
  });

  it('fetches autocomplete suggestions', async ({ skip }) => {
    const result = await runLiveCheck(
      (client) => client.autocomplete({ keyword: 'typescript', limit: 5 }),
      skip,
    );

    expect(result.query).toBe('typescript');
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
    expect(result.suggestions.every((suggestion) => suggestion.title.length > 0)).toBe(true);
  });

  it('fetches the Trending Now RSS feed', async ({ skip }) => {
    const result = await runLiveCheck(
      (client) => client.trendingNow({ geo: 'US', limit: 5 }),
      skip,
    );

    expect(result.geo).toBe('US');
    expect(result.trends.length).toBeGreaterThan(0);
    expect(result.trends.length).toBeLessThanOrEqual(5);
    expect(result.trends.every((trend) => trend.title.length > 0)).toBe(true);
  });

  it('fetches tokenized Interest Over Time data', async ({ skip }) => {
    const result = await runLiveCheck(
      (client) =>
        client.interestOverTime({
          keywords: ['typescript'],
          geo: 'US',
          timeRange: 'today 3-m',
        }),
      skip,
    );

    expect(result.timeline.length).toBeGreaterThan(0);
    expect(result.timeline.every((point) => point.values.length === 1)).toBe(true);
    expect(result.timeline.every((point) => !Number.isNaN(point.date.getTime()))).toBe(true);
  });

  it('fetches Interest By Region data', async ({ skip }) => {
    const result = await runLiveCheck(
      (client) =>
        client.interestByRegion({
          keywords: 'typescript',
          geo: 'US',
          timeRange: 'today 12-m',
          resolution: 'REGION',
        }),
      skip,
    );

    expect(result.regions.length).toBeGreaterThan(0);
    expect(result.regions.every((region) => region.geoName.length > 0)).toBe(true);
    expect(result.regions.every((region) => region.values.length === 1)).toBe(true);
  });

  it('fetches related queries', async ({ skip }) => {
    const result = await runLiveCheck(
      (client) =>
        client.relatedQueries({
          keywords: 'typescript',
          geo: 'US',
          timeRange: 'today 12-m',
        }),
      skip,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.keyword).toBe('typescript');
    expect((result[0]?.top.length ?? 0) + (result[0]?.rising.length ?? 0)).toBeGreaterThan(0);
  });

  it('fetches related topics', async ({ skip }) => {
    const result = await runLiveCheck(
      (client) =>
        client.relatedTopics({
          keywords: 'typescript',
          geo: 'US',
          timeRange: 'today 12-m',
        }),
      skip,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.keyword).toBe('typescript');
    expect((result[0]?.top.length ?? 0) + (result[0]?.rising.length ?? 0)).toBeGreaterThan(0);
  });
});
