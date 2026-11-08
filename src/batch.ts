export interface BatchWorkerContext {
  /** Index of the first input represented by this worker execution. */
  readonly index: number;
  /** Shared batch cancellation signal. Pass it to Google Trends request options. */
  readonly signal: AbortSignal;
}

export type BatchWorker<TInput, TOutput> = (
  input: TInput,
  context: Readonly<BatchWorkerContext>,
) => TOutput | Promise<TOutput>;

export type BatchDeduplicationKey = string | number;

export interface BatchProgress {
  readonly index: number;
  readonly status: 'fulfilled' | 'rejected';
  readonly completed: number;
  readonly total: number;
  readonly deduplicated: boolean;
}

export interface BatchOptions<TInput> {
  /** Maximum active worker executions. Defaults to 1. */
  concurrency?: number;

  /** Signals active workers and prevents pending workers from starting. */
  signal?: AbortSignal;

  /** Inputs returning the same key share one worker execution. */
  deduplicateBy?: (input: TInput, index: number) => BatchDeduplicationKey;

  /** Synchronous progress listener. Listener failures are isolated from batch results. */
  onProgress?: (progress: Readonly<BatchProgress>) => void;
}

export interface BatchFulfilledResult<T> {
  readonly status: 'fulfilled';
  readonly value: T;
}

export interface BatchRejectedResult {
  readonly status: 'rejected';
  readonly reason: unknown;
}

export type BatchResult<T> = BatchFulfilledResult<T> | BatchRejectedResult;

interface BatchJob<TInput> {
  readonly input: TInput;
  readonly primaryIndex: number;
  readonly indices: number[];
}

function resolveConcurrency(value: number | undefined): number {
  const concurrency = value ?? 1;

  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new RangeError('batch concurrency must be a positive integer.');
  }

  return concurrency;
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The batch was aborted.', 'AbortError');
}

function notifyProgress(
  listener: BatchOptions<unknown>['onProgress'],
  progress: BatchProgress,
): void {
  if (listener === undefined) {
    return;
  }

  try {
    listener(Object.freeze(progress));
  } catch {
    // Progress reporting must not change request outcomes.
  }
}

export async function executeBatch<TInput, TOutput>(
  inputs: readonly TInput[],
  worker: BatchWorker<TInput, TOutput>,
  options: BatchOptions<TInput> = {},
): Promise<readonly BatchResult<TOutput>[]> {
  if (typeof worker !== 'function') {
    throw new TypeError('batch worker must be a function.');
  }

  const concurrency = resolveConcurrency(options.concurrency);
  const signal = options.signal ?? new AbortController().signal;
  const results = new Array<BatchResult<TOutput> | undefined>(inputs.length);
  const jobs: BatchJob<TInput>[] = [];
  const jobsByKey = new Map<BatchDeduplicationKey, BatchJob<TInput>>();
  let completed = 0;

  const settleIndex = (
    index: number,
    result: BatchResult<TOutput>,
    deduplicated: boolean,
  ): void => {
    results[index] = Object.freeze(result);
    completed += 1;
    notifyProgress(options.onProgress, {
      index,
      status: result.status,
      completed,
      total: inputs.length,
      deduplicated,
    });
  };

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index] as TInput;
    let key: BatchDeduplicationKey | undefined;

    if (options.deduplicateBy !== undefined) {
      try {
        key = options.deduplicateBy(input, index);
      } catch (error) {
        settleIndex(index, { status: 'rejected', reason: error }, false);
        continue;
      }
    }

    const existing = key === undefined ? undefined : jobsByKey.get(key);
    if (existing !== undefined) {
      existing.indices.push(index);
      continue;
    }

    const job: BatchJob<TInput> = {
      input,
      primaryIndex: index,
      indices: [index],
    };
    jobs.push(job);
    if (key !== undefined) {
      jobsByKey.set(key, job);
    }
  }

  let nextJob = 0;
  const runWorker = async (): Promise<void> => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob];
      nextJob += 1;

      if (job === undefined) {
        return;
      }

      let result: BatchResult<TOutput>;
      if (signal.aborted) {
        result = { status: 'rejected', reason: cancellationReason(signal) };
      } else {
        try {
          const value = await worker(job.input, Object.freeze({ index: job.primaryIndex, signal }));
          result = { status: 'fulfilled', value };
        } catch (error) {
          result = { status: 'rejected', reason: error };
        }
      }

      for (const index of job.indices) {
        settleIndex(index, result, index !== job.primaryIndex);
      }
    }
  };

  const workerCount = Math.min(concurrency, jobs.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return Object.freeze(
    results.map((result) => {
      if (result === undefined) {
        throw new Error('Internal batch result was not settled.');
      }
      return result;
    }),
  );
}
