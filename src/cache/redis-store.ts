import { Buffer } from 'node:buffer';

import type { CoordinatedCacheStore } from './types.js';

const REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`.trim();

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`.trim();

export type RedisCommandExecutor = (command: readonly string[]) => unknown | Promise<unknown>;

export type RedisDeleteCommand = 'DEL' | 'UNLINK';

export interface RedisCacheStoreOptions {
  /** Executes one raw Redis command and returns its native response. */
  sendCommand: RedisCommandExecutor;

  /** Approximate number of keys requested by each SCAN call. Defaults to 100. */
  scanCount?: number;

  /** Maximum keys removed by each deletion command. Defaults to 100. */
  deleteBatchSize?: number;

  /** Redis command used by clear(). Defaults to non-blocking UNLINK. */
  deleteCommand?: RedisDeleteCommand;
}

interface ResolvedRedisCacheStoreOptions {
  sendCommand: RedisCommandExecutor;
  scanCount: number;
  deleteBatchSize: number;
  deleteCommand: RedisDeleteCommand;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;

  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }

  return resolved;
}

function ttlArgument(ttlMs: number): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError('Redis TTL must be greater than zero.');
  }

  return String(Math.max(1, Math.ceil(ttlMs)));
}

function responseText(value: unknown, context: string): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }

  throw new TypeError(`Redis returned an invalid ${context} response.`);
}

function integerResponse(value: unknown, context: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }

  const text = responseText(value, context);
  if (!/^-?\d+$/.test(text)) {
    throw new TypeError(`Redis returned an invalid ${context} response.`);
  }

  return Number(text);
}

function decodePayload(value: unknown): Uint8Array | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const encoded = responseText(value, 'GET');
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new TypeError('Redis returned an invalid Base64 cache payload.');
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new TypeError('Redis returned a non-canonical Base64 cache payload.');
  }

  return new Uint8Array(decoded);
}

function escapeRedisGlob(value: string): string {
  let escaped = '';

  for (const character of value) {
    if (
      character === '\\' ||
      character === '*' ||
      character === '?' ||
      character === '[' ||
      character === ']'
    ) {
      escaped += '\\';
    }
    escaped += character;
  }

  return escaped;
}

function scanResponse(value: unknown): readonly [string, string[]] {
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) {
    throw new TypeError('Redis returned an invalid SCAN response.');
  }

  const cursor =
    typeof value[0] === 'number' ? String(value[0]) : responseText(value[0], 'SCAN cursor');
  if (!/^\d+$/.test(cursor)) {
    throw new TypeError('Redis returned an invalid SCAN cursor.');
  }

  const keys = value[1].map((key) => responseText(key, 'SCAN key'));
  return [cursor, keys];
}

/**
 * Redis-backed persistent cache with atomic, owner-checked coordination leases.
 *
 * The command executor keeps this adapter compatible with node-redis, ioredis, and hosted Redis
 * clients without making any of them a runtime dependency.
 */
export class RedisCacheStore implements CoordinatedCacheStore {
  readonly #options: Readonly<ResolvedRedisCacheStoreOptions>;

  public constructor(options: RedisCacheStoreOptions) {
    if (typeof options?.sendCommand !== 'function') {
      throw new TypeError('RedisCacheStore requires a sendCommand function.');
    }

    const deleteCommand = options.deleteCommand ?? 'UNLINK';
    if (deleteCommand !== 'DEL' && deleteCommand !== 'UNLINK') {
      throw new RangeError('deleteCommand must be either "DEL" or "UNLINK".');
    }

    this.#options = Object.freeze({
      sendCommand: options.sendCommand,
      scanCount: positiveInteger(options.scanCount, 100, 'scanCount'),
      deleteBatchSize: positiveInteger(options.deleteBatchSize, 100, 'deleteBatchSize'),
      deleteCommand,
    });
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    return decodePayload(await this.#execute(['GET', key]));
  }

  public async set(key: string, value: Uint8Array, ttlMs: number): Promise<void> {
    const response = await this.#execute([
      'SET',
      key,
      Buffer.from(value).toString('base64'),
      'PX',
      ttlArgument(ttlMs),
    ]);

    if (responseText(response, 'SET').toUpperCase() !== 'OK') {
      throw new TypeError('Redis did not acknowledge the cache write.');
    }
  }

  public async delete(key: string): Promise<void> {
    await this.#execute([this.#options.deleteCommand, key]);
  }

  public async clear(keyPrefix: string): Promise<void> {
    if (keyPrefix.length === 0) {
      throw new RangeError('Redis cache clear requires a non-empty key prefix.');
    }

    const pattern = `${escapeRedisGlob(keyPrefix)}*`;
    let cursor = '0';

    do {
      const response = await this.#execute([
        'SCAN',
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        String(this.#options.scanCount),
      ]);
      const [nextCursor, keys] = scanResponse(response);

      for (let offset = 0; offset < keys.length; offset += this.#options.deleteBatchSize) {
        await this.#execute([
          this.#options.deleteCommand,
          ...keys.slice(offset, offset + this.#options.deleteBatchSize),
        ]);
      }

      cursor = nextCursor;
    } while (cursor !== '0');
  }

  public async acquireLock(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const response = await this.#execute(['SET', key, owner, 'PX', ttlArgument(ttlMs), 'NX']);

    if (response === null || response === undefined) {
      return false;
    }

    if (responseText(response, 'lock SET').toUpperCase() === 'OK') {
      return true;
    }

    throw new TypeError('Redis returned an invalid lock SET response.');
  }

  public async refreshLock(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const response = await this.#execute([
      'EVAL',
      REFRESH_LOCK_SCRIPT,
      '1',
      key,
      owner,
      ttlArgument(ttlMs),
    ]);
    return integerResponse(response, 'lock refresh') === 1;
  }

  public async releaseLock(key: string, owner: string): Promise<void> {
    await this.#execute(['EVAL', RELEASE_LOCK_SCRIPT, '1', key, owner]);
  }

  async #execute(command: readonly string[]): Promise<unknown> {
    return this.#options.sendCommand(command);
  }
}

export function createRedisCacheStore(options: RedisCacheStoreOptions): RedisCacheStore {
  return new RedisCacheStore(options);
}
