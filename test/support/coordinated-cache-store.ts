import type { CoordinatedCacheStore } from '../../src/cache/types.js';

interface StoredEntry {
  value: Uint8Array;
  expiresAt: number;
}

interface StoredLock {
  owner: string;
  expiresAt: number;
}

export class TestCoordinatedCacheStore implements CoordinatedCacheStore {
  public readonly entries = new Map<string, StoredEntry>();
  public readonly locks = new Map<string, StoredLock>();

  public get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value.slice();
  }

  public set(key: string, value: Uint8Array, ttlMs: number): void {
    this.entries.set(key, {
      value: value.slice(),
      expiresAt: Date.now() + ttlMs,
    });
  }

  public delete(key: string): void {
    this.entries.delete(key);
  }

  public clear(keyPrefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.entries.delete(key);
      }
    }
  }

  public acquireLock(key: string, owner: string, ttlMs: number): boolean {
    const current = this.locks.get(key);

    if (current !== undefined && current.expiresAt > Date.now()) {
      return false;
    }

    this.locks.set(key, {
      owner,
      expiresAt: Date.now() + ttlMs,
    });
    return true;
  }

  public refreshLock(key: string, owner: string, ttlMs: number): boolean {
    const current = this.locks.get(key);

    if (current === undefined || current.owner !== owner || current.expiresAt <= Date.now()) {
      return false;
    }

    current.expiresAt = Date.now() + ttlMs;
    return true;
  }

  public releaseLock(key: string, owner: string): void {
    if (this.locks.get(key)?.owner === owner) {
      this.locks.delete(key);
    }
  }
}
