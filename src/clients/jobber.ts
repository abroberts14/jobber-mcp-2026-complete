/**
 * Jobber GraphQL API Client
 */

import type { JobberConfig, Connection, PaginationVariables } from '../types/jobber.js';
import { accessTokenExpiry, refreshTokens } from '../auth/oauth.js';
import { reportThrottleWait, reportQueryCost, type ThrottleStatus } from '../throttle-context.js';

/** Total attempts (including the first) before surfacing a rate-limit error. */
const MAX_THROTTLE_ATTEMPTS = 5;
/** Never sleep longer than this in one go — a caller is waiting on us. */
const MAX_THROTTLE_WAIT_MS = 20_000;
/** Assumed cost before Jobber has told us what a request actually costs. */
const DEFAULT_QUERY_COST = 50;

/**
 * Jobber signals throttling as HTTP 200 with an error message, not a 429, so
 * this has to match on the body.
 */
function isThrottleError(errors: any[]): boolean {
  return errors.some((e) => /throttl|rate limit/i.test(String(e?.message ?? '')));
}

// Jobber does NOT reject an unknown version — it silently falls back to a
// long-deprecated one (2022-09-01) and only reports that in
// `extensions.versioning`. So a typo here degrades quietly rather than failing
// loudly. 2025-01-20 was a real version but already past end-of-support.
// `npm run schema:fetch` asserts the served version matches this one.
const DEFAULT_GRAPHQL_VERSION = '2026-07-27';

export class JobberClient {
  private apiUrl: string;
  private graphqlVersion: string;
  private config: JobberConfig;

  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;

  /** In-flight refresh, so concurrent tool calls share one token request. */
  private refreshInFlight: Promise<void> | null = null;

  constructor(config: JobberConfig) {
    this.apiUrl = config.apiUrl || 'https://api.getjobber.com/api/graphql';
    this.graphqlVersion = config.graphqlVersion || DEFAULT_GRAPHQL_VERSION;
    this.config = config;

    this.accessToken = config.accessToken || '';
    this.refreshToken = config.refreshToken;
    // Expiry 0 means the first request refreshes before sending — the right
    // default both when we have no access token and when we can't read its exp.
    this.expiresAt = config.accessToken ? accessTokenExpiry(config.accessToken) ?? 0 : 0;
  }

  /** Expose the current tokens so callers can persist them. */
  getTokens() {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
    };
  }

  /** Seed the client with previously persisted tokens. */
  setTokens(tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.expiresAt = tokens.expiresAt;
  }

  /**
   * Execute a GraphQL query
   */
  async query<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
    if (Date.now() >= this.expiresAt) {
      await this.refresh();
    }

    for (let attempt = 1; ; attempt++) {
      // Pace ourselves before spending: one shared client means a burst of tool
      // calls from several users draws on the same bucket.
      await this.awaitBudget(attempt);

      let response = await this.send(query, variables);

      // Belt and braces: a token can be revoked or expire early, and Jobber
      // answers with 401. Refresh once and replay the request.
      if (response.status === 401) {
        await this.refresh();
        response = await this.send(query, variables);
      }

      // A 429 has no JSON body worth parsing; retry on the header's schedule.
      if (response.status === 429) {
        if (attempt >= MAX_THROTTLE_ATTEMPTS) {
          throw new Error(this.throttleMessage(attempt));
        }
        const retryAfter = Number(response.headers.get('retry-after'));
        await this.sleepForThrottle(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt),
          attempt,
          'throttled'
        );
        continue;
      }

      if (!response.ok) {
        throw new Error(`Jobber API error: ${response.status} ${response.statusText}`);
      }

      const result: any = await response.json();

      // Jobber reports the leaky-bucket state on every response. Recording it
      // is what makes the pacing above possible.
      this.recordThrottleStatus(result);

      if (result.errors) {
        // Throttling arrives as HTTP 200 with an error message, NOT as a 429,
        // so this has to be detected on the body rather than the status.
        if (isThrottleError(result.errors) && attempt < MAX_THROTTLE_ATTEMPTS) {
          await this.sleepForThrottle(this.throttleWaitMs(result, attempt), attempt, 'throttled');
          continue;
        }
        if (isThrottleError(result.errors)) {
          throw new Error(this.throttleMessage(attempt));
        }
        throw new Error(
          `GraphQL errors: ${result.errors.map((e: any) => e.message).join(', ')}`
        );
      }

      return result.data;
    }
  }

  /** Last budget snapshot Jobber gave us, and when. */
  private throttle: ThrottleStatus | null = null;
  private throttleSeenAt = 0;
  /** Cost of the most recent request, used to size the next wait. */
  private lastRequestedCost = DEFAULT_QUERY_COST;

  /** Expose the latest known budget (for diagnostics and result metadata). */
  getThrottleStatus(): (ThrottleStatus & { projectedAvailable: number }) | null {
    if (!this.throttle) return null;
    return { ...this.throttle, projectedAvailable: this.projectedAvailable() };
  }

  private recordThrottleStatus(result: any): void {
    const cost = result?.extensions?.cost;
    if (!cost) return;
    if (typeof cost.requestedQueryCost === 'number') {
      this.lastRequestedCost = cost.requestedQueryCost;
    }
    const status = cost.throttleStatus;
    if (status && typeof status.currentlyAvailable === 'number') {
      this.throttle = status;
      this.throttleSeenAt = Date.now();
    }
    // Attribute the spend to whichever tool call is in flight. Reported per
    // request because one tool may issue several queries.
    reportQueryCost({
      requestedQueryCost: cost.requestedQueryCost ?? 0,
      actualQueryCost: cost.actualQueryCost ?? 0,
      throttleStatus: status,
    });
  }

  /**
   * Model the bucket locally: it refills at `restoreRate` points per second, so
   * availability now is the last reading plus whatever has restored since.
   */
  private projectedAvailable(): number {
    if (!this.throttle) return Infinity;
    const { currentlyAvailable, restoreRate, maximumAvailable } = this.throttle;
    const restored = ((Date.now() - this.throttleSeenAt) / 1000) * restoreRate;
    return Math.min(maximumAvailable, currentlyAvailable + restored);
  }

  /** Wait until the bucket can plausibly cover another request like the last one. */
  private async awaitBudget(attempt: number): Promise<void> {
    if (!this.throttle) return;
    const needed = this.lastRequestedCost;
    const available = this.projectedAvailable();
    if (available >= needed) return;

    const waitMs = Math.min(
      MAX_THROTTLE_WAIT_MS,
      Math.ceil(((needed - available) / this.throttle.restoreRate) * 1000)
    );
    if (waitMs <= 0) return;
    await this.sleepForThrottle(waitMs, attempt, 'preemptive');
  }

  /**
   * How long until enough points restore to cover this request. Jobber usually
   * includes the budget even on a throttled response, which beats guessing.
   */
  private throttleWaitMs(result: any, attempt: number): number {
    const status = result?.extensions?.cost?.throttleStatus ?? this.throttle;
    const needed = result?.extensions?.cost?.requestedQueryCost ?? this.lastRequestedCost;
    if (status?.restoreRate > 0) {
      const deficit = needed - status.currentlyAvailable;
      if (deficit > 0) {
        return Math.min(MAX_THROTTLE_WAIT_MS, Math.ceil((deficit / status.restoreRate) * 1000));
      }
    }
    return this.backoff(attempt);
  }

  /** Exponential backoff with jitter, for when Jobber tells us nothing useful. */
  private backoff(attempt: number): number {
    const base = Math.min(MAX_THROTTLE_WAIT_MS, 500 * 2 ** (attempt - 1));
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  private async sleepForThrottle(
    waitMs: number,
    attempt: number,
    reason: 'throttled' | 'preemptive'
  ): Promise<void> {
    reportThrottleWait({
      waitMs,
      attempt,
      maxAttempts: MAX_THROTTLE_ATTEMPTS,
      reason,
      throttleStatus: this.throttle ?? undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private throttleMessage(attempts: number): string {
    const s = this.throttle;
    const budget = s
      ? ` Budget ${Math.round(this.projectedAvailable())}/${s.maximumAvailable}, restoring ${s.restoreRate}/s.`
      : '';
    return (
      `Jobber rate limit exceeded after ${attempts} attempts.${budget} ` +
      `Retry with a smaller limit, fewer nested fields, or less concurrency.`
    );
  }

  private send(query: string, variables?: Record<string, any>): Promise<Response> {
    return fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        'X-JOBBER-GRAPHQL-VERSION': this.graphqlVersion,
      },
      body: JSON.stringify({ query, variables }),
    });
  }

  /**
   * Swap the refresh token for a fresh access token. Jobber rotates the
   * refresh token on each call, so the new one must be persisted immediately.
   */
  private async refresh(): Promise<void> {
    // Collapse concurrent refreshes — a rotated refresh token is single-use,
    // so two parallel refreshes would invalidate each other.
    if (this.refreshInFlight) return this.refreshInFlight;

    const run = () => this.refreshLocked();
    const withLock = this.config.withLock;

    this.refreshInFlight = (withLock ? withLock(run) : run()).finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  /** Runs with the cross-process lock held, when one is configured. */
  private async refreshLocked(): Promise<void> {
    // Another process may have refreshed while we queued on the lock. Adopting
    // its tokens avoids spending a refresh token that is already dead.
    const persisted = await this.config.loadTokens?.();
    if (persisted?.refreshToken) {
      this.refreshToken = persisted.refreshToken;

      if (persisted.accessToken && Date.now() < persisted.expiresAt) {
        this.accessToken = persisted.accessToken;
        this.expiresAt = persisted.expiresAt;
        return;
      }
    }

    let tokens;
    try {
      tokens = await refreshTokens({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken: this.refreshToken,
        oauthUrl: this.config.oauthUrl,
      });
    } catch (error) {
      // The persisted token can go stale — most importantly right after an
      // operator fixes JOBBER_REFRESH_TOKEN, since the store is preferred over
      // the environment and would otherwise keep re-adopting the dead token
      // until someone deletes the file by hand. Fall back to the bootstrap
      // value once when it is actually a different token.
      const bootstrap = this.config.refreshToken;
      const isDeadToken = /not valid|invalid_grant/i.test(String((error as Error)?.message ?? ''));

      if (!isDeadToken || !bootstrap || bootstrap === this.refreshToken) {
        throw error;
      }

      console.error(
        '[jobber-auth] stored refresh token was rejected; retrying with the ' +
          'JOBBER_REFRESH_TOKEN from the environment.'
      );
      tokens = await refreshTokens({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken: bootstrap,
        oauthUrl: this.config.oauthUrl,
      });
    }

    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.expiresAt = tokens.expiresAt;

    await this.config.onTokensRefreshed?.(tokens);
  }

  /**
   * Execute a GraphQL mutation
   */
  async mutate<T = any>(mutation: string, variables?: Record<string, any>): Promise<T> {
    return this.query<T>(mutation, variables);
  }

  /**
   * Paginate through a connection
   */
  async *paginate<T>(
    queryTemplate: (vars: PaginationVariables) => string,
    extractConnection: (data: any) => Connection<T>,
    pageSize = 50
  ): AsyncGenerator<T> {
    let hasNextPage = true;
    let after: string | undefined;

    while (hasNextPage) {
      const variables: PaginationVariables = { first: pageSize, after };
      const data = await this.query(queryTemplate(variables), variables);
      const connection = extractConnection(data);

      for (const edge of connection.edges) {
        yield edge.node;
      }

      hasNextPage = connection.pageInfo.hasNextPage;
      after = connection.pageInfo.endCursor;
    }
  }

  /**
   * Build GraphQL query with fragments
   */
  static buildQuery(
    operationName: string,
    selections: string,
    variables?: string
  ): string {
    const varsDeclaration = variables ? `(${variables})` : '';
    return `query ${operationName}${varsDeclaration} { ${selections} }`;
  }

  /**
   * Build GraphQL mutation
   */
  static buildMutation(
    operationName: string,
    selections: string,
    variables?: string
  ): string {
    const varsDeclaration = variables ? `(${variables})` : '';
    return `mutation ${operationName}${varsDeclaration} { ${selections} }`;
  }

  /**
   * Standard client fields fragment
   */
  static get clientFields(): string {
    return `
      id
      name
      firstName
      lastName
      companyName
      email
      phone
      isArchived
      isCompany
      isLead
      balance
      createdAt
      updatedAt
      billingAddress {
        street1
        street2
        city
        province
        postalCode
        country
      }
    `;
  }

  /**
   * Standard job fields fragment
   */
  static get jobFields(): string {
    return `
      id
      jobNumber
      title
      instructions
      jobStatus
      jobType
      billingType
      createdAt
      updatedAt
      startAt
      endAt
      completedAt
      total
      invoicedTotal
      uninvoicedTotal
      client {
        ${this.clientFields}
      }
    `;
  }

  /**
   * Standard quote fields fragment
   */
  static get quoteFields(): string {
    return `
      id
      quoteNumber
      title
      message
      quoteStatus
      createdAt
      updatedAt
      sentAt
      transitionedAt
      clientHubViewedAt
      depositCollected
      client {
        ${this.clientFields}
      }
      amounts {
        subtotal
        discountAmount
        nonTaxAmount
        taxAmount
        depositAmount
        total
      }
    `;
  }

  /**
   * Standard invoice fields fragment
   */
  static get invoiceFields(): string {
    return `
      id
      invoiceNumber
      subject
      message
      invoiceStatus
      createdAt
      updatedAt
      issuedDate
      dueDate
      receivedDate
      client {
        ${this.clientFields}
      }
      amounts {
        subtotal
        discountAmount
        nonTaxAmount
        taxAmount
        depositAmount
        paymentsTotal
        invoiceBalance
        total
      }
    `;
  }

  /**
   * Standard visit fields fragment
   */
  static get visitFields(): string {
    return `
      id
      title
      instructions
      startAt
      endAt
      duration
      allDay
      visitStatus
      isComplete
      completedAt
      createdAt
    `;
  }

  /**
   * Standard line item fields fragment.
   *
   * There is no `LineItem` type — Jobber models them per parent as
   * JobLineItem / QuoteLineItem / InvoiceLineItem. These are the fields common
   * to all three, so one fragment stays valid on any of them. Anything
   * parent-specific (markup, optional, sortOrder on quotes; taxRate, date on
   * invoices) has to be selected at the call site.
   */
  static get lineItemFields(): string {
    return `
      id
      name
      description
      quantity
      qty
      unitPrice
      totalPrice
      cost
      taxable
      createdAt
      updatedAt
    `;
  }

  /**
   * Standard user fields fragment
   */
  static get userFields(): string {
    return `
      id
      uuid
      name {
        first
        last
        full
      }
      email {
        raw
        isValid
      }
      phone {
        raw
        friendly
      }
      status
      isAccountAdmin
      isAccountOwner
      availableForScheduling
      lastLoginAt
      createdAt
    `;
  }
}
