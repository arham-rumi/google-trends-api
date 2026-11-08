import { describe, expect, it, vi } from 'vitest';

import { createClient, type BatchProgress } from '../src/index.js';

describe('GoogleTrendsClient.batch', () => {
  it('bounds concurrency and preserves input order with settled failures', async () => {
    const client = createClient();
    let active = 0;
    let maximumActive = 0;

    const results = await client.batch(
      [3, 1, 2, 4],
      async (input) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, input));
        active -= 1;

        if (input === 2) {
          throw new Error('two failed');
        }
        return input * 10;
      },
      { concurrency: 2 },
    );

    expect(maximumActive).toBe(2);
    expect(results).toEqual([
      { status: 'fulfilled', value: 30 },
      { status: 'fulfilled', value: 10 },
      { status: 'rejected', reason: expect.objectContaining({ message: 'two failed' }) },
      { status: 'fulfilled', value: 40 },
    ]);
    expect(Object.isFrozen(results)).toBe(true);
    expect(results.every((result) => Object.isFrozen(result))).toBe(true);
  });

  it('coalesces duplicate keys and reports progress for every original input', async () => {
    const client = createClient();
    const progress: BatchProgress[] = [];
    const worker = vi.fn(async (input: string, context: { index: number }) => ({
      input: input.toUpperCase(),
      workerIndex: context.index,
    }));

    const results = await client.batch(['Node', 'node', 'React', 'NODE'], worker, {
      concurrency: 2,
      deduplicateBy: (input) => input.toLowerCase(),
      onProgress: (event) => progress.push(event),
    });

    expect(worker).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { status: 'fulfilled', value: { input: 'NODE', workerIndex: 0 } },
      { status: 'fulfilled', value: { input: 'NODE', workerIndex: 0 } },
      { status: 'fulfilled', value: { input: 'REACT', workerIndex: 2 } },
      { status: 'fulfilled', value: { input: 'NODE', workerIndex: 0 } },
    ]);
    expect(progress).toHaveLength(4);
    expect(progress.map((event) => event.completed)).toEqual([1, 2, 3, 4]);
    expect(progress.filter((event) => event.deduplicated).map((event) => event.index)).toEqual([
      1, 3,
    ]);
    expect(progress.every((event) => Object.isFrozen(event))).toBe(true);
  });

  it('passes cancellation to the active worker and rejects pending inputs without starting them', async () => {
    const client = createClient();
    const controller = new AbortController();
    const reason = new Error('stop batch');
    let started = 0;
    let notifyStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const batch = client.batch(
      ['first', 'second', 'third'],
      async (_input, { signal }) => {
        started += 1;
        notifyStarted?.();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      { concurrency: 1, signal: controller.signal },
    );

    await firstStarted;
    controller.abort(reason);
    const results = await batch;

    expect(started).toBe(1);
    expect(results).toEqual([
      { status: 'rejected', reason },
      { status: 'rejected', reason },
      { status: 'rejected', reason },
    ]);
  });

  it('isolates progress and deduplication callback failures', async () => {
    const client = createClient();
    const results = await client.batch(
      ['good', 'bad-key', 'also-good'],
      async (input) => input.length,
      {
        deduplicateBy: (input) => {
          if (input === 'bad-key') throw new Error('bad key');
          return input;
        },
        onProgress: () => {
          throw new Error('progress failed');
        },
      },
    );

    expect(results).toEqual([
      { status: 'fulfilled', value: 4 },
      { status: 'rejected', reason: expect.objectContaining({ message: 'bad key' }) },
      { status: 'fulfilled', value: 9 },
    ]);
  });

  it('validates concurrency and handles empty input', async () => {
    const client = createClient();

    await expect(client.batch([], async () => 'unused')).resolves.toEqual([]);
    await expect(client.batch([1], async () => 1, { concurrency: 0 })).rejects.toThrow(RangeError);
  });
});
