import { describe, expect, it } from 'vitest';

import { RateLimitError, createClient } from '../../src/index.js';

function createLiveClient() {
  return createClient({
    locale: 'en-US',
    timeoutMs: 30_000,
    retries: 0,
    rateLimit: { recovery: false },
  });
}

const RATE_LIMIT_SKIP_MESSAGE =
  'Google returned HTTP 429, so this live check is inconclusive rather than a package failure.';

describe('live Google Trends smoke tests', () => {
  it('fetches tokenized Interest Over Time data', async ({ skip }) => {
    try {
      const result = await createLiveClient().interestOverTime({
        keywords: ['typescript'],
        geo: 'US',
        timeRange: 'today 3-m',
      });

      expect(result.timeline.length).toBeGreaterThan(0);
      expect(result.timeline.every((point) => point.values.length === 1)).toBe(true);
      expect(result.timeline.every((point) => !Number.isNaN(point.date.getTime()))).toBe(true);
    } catch (error) {
      if (error instanceof RateLimitError) {
        skip(RATE_LIMIT_SKIP_MESSAGE);
      }

      throw error;
    }
  });

  it('fetches autocomplete suggestions', async ({ skip }) => {
    try {
      const result = await createLiveClient().autocomplete({
        keyword: 'typescript',
        limit: 5,
      });

      expect(result.query).toBe('typescript');
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
      expect(result.suggestions.every((suggestion) => suggestion.title.length > 0)).toBe(true);
    } catch (error) {
      if (error instanceof RateLimitError) {
        skip(RATE_LIMIT_SKIP_MESSAGE);
      }

      throw error;
    }
  });

  it('fetches the Trending Now RSS feed', async ({ skip }) => {
    try {
      const result = await createLiveClient().trendingNow({
        geo: 'US',
        limit: 5,
      });

      expect(result.geo).toBe('US');
      expect(result.trends.length).toBeGreaterThan(0);
      expect(result.trends.length).toBeLessThanOrEqual(5);
      expect(result.trends.every((trend) => trend.title.length > 0)).toBe(true);
    } catch (error) {
      if (error instanceof RateLimitError) {
        skip(RATE_LIMIT_SKIP_MESSAGE);
      }

      throw error;
    }
  });
});
