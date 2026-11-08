import type { RequestBudgetReason } from './errors.js';
import type { ResultSource } from './result-metadata.js';

interface EventBase {
  readonly timestamp: number;
}

export type GoogleTrendsEvent =
  | (EventBase & {
      readonly type: 'operation-result';
      readonly operation: string;
      readonly source: ResultSource;
      readonly cachedAt?: number;
    })
  | (EventBase & {
      readonly type: 'inflight-joined';
      readonly operation: string;
    })
  | (EventBase & {
      readonly type: 'http-request-start';
      readonly endpoint: string;
      readonly pendingRequests: number;
      readonly intervalMs: number;
    })
  | (EventBase & {
      readonly type: 'http-request-complete';
      readonly endpoint: string;
      readonly outcome: 'success' | 'error' | 'rate-limit';
      readonly durationMs: number;
    })
  | (EventBase & {
      readonly type: 'pacing-changed';
      readonly previousIntervalMs: number;
      readonly intervalMs: number;
      readonly reason: 'rate-limit' | 'recovery' | 'shared-state';
    })
  | (EventBase & {
      readonly type: 'budget-rejected';
      readonly endpoint: string;
      readonly reason: RequestBudgetReason;
      readonly retryAfterMs?: number;
    })
  | (EventBase & {
      readonly type: 'circuit-opened' | 'circuit-closed';
      readonly endpoint: string;
      readonly openMs?: number;
    });

export type GoogleTrendsEventListener = (event: GoogleTrendsEvent) => void;

export interface ObservabilityOptions {
  /** Synchronous event listener. Listener errors are isolated from request behavior. */
  onEvent?: GoogleTrendsEventListener;
}

export interface GoogleTrendsMetrics {
  readonly networkResults: number;
  readonly cacheHits: number;
  readonly staleCacheHits: number;
  readonly inflightJoins: number;
  readonly httpRequestsStarted: number;
  readonly httpRequestsSucceeded: number;
  readonly httpRequestsFailed: number;
  readonly rateLimits: number;
  readonly budgetRejections: number;
  readonly circuitsOpened: number;
  readonly circuitsClosed: number;
  readonly pacingIncreases: number;
  readonly pacingRecoveries: number;
  readonly listenerErrors: number;
  readonly cacheSize: number;
  readonly pendingRequests: number;
  readonly requestIntervalMs: number;
  readonly cooldownRemainingMs: number;
  readonly circuitRemainingMs: number;
}

type GaugeKey =
  | 'cacheSize'
  | 'pendingRequests'
  | 'requestIntervalMs'
  | 'cooldownRemainingMs'
  | 'circuitRemainingMs';

type CounterMetrics = {
  -readonly [Key in keyof Omit<GoogleTrendsMetrics, GaugeKey>]: GoogleTrendsMetrics[Key];
};

function createCounters(): CounterMetrics {
  return {
    networkResults: 0,
    cacheHits: 0,
    staleCacheHits: 0,
    inflightJoins: 0,
    httpRequestsStarted: 0,
    httpRequestsSucceeded: 0,
    httpRequestsFailed: 0,
    rateLimits: 0,
    budgetRejections: 0,
    circuitsOpened: 0,
    circuitsClosed: 0,
    pacingIncreases: 0,
    pacingRecoveries: 0,
    listenerErrors: 0,
  };
}

export class MetricsCollector {
  readonly #listener: GoogleTrendsEventListener | undefined;
  #counters: CounterMetrics = createCounters();

  public constructor(listener?: GoogleTrendsEventListener) {
    this.#listener = listener;
  }

  public emit(event: GoogleTrendsEvent): void {
    this.#record(event);

    if (this.#listener === undefined) {
      return;
    }

    try {
      this.#listener(Object.freeze(event));
    } catch {
      this.#counters.listenerErrors += 1;
    }
  }

  public snapshot(gauges: {
    cacheSize: number;
    pendingRequests: number;
    requestIntervalMs: number;
    cooldownRemainingMs: number;
    circuitRemainingMs: number;
  }): Readonly<GoogleTrendsMetrics> {
    return Object.freeze({ ...this.#counters, ...gauges });
  }

  public reset(): void {
    this.#counters = createCounters();
  }

  #record(event: GoogleTrendsEvent): void {
    switch (event.type) {
      case 'operation-result':
        if (event.source === 'network') {
          this.#counters.networkResults += 1;
        } else if (event.source === 'cache') {
          this.#counters.cacheHits += 1;
        } else {
          this.#counters.staleCacheHits += 1;
        }
        break;
      case 'inflight-joined':
        this.#counters.inflightJoins += 1;
        break;
      case 'http-request-start':
        this.#counters.httpRequestsStarted += 1;
        break;
      case 'http-request-complete':
        if (event.outcome === 'success') {
          this.#counters.httpRequestsSucceeded += 1;
        } else {
          this.#counters.httpRequestsFailed += 1;
          if (event.outcome === 'rate-limit') {
            this.#counters.rateLimits += 1;
          }
        }
        break;
      case 'budget-rejected':
        this.#counters.budgetRejections += 1;
        break;
      case 'circuit-opened':
        this.#counters.circuitsOpened += 1;
        break;
      case 'circuit-closed':
        this.#counters.circuitsClosed += 1;
        break;
      case 'pacing-changed':
        if (event.intervalMs > event.previousIntervalMs) {
          this.#counters.pacingIncreases += 1;
        } else if (event.intervalMs < event.previousIntervalMs) {
          this.#counters.pacingRecoveries += 1;
        }
        break;
    }
  }
}
