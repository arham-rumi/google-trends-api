import { describe, expect, it } from 'vitest';

import { HttpStatusError, RateLimitError } from '../src/errors.js';
import { HttpSession } from '../src/http/session.js';
import type { FetchLike } from '../src/types.js';

describe('HttpSession', () => {
  it('retries temporary server failures', async () => {
    let requestCount = 0;

    const fakeFetch: FetchLike = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response('Temporarily unavailable', {
          status: 503,
        });
      }

      return new Response('success', {
        status: 200,
      });
    };

    const session = new HttpSession({
      baseUrl: 'https://example.test',
      rateLimit: { enabled: false },
      fetch: fakeFetch,
      retry: {
        retries: 1,
        minDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
      },
    });

    await expect(session.getText('/data')).resolves.toBe('success');
    expect(requestCount).toBe(2);
  });

  it('does not retry permanent client errors', async () => {
    let requestCount = 0;

    const fakeFetch: FetchLike = async () => {
      requestCount += 1;

      return new Response('Bad request', {
        status: 400,
      });
    };

    const session = new HttpSession({
      baseUrl: 'https://example.test',
      rateLimit: { enabled: false },
      fetch: fakeFetch,
      retry: {
        retries: 3,
        minDelayMs: 0,
        maxDelayMs: 0,
      },
    });

    await expect(session.getText('/data')).rejects.toBeInstanceOf(HttpStatusError);
    expect(requestCount).toBe(1);
  });

  it('stores and sends session cookies', async () => {
    const receivedCookies: string[] = [];
    const fakeFetch: FetchLike = async (input, init) => {
      const cookie = new Headers(init?.headers).get('cookie');
      receivedCookies.push(cookie ?? '');

      const response =
        receivedCookies.length === 1
          ? new Response('first response', {
              status: 200,
              headers: {
                'set-cookie': 'NID=test-session; Path=/; HttpOnly',
              },
            })
          : new Response('second response', {
              status: 200,
            });
      const requestUrl = input instanceof Request ? input.url : input.toString();

      Object.defineProperty(response, 'url', {
        value: requestUrl,
        configurable: true,
      });

      return response;
    };

    const session = new HttpSession({
      baseUrl: 'https://example.test',
      rateLimit: { enabled: false },
      fetch: fakeFetch,
      retry: {
        retries: 0,
      },
    });

    await session.getText('/first');
    await session.getText('/second');

    expect(receivedCookies[0]).toBe('');
    expect(receivedCookies[1]).toContain('NID=test-session');
  });

  it('warms up through the Explore page with locale and geography', async () => {
    let requestedUrl: URL | undefined;

    const fakeFetch: FetchLike = async (input) => {
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString());

      return new Response('<html>ready</html>', {
        status: 200,
      });
    };

    const session = new HttpSession({
      baseUrl: 'https://trends.google.com',
      rateLimit: { enabled: false },
      fetch: fakeFetch,
      retry: {
        retries: 0,
      },
    });

    await session.warmup({
      locale: 'en-US',
      geo: 'US',
    });

    expect(requestedUrl?.pathname).toBe('/explore');
    expect(requestedUrl?.searchParams.get('hl')).toBe('en-US');
    expect(requestedUrl?.searchParams.get('geo')).toBe('US');
  });

  it('falls back to the Trends home page when Explore returns 404', async () => {
    const requestedPaths: string[] = [];

    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedPaths.push(url.pathname);

      return new Response(url.pathname === '/explore' ? 'Not found' : '<html>ready</html>', {
        status: url.pathname === '/explore' ? 404 : 200,
      });
    };

    const session = new HttpSession({
      baseUrl: 'https://trends.google.com',
      rateLimit: { enabled: false },
      fetch: fakeFetch,
      retry: {
        retries: 0,
      },
    });

    await session.warmup({ locale: 'en-US', geo: 'US' });

    expect(requestedPaths).toEqual(['/explore', '/trends/']);
  });

  it('does not immediately retry HTTP 429 responses', async () => {
    let requestCount = 0;

    const fakeFetch: FetchLike = async () => {
      requestCount += 1;
      return new Response('Too many requests', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    };

    const session = new HttpSession({
      baseUrl: 'https://example.test',
      rateLimit: { enabled: false },
      fetch: fakeFetch,
      retry: {
        retries: 3,
        minDelayMs: 0,
        maxDelayMs: 0,
      },
    });

    await expect(session.getText('/data')).rejects.toBeInstanceOf(RateLimitError);
    expect(requestCount).toBe(1);
  });

  it('tracks rate-limit cooldowns by endpoint path', async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());

      return new Response(url.pathname === '/limited' ? 'Too many requests' : 'ok', {
        status: url.pathname === '/limited' ? 429 : 200,
      });
    };

    const session = new HttpSession({
      baseUrl: 'https://example.test',
      rateLimit: {
        minIntervalMs: 0,
        cooldownMs: 1_000,
        recovery: false,
      },
      fetch: fakeFetch,
      retry: { retries: 0 },
    });

    await expect(session.getText('/limited?first=1')).rejects.toBeInstanceOf(RateLimitError);

    expect(session.getCooldownRemainingMs('/limited?second=2')).toBeGreaterThan(0);
    expect(session.getCooldownRemainingMs('/healthy')).toBe(0);

    await expect(session.getText('/healthy', { signal: AbortSignal.timeout(100) })).resolves.toBe(
      'ok',
    );

    expect(session.getCooldownRemainingMs('/limited')).toBeGreaterThan(0);
  });

  it('can replace its cookie jar during rate-limit recovery', async () => {
    const receivedCookies: string[] = [];

    const fakeFetch: FetchLike = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      receivedCookies.push(new Headers(init?.headers).get('cookie') ?? '');
      const response = new Response('ok', {
        status: 200,
        ...(receivedCookies.length === 1
          ? { headers: { 'set-cookie': 'NID=old-session; Path=/; HttpOnly' } }
          : {}),
      });

      Object.defineProperty(response, 'url', {
        value: url,
        configurable: true,
      });

      return response;
    };

    const session = new HttpSession({
      baseUrl: 'https://example.test',
      rateLimit: { enabled: false },
      fetch: fakeFetch,
      retry: { retries: 0 },
    });

    await session.getText('/first');
    await session.getText('/second');
    session.resetCookies();
    await session.getText('/third');

    expect(receivedCookies[0]).toBe('');
    expect(receivedCookies[1]).toContain('NID=old-session');
    expect(receivedCookies[2]).toBe('');
  });
});
