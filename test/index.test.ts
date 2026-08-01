import { describe, expect, it } from 'vitest';

import { createClient } from '../src/index.js';

describe('createClient', () => {
  it('creates a client with safe defaults', () => {
    const client = createClient();

    expect(client.options).toEqual({
      locale: 'en-US',
      timezone: 0,
      timeoutMs: 10_000,
    });
  });
});
