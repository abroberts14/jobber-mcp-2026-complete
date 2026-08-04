/**
 * Quotes Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - Quote status enum values are lowercase (QuoteStatusTypeEnum: `draft`,
 *     `awaiting_response`, `approved`, `changes_requested`, `converted`,
 *     `archived`) — there is no `SENT` or `EXPIRED` status.
 *   - Mutations use `Edit`, not `Update` (`quoteEdit`), and `quoteCreate`
 *     takes `attributes: QuoteCreateAttributes!`, not `input:`.
 *   - There is no `quoteSend` or `quoteApprove` mutation. Sending a quote and
 *     a client approving it are client-hub-driven actions the public API does
 *     not expose a mutation for (QuoteEditAttributes.sentAt only records a
 *     timestamp — it does not trigger an email or change quoteStatus).
 *   - There is no `quoteConvertToJob` mutation either. The real equivalent is
 *     `jobCreate(input: { quoteId, ... })` — Jobber links the new job back to
 *     the quote via `quoteId`, which is how a quote becomes a job.
 *   - `quote.lineItems` is a Connection — select `nodes { ... }`, not fields
 *     directly.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

/** QuoteStatusTypeEnum, verbatim. */
const QUOTE_STATUS = [
  'draft', 'awaiting_response', 'approved', 'changes_requested', 'converted', 'archived',
] as const;

/** BillingStrategy, verbatim — used only by convert_quote_to_job's jobCreate call. */
const INVOICING_TYPE = ['FIXED_PRICE', 'VISIT_BASED'] as const;

/** BillingFrequencyEnum, verbatim — used only by convert_quote_to_job's jobCreate call. */
const INVOICING_SCHEDULE = ['ON_COMPLETION', 'PERIODIC', 'PER_VISIT', 'NEVER'] as const;

const PAGE_INFO = `
  pageInfo {
    hasNextPage
    endCursor
  }
  totalCount
`;

const USER_ERRORS = `
  userErrors {
    message
    path
  }
`;

export const quotesTools = {
  list_quotes: {
    description: 'List quotes with optional filtering by status or client',
    inputSchema: z.object({
      status: z.enum(QUOTE_STATUS).optional(),
      clientId: z.string().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.clientId) filter.clientId = args.clientId;

      const query = `
        query ListQuotes($first: Int, $after: String, $filter: QuoteFilterAttributes) {
          quotes(first: $first, after: $after, filter: $filter) {
            nodes {
              ${JobberClient.quoteFields}
            }
            ${PAGE_INFO}
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        after: args.cursor,
        filter,
      });
      return {
        quotes: data.quotes.nodes,
        pageInfo: data.quotes.pageInfo,
        totalCount: data.quotes.totalCount,
      };
    },
  },

  get_quote: {
    description: 'Get a specific quote by ID',
    inputSchema: z.object({
      quoteId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetQuote($id: EncodedId!) {
          quote(id: $id) {
            ${JobberClient.quoteFields}
          }
        }
      `;

      const data = await client.query(query, { id: args.quoteId });
      return { quote: data.quote };
    },
  },

  create_quote: {
    description:
      'Create a new quote. Jobber requires an explicit propertyId (in addition to clientId) and at least one line item.',
    inputSchema: z.object({
      title: z.string().optional(),
      message: z.string().optional(),
      clientId: z.string(),
      propertyId: z.string(),
      lineItems: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            quantity: z.number().optional(),
            unitPrice: z.number().optional(),
            taxable: z.boolean().optional(),
            productOrServiceId: z.string().optional(),
            saveToProductsAndServices: z.boolean().default(false),
          })
        )
        .min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateQuote($attributes: QuoteCreateAttributes!) {
          quoteCreate(attributes: $attributes) {
            quote {
              ${JobberClient.quoteFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const attributes: Record<string, unknown> = {
        clientId: args.clientId,
        propertyId: args.propertyId,
        lineItems: args.lineItems.map((li: any) => ({
          name: li.name,
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          taxable: li.taxable,
          productOrServiceId: li.productOrServiceId,
          // Required by QuoteCreateLineItemAttributes; default to not saving.
          saveToProductsAndServices: li.saveToProductsAndServices ?? false,
        })),
      };
      if (args.title) attributes.title = args.title;
      if (args.message) attributes.message = args.message;

      const data = await client.mutate(mutation, { attributes });

      if (data.quoteCreate.userErrors?.length > 0) {
        throw new Error(`Quote creation failed: ${data.quoteCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { quote: data.quoteCreate.quote };
    },
  },

  update_quote: {
    description: 'Update an existing quote',
    inputSchema: z.object({
      quoteId: z.string(),
      title: z.string().optional(),
      message: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateQuote($quoteId: EncodedId!, $attributes: QuoteEditAttributes!) {
          quoteEdit(quoteId: $quoteId, attributes: $attributes) {
            quote {
              ${JobberClient.quoteFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const attributes: Record<string, unknown> = {};
      if (args.title) attributes.title = args.title;
      if (args.message) attributes.message = args.message;

      const data = await client.mutate(mutation, { quoteId: args.quoteId, attributes });

      if (data.quoteEdit.userErrors?.length > 0) {
        throw new Error(`Quote update failed: ${data.quoteEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { quote: data.quoteEdit.quote };
    },
  },

  convert_quote_to_job: {
    description:
      'Convert a quote into a job. There is no dedicated conversion mutation — this calls jobCreate(quoteId:), which is how Jobber links a new job back to the quote it came from. The property defaults to the quote\'s own property when not supplied.',
    inputSchema: z.object({
      quoteId: z.string(),
      propertyId: z.string().optional().describe("Defaults to the quote's own property"),
      invoicingType: z.enum(INVOICING_TYPE).default('FIXED_PRICE'),
      invoicingSchedule: z.enum(INVOICING_SCHEDULE).default('ON_COMPLETION'),
    }),
    execute: async (client: JobberClient, args: any) => {
      let propertyId = args.propertyId;
      if (!propertyId) {
        const propertyQuery = `
          query GetQuoteProperty($id: EncodedId!) {
            quote(id: $id) {
              property {
                id
              }
            }
          }
        `;
        const quoteData = await client.query(propertyQuery, { id: args.quoteId });
        propertyId = quoteData.quote?.property?.id;
        if (!propertyId) {
          throw new Error('Quote has no associated property; pass propertyId explicitly.');
        }
      }

      const mutation = `
        mutation ConvertQuoteToJob($input: JobCreateAttributes!) {
          jobCreate(input: $input) {
            job {
              ${JobberClient.jobFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input = {
        propertyId,
        quoteId: args.quoteId,
        invoicing: {
          invoicingType: args.invoicingType,
          invoicingSchedule: args.invoicingSchedule,
        },
      };

      const data = await client.mutate(mutation, { input });

      if (data.jobCreate.userErrors?.length > 0) {
        throw new Error(`Quote conversion failed: ${data.jobCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { job: data.jobCreate.job };
    },
  },

  list_quote_line_items: {
    description: 'List all line items for a specific quote',
    inputSchema: z.object({
      quoteId: z.string(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetQuoteLineItems($id: EncodedId!, $first: Int, $after: String) {
          quote(id: $id) {
            lineItems(first: $first, after: $after) {
              nodes {
                ${JobberClient.lineItemFields}
                category
                optional
                recommended
                textOnly
                sortOrder
                markup
                unitCost
              }
              ${PAGE_INFO}
            }
          }
        }
      `;

      const data = await client.query(query, {
        id: args.quoteId,
        first: args.limit,
        after: args.cursor,
      });
      return {
        lineItems: data.quote?.lineItems?.nodes ?? [],
        pageInfo: data.quote?.lineItems?.pageInfo,
        totalCount: data.quote?.lineItems?.totalCount,
      };
    },
  },
};
