import { randomUUID } from 'node:crypto';

import { createClient as createRedisClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createClient,
  createRedisCacheStore,
  type FetchLike,
  type RedisCommandExecutor,
} from '../../src/index.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const ROOT_PREFIX = `google-trends-api:integration:${randomUUID()}:`;

const redisA = createRedisClient({ url: REDIS_URL });
const redisB = createRedisClient({ url: REDIS_URL });
const connectionErrors: Error[] = [];

redisA.on('error', (error) => connectionErrors.push(error));
redisB.on('error', (error) => connectionErrors.push(error));

function executor(client: typeof redisA): RedisCommandExecutor {
  return (command) => client.sendCommand([...command]);
}

const storeA = createRedisCacheStore({ sendCommand: executor(redisA) });
const storeB = createRedisCacheStore({ sendCommand: executor(redisB) });

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
            mid: '/m/integration',
            title: 'Integration topic',
            type: 'Topic',
          },
        ],
      },
    })}`,
    url,
  );
}

beforeAll(async () => {
  await Promise.all([redisA.connect(), redisB.connect()]);
  await redisA.ping();
});

afterAll(async () => {
  if (redisA.isReady) {
    await storeA.clear(ROOT_PREFIX);
  }

  await Promise.allSettled([
    redisA.isOpen ? redisA.quit() : Promise.resolve(),
    redisB.isOpen ? redisB.quit() : Promise.resolve(),
  ]);
});

describe('RedisCacheStore with Redis', () => {
  it('preserves binary payloads and expires them with the supplied TTL', async () => {
    const key = `${ROOT_PREFIX}ttl`;
    const value = Uint8Array.from([0, 255, 128, 64, 10]);

    await storeA.set(key, value, 100);
    await expect(storeB.get(key)).resolves.toEqual(value);
    await expect.poll(() => storeB.get(key), { timeout: 2_000, interval: 20 }).toBeUndefined();
  });

  it('keeps lease acquisition, refresh, and release atomic across clients', async () => {
    const key = `${ROOT_PREFIX}lease`;
    const [acquiredA, acquiredB] = await Promise.all([
      storeA.acquireLock(key, 'owner-a', 2_000),
      storeB.acquireLock(key, 'owner-b', 2_000),
    ]);

    expect([acquiredA, acquiredB].filter(Boolean)).toHaveLength(1);

    const winnerStore = acquiredA ? storeA : storeB;
    const loserStore = acquiredA ? storeB : storeA;
    const winner = acquiredA ? 'owner-a' : 'owner-b';
    const loser = acquiredA ? 'owner-b' : 'owner-a';

    await loserStore.releaseLock(key, loser);
    await expect(winnerStore.refreshLock(key, winner, 2_000)).resolves.toBe(true);
    await expect(loserStore.acquireLock(key, loser, 2_000)).resolves.toBe(false);

    await winnerStore.releaseLock(key, winner);
    await expect(loserStore.acquireLock(key, loser, 2_000)).resolves.toBe(true);
    await loserStore.releaseLock(key, loser);
  });

  it('clears only the requested namespace, including escaped glob characters', async () => {
    const prefix = `${ROOT_PREFIX}cache:*[x]:`;
    const unrelatedKey = `${ROOT_PREFIX}unrelated`;
    await Promise.all([
      storeA.set(`${prefix}one`, Uint8Array.of(1), 10_000),
      storeA.set(`${prefix}two`, Uint8Array.of(2), 10_000),
      storeA.set(unrelatedKey, Uint8Array.of(3), 10_000),
    ]);

    await storeB.clear(prefix);

    await expect(storeA.get(`${prefix}one`)).resolves.toBeUndefined();
    await expect(storeA.get(`${prefix}two`)).resolves.toBeUndefined();
    await expect(storeA.get(unrelatedKey)).resolves.toEqual(Uint8Array.of(3));
  });

  it('coalesces an identical cache miss across clients through Redis', async () => {
    const keyPrefix = `${ROOT_PREFIX}clients:`;
    let requestCount = 0;
    let notifyStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const fetch: FetchLike = async (input) => {
      requestCount += 1;
      notifyStarted?.();
      await requestGate;
      const url = input instanceof Request ? input.url : input.toString();
      return autocompleteResponse(url);
    };
    const options = {
      retries: 0,
      rateLimit: { minIntervalMs: 0 },
      cache: {
        keyPrefix,
        coordination: { lockTtlMs: 2_000, pollIntervalMs: 10 },
      },
      fetch,
    } as const;
    const clientA = createClient({ ...options, cache: { ...options.cache, store: storeA } });
    const clientB = createClient({ ...options, cache: { ...options.cache, store: storeB } });

    const first = clientA.autocomplete({ keyword: 'TypeScript' });
    await requestStarted;
    const second = clientB.autocomplete({ keyword: 'TypeScript' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRequest?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(requestCount).toBe(1);
    expect(secondResult).toEqual(firstResult);
    expect(connectionErrors).toEqual([]);
  });
});
