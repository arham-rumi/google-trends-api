import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { RedisCacheStore, createRedisCacheStore, type RedisCommandExecutor } from '../src/index.js';

describe('RedisCacheStore', () => {
  it('stores opaque bytes as Base64 with a millisecond TTL', async () => {
    const commands: string[][] = [];
    let storedValue: string | undefined;
    const sendCommand: RedisCommandExecutor = (command) => {
      commands.push([...command]);

      if (command[0] === 'SET') {
        storedValue = command[2];
        return 'OK';
      }

      if (command[0] === 'GET') {
        return storedValue === undefined ? null : Buffer.from(storedValue);
      }

      return 1;
    };
    const store = createRedisCacheStore({ sendCommand });
    const bytes = Uint8Array.from([0, 255, 128, 64, 10]);

    await store.set('cache:key', bytes, 10.2);

    expect(commands[0]).toEqual(['SET', 'cache:key', 'AP+AQAo=', 'PX', '11']);
    await expect(store.get('cache:key')).resolves.toEqual(bytes);
    await store.delete('cache:key');
    expect(commands.at(-1)).toEqual(['UNLINK', 'cache:key']);
  });

  it('uses atomic owner-checked Redis lease commands', async () => {
    const commands: string[][] = [];
    const responses: unknown[] = ['OK', null, 1, '0', 1];
    const store = new RedisCacheStore({
      sendCommand: (command) => {
        commands.push([...command]);
        return responses.shift();
      },
    });

    await expect(store.acquireLock('lock:key', 'owner-a', 500)).resolves.toBe(true);
    await expect(store.acquireLock('lock:key', 'owner-b', 500)).resolves.toBe(false);
    await expect(store.refreshLock('lock:key', 'owner-a', 750)).resolves.toBe(true);
    await expect(store.refreshLock('lock:key', 'owner-b', 750)).resolves.toBe(false);
    await store.releaseLock('lock:key', 'owner-a');

    expect(commands[0]).toEqual(['SET', 'lock:key', 'owner-a', 'PX', '500', 'NX']);
    expect(commands[2]?.slice(0, 2)).toEqual(['EVAL', expect.stringContaining('PEXPIRE')]);
    expect(commands[2]?.slice(2)).toEqual(['1', 'lock:key', 'owner-a', '750']);
    expect(commands[4]?.slice(0, 2)).toEqual(['EVAL', expect.stringContaining("redis.call('DEL'")]);
    expect(commands[4]?.slice(2)).toEqual(['1', 'lock:key', 'owner-a']);
  });

  it('clears an escaped namespace with incremental, bounded SCAN batches', async () => {
    const commands: string[][] = [];
    let scanCalls = 0;
    const store = createRedisCacheStore({
      scanCount: 25,
      deleteBatchSize: 2,
      deleteCommand: 'DEL',
      sendCommand: (command) => {
        commands.push([...command]);

        if (command[0] !== 'SCAN') {
          return command.length - 1;
        }

        scanCalls += 1;
        return scanCalls === 1
          ? ['7', ['cache:*[x]:1', 'cache:*[x]:2', 'cache:*[x]:3']]
          : [Buffer.from('0'), [Buffer.from('cache:*[x]:4')]];
      },
    });

    await store.clear('cache:*[x]:');

    expect(commands).toEqual([
      ['SCAN', '0', 'MATCH', 'cache:\\*\\[x\\]:*', 'COUNT', '25'],
      ['DEL', 'cache:*[x]:1', 'cache:*[x]:2'],
      ['DEL', 'cache:*[x]:3'],
      ['SCAN', '7', 'MATCH', 'cache:\\*\\[x\\]:*', 'COUNT', '25'],
      ['DEL', 'cache:*[x]:4'],
    ]);
  });

  it('rejects dangerous or malformed configuration and Redis data', async () => {
    expect(() => createRedisCacheStore({ sendCommand: async () => null, scanCount: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      createRedisCacheStore({
        sendCommand: async () => null,
        deleteCommand: 'FLUSHDB' as 'DEL',
      }),
    ).toThrow(RangeError);

    const store = createRedisCacheStore({ sendCommand: async () => 'not base64!' });
    await expect(store.get('cache:key')).rejects.toThrow('invalid Base64');
    await expect(store.clear('')).rejects.toThrow('non-empty key prefix');
    await expect(store.set('cache:key', new Uint8Array(), 0)).rejects.toThrow('greater than zero');
  });
});
