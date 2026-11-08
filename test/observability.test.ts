import { describe, expect, it, vi } from 'vitest';

import { RateLimitError, RequestBudgetExceededError } from '../src/errors.js';
import { createClient, type GoogleTrendsEvent } from '../src/index.js';
import { MetricsCollector } from '../src/observability.js';
import { RequestGovernor, resolveRateLimitOptions } from '../src/rate-limit/governor.js';
import type { FetchLike } from '../src/types.js';

function responseWithUrl(body: string, url: string): Response {
  const response = new Response(body);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function autocompleteResponse(url: string): Response {
  return responseWithUrl(
    `)]}',\n${JSON.stringify({
      default: {
        topics: [
          {
            mid: '/m/test',
            title: 'Test topic',
            type: 'Topic',
          },
        ],
      },
    })}`,
    url,
  );
}

describe('observability', () => {
  it('reports network and cache events with immutable metric snapshots', async () => {
    const events: GoogleTrendsEvent[] = [];
    let requestCount = 0;
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestCount += 1;
      return autocompleteResponse(url.toString());
    };
    const client = createClient({
      retries: 0,
      rateLimit: { minIntervalMs: 0 },
      observability: { onEvent: (event) => events.push(event) },
      fetch: fakeFetch,
    });

    await client.autocomplete({ keyword: 'TypeScript' });
    await client.autocomplete({ keyword: 'TypeScript' });

    const metrics = client.getMetrics();
    expect(requestCount).toBe(1);
    expect(metrics).toMatchObject({
      networkResults: 1,
      cacheHits: 1,
      staleCacheHits: 0,
      httpRequestsStarted: 1,
      httpRequestsSucceeded: 1,
      httpRequestsFailed: 0,
      cacheSize: 1,
      pendingRequests: 0,
    });
    expect(Object.isFrozen(metrics)).toBe(true);
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
    expect(events.filter((event) => event.type === 'operation-result')).toEqual([
      expect.objectContaining({ type: 'operation-result', source: 'network' }),
      expect.objectContaining({ type: 'operation-result', source: 'cache' }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'http-request-start' }),
        expect.objectContaining({ type: 'http-request-complete', outcome: 'success' }),
      ]),
    );

    client.resetMetrics();
    expect(client.getMetrics()).toMatchObject({
      networkResults: 0,
      cacheHits: 0,
      httpRequestsStarted: 0,
      cacheSize: 1,
    });
  });

  it('counts identical callers that join an in-flight operation', async () => {
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let requestStarted: (() => void) | undefined;
    const requestStart = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestStarted?.();
      await requestGate;
      return autocompleteResponse(url.toString());
    };
    const client = createClient({
      retries: 0,
      rateLimit: { minIntervalMs: 0 },
      fetch: fakeFetch,
    });
    const first = client.autocomplete({ keyword: 'TypeScript' });

    await requestStart;
    const second = client.autocomplete({ keyword: 'TypeScript' });
    releaseRequest?.();
    await Promise.all([first, second]);

    expect(client.getMetrics()).toMatchObject({
      networkResults: 1,
      inflightJoins: 1,
      httpRequestsStarted: 1,
    });
  });

  it('isolates listener failures from successful requests', async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return autocompleteResponse(url.toString());
    };
    const client = createClient({
      retries: 0,
      rateLimit: { minIntervalMs: 0 },
      observability: {
        onEvent: () => {
          throw new Error('listener failed');
        },
      },
      fetch: fakeFetch,
    });

    await expect(client.autocomplete({ keyword: 'TypeScript' })).resolves.toBeDefined();
    expect(client.getMetrics().listenerErrors).toBeGreaterThan(0);
  });

  it('emits rate-limit, pacing, circuit, and budget events', async () => {
    vi.useFakeTimers();

    try {
      const events: GoogleTrendsEvent[] = [];
      const metrics = new MetricsCollector((event) => events.push(event));
      const governor = new RequestGovernor(
        resolveRateLimitOptions({
          minIntervalMs: 10,
          cooldownMs: 0,
          recovery: false,
          requestBudget: {
            maxPendingRequests: 1,
            maxQueueWaitMs: 1_000,
            circuitBreakerThreshold: 1,
            circuitOpenMs: 50,
          },
        }),
        undefined,
        metrics,
      );

      await expect(
        governor.execute(
          async () => {
            throw new RateLimitError({
              url: 'https://example.test/limited',
              responseBody: undefined,
              retryAfterMs: undefined,
            });
          },
          undefined,
          '/limited',
        ),
      ).rejects.toBeInstanceOf(RateLimitError);
      await expect(
        governor.execute(async () => 'blocked', undefined, '/limited'),
      ).rejects.toBeInstanceOf(RequestBudgetExceededError);

      await vi.advanceTimersByTimeAsync(50);
      await expect(governor.execute(async () => 'probe', undefined, '/limited')).resolves.toBe(
        'probe',
      );

      const snapshot = metrics.snapshot({
        cacheSize: 0,
        pendingRequests: governor.pendingRequests,
        requestIntervalMs: governor.requestIntervalMs,
        cooldownRemainingMs: governor.cooldownRemainingMs,
        circuitRemainingMs: governor.circuitRemainingMs,
      });
      expect(snapshot).toMatchObject({
        httpRequestsStarted: 2,
        httpRequestsSucceeded: 1,
        httpRequestsFailed: 1,
        rateLimits: 1,
        pacingIncreases: 1,
        circuitsOpened: 1,
        circuitsClosed: 1,
        budgetRejections: 1,
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'pacing-changed', reason: 'rate-limit' }),
          expect.objectContaining({ type: 'circuit-opened', endpoint: '/limited' }),
          expect.objectContaining({ type: 'circuit-closed', endpoint: '/limited' }),
          expect.objectContaining({ type: 'budget-rejected', reason: 'circuit-open' }),
        ]),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
