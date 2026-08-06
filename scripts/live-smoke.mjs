import { createClient, RateLimitError } from '../dist/index.mjs';

const keyword = process.env.GOOGLE_TRENDS_TEST_KEYWORD?.trim() || 'typescript';
const geo = (process.env.GOOGLE_TRENDS_TEST_GEO?.trim() || 'US').toUpperCase();

const client = createClient({
  locale: 'en-US',
  timeoutMs: 30_000,
  retries: 1,
  cache: { enabled: false },
  rateLimit: {
    minIntervalMs: 3_000,
    recovery: false,
  },
});

const checks = [
  {
    name: 'warmup',
    run: async () => {
      await client.warmup();
      return { ok: true };
    },
  },
  {
    name: 'autocomplete',
    run: async () => {
      const result = await client.autocomplete({ keyword, limit: 5 });
      if (result.suggestions.length === 0) throw new Error('No autocomplete suggestions returned.');
      return {
        query: result.query,
        count: result.suggestions.length,
        sample: result.suggestions
          .slice(0, 3)
          .map(({ title, type, kind }) => ({ title, type, kind })),
      };
    },
  },
  {
    name: 'trendingNow',
    run: async () => {
      const result = await client.trendingNow({ geo, limit: 5 });
      if (result.trends.length === 0) throw new Error('No Trending Now items returned.');
      return {
        geo: result.geo,
        count: result.trends.length,
        sample: result.trends.slice(0, 3).map(({ title, approxTraffic, publishedAt }) => ({
          title,
          approxTraffic,
          publishedAt: publishedAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'interestOverTime',
    run: async () => {
      const result = await client.interestOverTime({
        keywords: keyword,
        geo,
        timeRange: 'today 3-m',
      });
      if (result.timeline.length === 0) throw new Error('No timeline points returned.');
      return {
        points: result.timeline.length,
        first: result.timeline[0]?.date.toISOString(),
        last: result.timeline.at(-1)?.date.toISOString(),
        latestValue: result.timeline.at(-1)?.values[0]?.value,
      };
    },
  },
  {
    name: 'interestByRegion',
    run: async () => {
      const result = await client.interestByRegion({
        keywords: keyword,
        geo,
        timeRange: 'today 12-m',
        resolution: 'REGION',
      });
      if (result.regions.length === 0) throw new Error('No regional points returned.');
      return {
        count: result.regions.length,
        sample: result.regions.slice(0, 3).map(({ geoName, geoCode, values }) => ({
          geoName,
          geoCode,
          value: values[0]?.value,
        })),
      };
    },
  },
  {
    name: 'relatedQueries',
    run: async () => {
      const result = await client.relatedQueries({
        keywords: keyword,
        geo,
        timeRange: 'today 12-m',
      });
      if (result.length === 0) throw new Error('No related-query result groups returned.');
      return {
        keyword: result[0]?.keyword,
        topCount: result[0]?.top.length ?? 0,
        risingCount: result[0]?.rising.length ?? 0,
        sample: result[0]?.top.slice(0, 3).map(({ query, formattedValue }) => ({
          query,
          formattedValue,
        })),
      };
    },
  },
  {
    name: 'relatedTopics',
    run: async () => {
      const result = await client.relatedTopics({
        keywords: keyword,
        geo,
        timeRange: 'today 12-m',
      });
      if (result.length === 0) throw new Error('No related-topic result groups returned.');
      return {
        keyword: result[0]?.keyword,
        topCount: result[0]?.top.length ?? 0,
        risingCount: result[0]?.rising.length ?? 0,
        sample: result[0]?.top.slice(0, 3).map(({ topic, formattedValue }) => ({
          title: topic.title,
          type: topic.type,
          formattedValue,
        })),
      };
    },
  },
];

const report = {
  startedAt: new Date().toISOString(),
  keyword,
  geo,
  node: process.version,
  checks: [],
};

for (const check of checks) {
  const startedAt = Date.now();

  try {
    const data = await check.run();
    report.checks.push({
      name: check.name,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      data,
    });
  } catch (error) {
    report.checks.push({
      name: check.name,
      status: error instanceof RateLimitError ? 'rate-limited' : 'failed',
      durationMs: Date.now() - startedAt,
      error: {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof RateLimitError
          ? { url: error.url, retryAfterMs: error.retryAfterMs }
          : {}),
      },
    });

    console.log(JSON.stringify(report, null, 2));
    process.exitCode = error instanceof RateLimitError ? 2 : 1;
    break;
  }
}

if (process.exitCode === undefined) {
  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}
