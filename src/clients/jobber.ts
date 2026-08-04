/**
 * Jobber GraphQL API Client
 */

import type { JobberConfig, Connection, PaginationVariables } from '../types/jobber.js';
import { accessTokenExpiry, refreshTokens } from '../auth/oauth.js';

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

    let response = await this.send(query, variables);

    // Belt and braces: a token can be revoked or expire early, and Jobber
    // answers with 401. Refresh once and replay the request.
    if (response.status === 401) {
      await this.refresh();
      response = await this.send(query, variables);
    }

    if (!response.ok) {
      throw new Error(`Jobber API error: ${response.status} ${response.statusText}`);
    }

    const result: any = await response.json();

    if (result.errors) {
      throw new Error(
        `GraphQL errors: ${result.errors.map((e: any) => e.message).join(', ')}`
      );
    }

    return result.data;
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

    const tokens = await refreshTokens({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.refreshToken,
      oauthUrl: this.config.oauthUrl,
    });

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
