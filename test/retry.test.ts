import { describe, expect, it } from 'vitest';

import { buildUrl, parseRetryAfter } from '../src/http/request.js';

describe('HTTP request utilities', () => {
  it('creates query parameters correctly', () => {
    const url = buildUrl(new URL('https://example.test'), '/search', {
      keyword: ['typescript', 'node'],
      timezone: -300,
      enabled: true,
      ignored: undefined,
    });

    expect(url.toString()).toBe(
      'https://example.test/search?keyword=typescript&keyword=node&timezone=-300&enabled=true',
    );
  });

  it('parses retry-after seconds', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
  });

  it('returns undefined for invalid retry-after values', () => {
    expect(parseRetryAfter('invalid')).toBeUndefined();
  });
});
