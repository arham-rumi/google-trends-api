import { GoogleTrendsError, createClient } from '@arham-rumi/google-trends-api';

const trends = createClient({
  locale: 'en-US',
  timeoutMs: 15_000,
  retries: 2,
});

try {
  const interest = await trends.interestOverTime({
    keywords: ['node.js', 'deno'],
    geo: 'US',
    timeRange: 'today 3-m',
  });

  console.log('Latest interest point:');
  console.dir(interest.timeline.at(-1), { depth: null });

  const trending = await trends.trendingNow({
    geo: 'US',
    limit: 5,
  });

  console.log('\nTrending Now:');
  for (const item of trending.trends) {
    console.log(`- ${item.title} (${item.approxTraffic})`);
  }
} catch (error) {
  if (error instanceof GoogleTrendsError) {
    console.error(`[${error.code}] ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
