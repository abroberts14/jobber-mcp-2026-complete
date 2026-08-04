/**
 * Per-request channel for reporting throttle waits back to the MCP caller.
 *
 * One JobberClient is shared by every connection, so a throttle event has no
 * inherent owner — it happens inside whichever request was unlucky. An
 * AsyncLocalStorage lets the client report "I am waiting" without importing
 * anything about MCP, and lets the server attribute that wait to the specific
 * tool call it happened under.
 *
 * Both sides are optional: outside a request (scripts, tests) there is no
 * store and reporting is a no-op.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ThrottleWait {
  /** How long we are about to sleep, in milliseconds. */
  waitMs: number;
  /** 1-based retry attempt this wait precedes. */
  attempt: number;
  /** Attempts that will be made in total before giving up. */
  maxAttempts: number;
  /** Why we are waiting: Jobber said no, or we paced ourselves. */
  reason: 'throttled' | 'preemptive';
  /** Jobber's own budget snapshot, when it gave us one. */
  throttleStatus?: ThrottleStatus;
}

/** The leaky-bucket state Jobber reports in `extensions.cost.throttleStatus`. */
export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

/** What one GraphQL request cost, and the budget left after it. */
export interface QueryCost {
  /** What Jobber charged up front, based on the shape of the query. */
  requestedQueryCost: number;
  /** What the query turned out to cost once resolved. */
  actualQueryCost: number;
  throttleStatus?: ThrottleStatus;
}

export interface ThrottleReporter {
  onWait(wait: ThrottleWait): void;
  /** Called once per GraphQL request. A tool may issue several. */
  onCost?(cost: QueryCost): void;
}

const storage = new AsyncLocalStorage<ThrottleReporter>();

/** Run `fn` with throttle waits reported to `reporter`. */
export function withThrottleReporter<T>(reporter: ThrottleReporter, fn: () => Promise<T>): Promise<T> {
  return storage.run(reporter, fn);
}

/** Report a wait to the enclosing request, if there is one. */
export function reportThrottleWait(wait: ThrottleWait): void {
  try {
    storage.getStore()?.onWait(wait);
  } catch {
    // Never let telemetry break the actual request.
  }
}

/** Report one request's cost to the enclosing tool call, if there is one. */
export function reportQueryCost(cost: QueryCost): void {
  try {
    storage.getStore()?.onCost?.(cost);
  } catch {
    // Never let telemetry break the actual request.
  }
}
