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

  update_invoice: {
    description: 'Update an existing invoice',
    inputSchema: z.object({
      invoiceId: z.string(),
      subject: z.string().optional(),
      message: z.string().optional(),
      invoiceNumber: z.string().optional(),
      issuedDate: z.string().optional().describe('ISO 8601 datetime'),
      propertyId: z.string().optional(),
      taxRateId: z.string().optional(),
      salespersonId: z.string().optional(),
      allowPartialPayments: z.boolean().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateInvoice($invoiceId: EncodedId!, $input: InvoiceEditInput!) {
          invoiceEdit(invoiceId: $invoiceId, input: $input) {
            invoice {
              ${JobberClient.invoiceFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      for (const key of [
        'subject', 'message', 'invoiceNumber', 'issuedDate',
        'propertyId', 'taxRateId', 'salespersonId', 'allowPartialPayments',
      ]) {
        if (args[key] !== undefined) input[key] = args[key];
      }

      const data = await client.mutate(mutation, { invoiceId: args.invoiceId, input });

      if (data.invoiceEdit.userErrors?.length > 0) {
        throw new Error(`Invoice update failed: ${data.invoiceEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { invoice: data.invoiceEdit.invoice };
    },
  },

  void_invoice: {
    description:
      'Void an invoice. Voiding is the only way to retire an invoice — Jobber has no invoice-delete mutation — and an open invoice will block archiving its client.',
    inputSchema: z.object({
      invoiceId: z.string(),
      voidReasonCode: z
        .enum(['DUPLICATE_INVOICE', 'CREATED_IN_ERROR', 'CLIENT_REQUEST', 'OTHER'])
        .default('CREATED_IN_ERROR'),
      voidReasonDetails: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation VoidInvoice($id: EncodedId!, $input: InvoiceVoidInput!) {
          invoiceVoid(id: $id, input: $input) {
            invoice {
              ${JobberClient.invoiceFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = { voidReasonCode: args.voidReasonCode };
      if (args.voidReasonDetails) input.voidReasonDetails = args.voidReasonDetails;

      const data = await client.mutate(mutation, { id: args.invoiceId, input });

      if (data.invoiceVoid.userErrors?.length > 0) {
        throw new Error(`Invoice void failed: ${data.invoiceVoid.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { invoice: data.invoiceVoid.invoice };
    },
  },

  close_invoice: {
    description:
      'Close an invoice, either by marking the balance received or writing it off as bad debt.',
    inputSchema: z.object({
      invoiceId: z.string(),
      closeOption: z.enum(['MARK_RECEIVED', 'BAD_DEBT']).default('MARK_RECEIVED'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CloseInvoice($id: EncodedId!, $input: InvoiceCloseInput!) {
          invoiceClose(id: $id, input: $input) {
            invoice {
              ${JobberClient.invoiceFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, {
        id: args.invoiceId,
        input: { closeOption: args.closeOption },
      });

      if (data.invoiceClose.userErrors?.length > 0) {
        throw new Error(`Invoice close failed: ${data.invoiceClose.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { invoice: data.invoiceClose.invoice };
    },
  },

  reopen_invoice: {
    description: 'Reopen a closed invoice',
    inputSchema: z.object({
      invoiceId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation ReopenInvoice($id: EncodedId!) {
          invoiceReopen(id: $id) {
            invoice {
              ${JobberClient.invoiceFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { id: args.invoiceId });

      if (data.invoiceReopen.userErrors?.length > 0) {
        throw new Error(`Invoice reopen failed: ${data.invoiceReopen.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { invoice: data.invoiceReopen.invoice };
    },
  },

  unmark_invoice_bad_debt: {
    description: 'Reverse a bad-debt write-off, returning the invoice to its prior state',
    inputSchema: z.object({
      invoiceId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UnmarkBadDebt($id: EncodedId!) {
          invoiceUnmarkBadDebt(id: $id) {
            invoice {
              ${JobberClient.invoiceFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { id: args.invoiceId });

      if (data.invoiceUnmarkBadDebt.userErrors?.length > 0) {
        throw new Error(
          `Unmark bad debt failed: ${data.invoiceUnmarkBadDebt.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { invoice: data.invoiceUnmarkBadDebt.invoice };
    },
  },

  list_payments: {
    description:
      'List payment records across the account. Read-only: Jobber exposes no mutation for recording a payment.',
    inputSchema: z.object({
      clientId: z.string().optional(),
      paymentType: z
        .enum([
          'CASH', 'CHEQUE', 'CREDIT_CARD', 'BANK_TRANSFER', 'MONEY_ORDER', 'OTHER',
          'ZELLE', 'CASH_APP', 'PAYPAL', 'VENMO', 'E_TRANSFER', 'ACH_BANK_PAYMENT',
          'JOBBER_PAYMENTS', 'EPAYMENT', 'CONSUMER_FINANCING',
        ])
        .optional(),
      entryDateAfter: z.string().optional().describe('ISO 8601 datetime'),
      entryDateBefore: z.string().optional().describe('ISO 8601 datetime'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query ListPayments($first: Int, $after: String, $filter: PaymentRecordFilterAttributes) {
          paymentRecords(first: $first, after: $after, filter: $filter) {
            nodes {
              id
              amount
              rawAmount
              entryDate
              adjustmentType
              paymentType
              details
              sentAt
              client {
                id
                name
              }
              invoice {
                id
                invoiceNumber
              }
            }
            ${PAGE_INFO}
          }
        }
      `;

      const filter: Record<string, unknown> = {};
      if (args.clientId) filter.clientId = args.clientId;
      if (args.paymentType) filter.paymentType = args.paymentType;
      if (args.entryDateAfter || args.entryDateBefore) {
        filter.entryDate = {
          ...(args.entryDateAfter ? { after: args.entryDateAfter } : {}),
          ...(args.entryDateBefore ? { before: args.entryDateBefore } : {}),
        };
      }

      const data = await client.query(query, {
        first: args.limit,
        after: args.cursor,
        filter,
      });
      return {
        payments: data.paymentRecords?.nodes ?? [],
        pageInfo: data.paymentRecords?.pageInfo,
        totalCount: data.paymentRecords?.totalCount,
      };
    },
  },

  get_payment: {
    description: 'Get a specific payment record by ID',
    inputSchema: z.object({
      paymentId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetPayment($id: EncodedId!) {
          paymentRecord(id: $id) {
            id
            amount
            rawAmount
            entryDate
            adjustmentType
            paymentType
            paymentOrigin
            details
            sentAt
            canEdit
            client {
              id
              name
            }
            invoice {
              id
              invoiceNumber
            }
          }
        }
      `;

      const data = await client.query(query, { id: args.paymentId });
      return { payment: data.paymentRecord };
    },
  },
};
