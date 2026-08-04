export type ResultSource = 'network' | 'cache' | 'stale-cache';

export interface ResultMetadata {
  source: ResultSource;
  stale: boolean;
  cachedAt?: Date;
}

const resultMetadata = new WeakMap<object, ResultMetadata>();

export function attachResultMetadata<T extends object>(result: T, metadata: ResultMetadata): T {
  resultMetadata.set(result, metadata);
  return result;
}

/** Returns cache/network metadata for a result returned by this client. */
export function getResultMetadata(result: object): ResultMetadata | undefined {
  const metadata = resultMetadata.get(result);

  if (metadata === undefined) {
    return undefined;
  }

  return {
    ...metadata,
    ...(metadata.cachedAt === undefined ? {} : { cachedAt: new Date(metadata.cachedAt) }),
  };
}
