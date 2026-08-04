import { describe, expect, it } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import { RequestGovernor } from '../src/rate-limit/governor.js';

describe('RequestGovernor', () => {
  it('serializes requests and spaces their start times', async () => {
    const governor = new RequestGovernor({
      enabled: true,
      minIntervalMs: 20,
      cooldownMs: 50,
    });
    const starts: number[] = [];

    await Promise.all([
      governor.execute(async () => {
        starts.push(Date.now());
      }),
      governor.execute(async () => {
        starts.push(Date.now());
      }),
    ]);

    expect(starts).toHaveLength(2);
    expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(15);
  });

  it('uses Retry-After as a shared cooldown', async () => {
    const governor = new RequestGovernor({
      enabled: true,
      minIntervalMs: 0,
      cooldownMs: 5,
    });

    await expect(
      governor.execute(async () => {
        throw new RateLimitError({
          url: 'https://example.test',
          responseBody: undefined,
          retryAfterMs: 30,
        });
      }),
    ).rejects.toBeInstanceOf(RateLimitError);

    const startedAt = Date.now();
    await governor.execute(async () => undefined);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });
});
