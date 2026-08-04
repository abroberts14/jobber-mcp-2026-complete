/**
 * Invoices Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - Invoice status enum values are lowercase (InvoiceStatusTypeEnum:
 *     `draft`, `awaiting_payment`, `paid`, `past_due`, `bad_debt`,
 *     `sent_not_due`, `voided`).
 *   - There is no `invoiceSend` mutation. The real equivalent is
 *     `invoiceMarkAsSent(id:)`, which flips status draft -> sent-ish but
 *     takes no message body — Jobber sends its own templated notification,
 *     there is nowhere to pass custom text.
 *   - There is no `paymentCreate` mutation anywhere in the schema — Jobber's
 *     public API does not expose recording a payment. Invoice also has no
 *     `payments` field; the real field is `paymentRecords` (a Connection of
 *     `PaymentRecord`, read-only).
 *   - `invoiceCreate` takes `input: InvoiceCreateInput!` and requires `tax`,
 *     `dueDetails`, and a non-empty `lineItems` array — there is no bare
 *     `dueDate` shortcut on the mutation itself (it lives inside
 *     `dueDetails`).
 *   - Money values are plain `Float`, never `{ amount currency }`.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

/** InvoiceStatusTypeEnum, verbatim. */
const INVOICE_STATUS = [
  'draft', 'awaiting_payment', 'paid', 'past_due', 'bad_debt', 'sent_not_due', 'voided',
] as const;

/** TaxCalculationMethodType, verbatim. */
const TAX_CALCULATION_METHOD = ['EXCLUSIVE', 'INCLUSIVE'] as const;

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

export const invoicesTools = {
  list_invoices: {
    description: 'List invoices with optional filtering by status or client',
    inputSchema: z.object({
      status: z.enum(INVOICE_STATUS).optional(),
      clientId: z.string().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.clientId) filter.clientId = args.clientId;

      const query = `
        query ListInvoices($first: Int, $after: String, $filter: InvoiceFilterAttributes) {
          invoices(first: $first, after: $after, filter: $filter) {
            nodes {
              ${JobberClient.invoiceFields}
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
        invoices: data.invoices.nodes,
        pageInfo: data.invoices.pageInfo,
        totalCount: data.invoices.totalCount,
      };
    },
  },

  get_invoice: {
    description: 'Get a specific invoice by ID',
    inputSchema: z.object({
      invoiceId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetInvoice($id: EncodedId!) {
          invoice(id: $id) {
            ${JobberClient.invoiceFields}
          }
        }
      `;

      const data = await client.query(query, { id: args.invoiceId });
      return { invoice: data.invoice };
    },
  },

  create_invoice: {
    description:
      'Create a new invoice for a client. Jobber requires explicit tax handling and at least one line item; a bare dueDate is not enough on its own.',
    inputSchema: z.object({
      subject: z.string().optional(),
      clientId: z.string(),
      jobId: z.string().optional(),
      propertyId: z.string().optional().describe('Only valid for invoices without a job'),
      dueDate: z.string().optional().describe('ISO 8601 date'),
      invoiceNet: z.number().optional().describe('Days after the issue date payment is due'),
      taxCalculationMethod: z.enum(TAX_CALCULATION_METHOD).default('EXCLUSIVE'),
      taxRateId: z.string().optional(),
      lineItems: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            quantity: z.number().optional(),
            unitPrice: z.number().optional(),
            taxable: z.boolean().optional(),
            productOrServiceId: z.string().optional(),
          })
        )
        .min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateInvoice($input: InvoiceCreateInput!) {
          invoiceCreate(input: $input) {
            invoice {
              ${JobberClient.invoiceFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {
        clientId: args.clientId,
        tax: {
          taxCalculationMethod: args.taxCalculationMethod,
          taxRateId: args.taxRateId,
        },
        dueDetails: {
          dueDate: args.dueDate,
          invoiceNet: args.invoiceNet,
        },
        lineItems: args.lineItems,
      };
      if (args.subject) input.subject = args.subject;
      if (args.jobId) input.jobId = args.jobId;
      if (args.propertyId) input.propertyId = args.propertyId;

      const data = await client.mutate(mutation, { input });

      if (data.invoiceCreate.userErrors?.length > 0) {
        throw new Error(`Invoice creation failed: ${data.invoiceCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { invoice: data.invoiceCreate.invoice };
    },
  },

  send_invoice: {
    description:
      'Mark an invoice as sent to the client. There is no invoiceSend mutation with a custom message — invoiceMarkAsSent takes only the invoice ID and Jobber sends its own templated notification.',
    inputSchema: z.object({
      invoiceId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation MarkInvoiceSent($id: EncodedId!) {
          invoiceMarkAsSent(id: $id) {
            invoice {
              ${JobberClient.invoiceFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { id: args.invoiceId });

      if (data.invoiceMarkAsSent.userErrors?.length > 0) {
        throw new Error(`Invoice send failed: ${data.invoiceMarkAsSent.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { invoice: data.invoiceMarkAsSent.invoice };
    },
  },

  list_invoice_payments: {
    description:
      'List payment records applied to a specific invoice. Invoice has no `payments` field — this reads the real `paymentRecords` connection.',
    inputSchema: z.object({
      invoiceId: z.string(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetInvoicePaymentRecords($id: EncodedId!, $first: Int, $after: String) {
          invoice(id: $id) {
            paymentRecords(first: $first, after: $after) {
              nodes {
                id
                amount
                entryDate
                adjustmentType
                tipAmount
              }
              ${PAGE_INFO}
            }
          }
        }
      `;

      const data = await client.query(query, {
        id: args.invoiceId,
        first: args.limit,
        after: args.cursor,
      });
      return {
        payments: data.invoice?.paymentRecords?.nodes ?? [],
        pageInfo: data.invoice?.paymentRecords?.pageInfo,
        totalCount: data.invoice?.paymentRecords?.totalCount,
      };
    },
  },
};
