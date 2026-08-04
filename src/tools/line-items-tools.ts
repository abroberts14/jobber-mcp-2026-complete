/**
 * Line Items Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. There is NO `LineItem` type and
 * NO root `lineItemCreate`/`lineItemUpdate`/`lineItemDelete`/`lineItemsReorder`
 * /`lineItemDuplicate` mutation. Jobber models line items per parent instead:
 *   - Types: JobLineItem, QuoteLineItem, InvoiceLineItem, RequestLineItem
 *   - Mutations are parent-scoped and batched:
 *       jobCreateLineItems / jobEditLineItems / jobDeleteLineItems / jobOrderLineItems
 *       quoteCreateLineItems / quoteEditLineItems / quoteDeleteLineItems / quoteCreateTextLineItems
 *       visitCreateLineItems / visitEditLineItems / visitDeleteLineItems
 *       requestCreateLineItems / requestEditLineItems / requestDeleteLineItems
 *   - There is no invoice line item mutation of any kind (no
 *     `invoiceCreateLineItems` etc.) — invoices only ever receive line items
 *     copied over from a job, so invoice line items are read-only via the API.
 *   - There is no duplicate mutation for line items on any parent.
 *   - Only jobs support reordering (`jobOrderLineItems`); no other parent has
 *     an equivalent.
 *
 * Tools below take a `parent` discriminator (`job` | `quote` | `visit` |
 * `request`) plus `parentId` and dispatch to the matching parent-scoped
 * mutation, since the attribute shape and even the argument shape (some take
 * `input: { lineItems }`, others take `lineItems` directly) differ per parent.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

const PARENTS = ['job', 'quote', 'visit', 'request'] as const;
type ParentType = (typeof PARENTS)[number];

const CATEGORY = ['PRODUCT', 'SERVICE'] as const;

const USER_ERRORS = `
  userErrors {
    message
    path
  }
`;

/** Pick only the keys a given parent's input attributes actually accept. */
function pickAttrs(source: Record<string, any>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Attributes accepted by each parent's *CreateLineItem(s)Attributes input. */
const CREATE_ATTR_KEYS: Record<ParentType, string[]> = {
  job: [
    'name', 'description', 'category', 'taxable', 'saveToProductsAndServices',
    'unitCost', 'productOrServiceId', 'unitPrice', 'quantity', 'totalPrice', 'sortOrder',
  ],
  quote: [
    'name', 'description', 'category', 'taxable', 'saveToProductsAndServices',
    'optional', 'recommended', 'textOnly', 'unitCost', 'unitPrice', 'quantity',
    'totalPrice', 'productOrServiceId',
  ],
  visit: [
    'name', 'description', 'category', 'unitPrice', 'quantity', 'totalPrice',
    'taxable', 'saveToProductsAndServices',
  ],
  request: [
    'name', 'description', 'category', 'taxable', 'saveToProductsAndServices',
    'unitCost', 'unitPrice', 'quantity', 'totalPrice', 'productOrServiceId', 'sortOrder',
  ],
};

/** Attributes accepted by each parent's *EditLineItemAttributes input. */
const EDIT_ATTR_KEYS: Record<ParentType, string[]> = {
  job: [
    'lineItemId', 'name', 'description', 'unitPrice', 'quantity', 'taxable',
    'category', 'totalPrice', 'unitCost', 'productOrServiceId',
  ],
  quote: [
    'lineItemId', 'name', 'description', 'unitPrice', 'quantity', 'taxable',
    'category', 'sortOrder', 'totalPrice', 'unitCost', 'optional', 'recommended',
    'productOrServiceId',
  ],
  visit: ['lineItemId', 'name', 'description', 'unitPrice', 'quantity', 'totalPrice'],
  request: [
    'lineItemId', 'name', 'description', 'unitPrice', 'quantity', 'taxable',
    'category', 'sortOrder', 'totalPrice', 'unitCost', 'productOrServiceId',
  ],
};

/** Fields shared by JobLineItem/QuoteLineItem/RequestLineItem beyond the base fragment. */
const lineItemAttrsSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  quantity: z.number(),
  unitPrice: z.number(),
  totalPrice: z.number().optional(),
  taxable: z.boolean().optional(),
  category: z.enum(CATEGORY).optional(),
  productOrServiceId: z.string().optional(),
  unitCost: z.number().optional(),
  sortOrder: z.number().optional().describe('Job/quote/request only'),
  saveToProductsAndServices: z.boolean().default(false),
  optional: z.boolean().optional().describe('Quote only: is this line item optional for the client'),
  recommended: z.boolean().optional().describe('Quote only: recommended when optional'),
  textOnly: z.boolean().optional().describe('Quote only: text-only line item'),
});

const lineItemEditSchema = z.object({
  lineItemId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().optional(),
  unitPrice: z.number().optional(),
  totalPrice: z.number().optional(),
  taxable: z.boolean().optional(),
  category: z.enum(CATEGORY).optional(),
  productOrServiceId: z.string().optional(),
  unitCost: z.number().optional(),
  sortOrder: z.number().optional().describe('Job/quote/request only'),
  optional: z.boolean().optional().describe('Quote only'),
  recommended: z.boolean().optional().describe('Quote only'),
});

export const lineItemsTools = {
  create_line_items: {
    description:
      'Add one or more line items to a job, quote, visit, or request. The parent determines which Jobber mutation is used, since attribute shapes and argument shapes differ per parent (invoices have no line item mutations at all — their line items are copied from a job).',
    inputSchema: z.object({
      parent: z.enum(PARENTS).describe('Which record the line items belong to'),
      parentId: z.string().describe('EncodedId of the job/quote/visit/request'),
      lineItems: z.array(lineItemAttrsSchema).min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as ParentType;
      const attrs = args.lineItems.map((li: any) => pickAttrs(li, CREATE_ATTR_KEYS[parent]));

      switch (parent) {
        case 'job': {
          const mutation = `
            mutation CreateJobLineItems($jobId: EncodedId!, $input: JobCreateLineItemsInput!) {
              jobCreateLineItems(jobId: $jobId, input: $input) {
                createdLineItems {
                  ${JobberClient.lineItemFields}
                  category
                }
                job {
                  id
                  jobNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            jobId: args.parentId,
            input: { lineItems: attrs },
          });
          if (data.jobCreateLineItems.userErrors?.length > 0) {
            throw new Error(`Line item creation failed: ${data.jobCreateLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, job: data.jobCreateLineItems.job, lineItems: data.jobCreateLineItems.createdLineItems };
        }

        case 'quote': {
          const mutation = `
            mutation CreateQuoteLineItems($quoteId: EncodedId!, $lineItems: [QuoteCreateLineItemAttributes!]!) {
              quoteCreateLineItems(quoteId: $quoteId, lineItems: $lineItems) {
                createdLineItems {
                  ${JobberClient.lineItemFields}
                  category
                  optional
                  sortOrder
                }
                quote {
                  id
                  quoteNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            quoteId: args.parentId,
            lineItems: attrs,
          });
          if (data.quoteCreateLineItems.userErrors?.length > 0) {
            throw new Error(`Line item creation failed: ${data.quoteCreateLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, quote: data.quoteCreateLineItems.quote, lineItems: data.quoteCreateLineItems.createdLineItems };
        }

        case 'visit': {
          const mutation = `
            mutation CreateVisitLineItems($visitId: EncodedId!, $input: VisitCreateLineItemInput!) {
              visitCreateLineItems(visitId: $visitId, input: $input) {
                visit {
                  ${JobberClient.visitFields}
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            visitId: args.parentId,
            input: { lineItems: attrs },
          });
          if (data.visitCreateLineItems.userErrors?.length > 0) {
            throw new Error(`Line item creation failed: ${data.visitCreateLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          // Jobber's VisitCreateLineItemsPayload has no line-items field — only
          // the updated visit is returned.
          return { parent, visit: data.visitCreateLineItems.visit };
        }

        case 'request': {
          const mutation = `
            mutation CreateRequestLineItems($requestId: EncodedId!, $lineItems: [RequestCreateLineItemAttributes!]!) {
              requestCreateLineItems(requestId: $requestId, lineItems: $lineItems) {
                lineItems {
                  ${JobberClient.lineItemFields}
                  category
                  sortOrder
                }
                request {
                  id
                  title
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            requestId: args.parentId,
            lineItems: attrs,
          });
          if (data.requestCreateLineItems.userErrors?.length > 0) {
            throw new Error(`Line item creation failed: ${data.requestCreateLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, request: data.requestCreateLineItems.request, lineItems: data.requestCreateLineItems.lineItems };
        }
      }
    },
  },

  create_quote_text_line_items: {
    description:
      'Add one or more text-only line items to a quote (no quantity/price — headings or notes within the quote body). Quote-only; Jobber has no equivalent for other parents.',
    inputSchema: z.object({
      quoteId: z.string(),
      lineItems: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            category: z.enum(CATEGORY).optional(),
          })
        )
        .min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateQuoteTextLineItems($quoteId: EncodedId!, $lineItems: [QuoteCreateTextLineItemAttributes!]!) {
          quoteCreateTextLineItems(quoteId: $quoteId, lineItems: $lineItems) {
            createdLineItems {
              id
              name
              description
              category
              textOnly
            }
            quote {
              id
              quoteNumber
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, {
        quoteId: args.quoteId,
        lineItems: args.lineItems.map((li: any) => ({
          name: li.name,
          description: li.description,
          category: li.category,
        })),
      });

      if (data.quoteCreateTextLineItems.userErrors?.length > 0) {
        throw new Error(`Text line item creation failed: ${data.quoteCreateTextLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { quote: data.quoteCreateTextLineItems.quote, lineItems: data.quoteCreateTextLineItems.createdLineItems };
    },
  },

  edit_line_items: {
    description:
      'Edit one or more existing line items on a job, quote, visit, or request. The parent determines which Jobber mutation is used. Batches naturally — pass multiple entries to update several line items on the same parent in one call.',
    inputSchema: z.object({
      parent: z.enum(PARENTS),
      parentId: z.string().describe('EncodedId of the job/quote/visit/request'),
      lineItems: z.array(lineItemEditSchema).min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as ParentType;
      const attrs = args.lineItems.map((li: any) => pickAttrs(li, EDIT_ATTR_KEYS[parent]));

      switch (parent) {
        case 'job': {
          const mutation = `
            mutation EditJobLineItems($jobId: EncodedId!, $input: JobEditLineItemsInput!) {
              jobEditLineItems(jobId: $jobId, input: $input) {
                modifiedLineItems {
                  ${JobberClient.lineItemFields}
                  category
                }
                job {
                  id
                  jobNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            jobId: args.parentId,
            input: { lineItems: attrs },
          });
          if (data.jobEditLineItems.userErrors?.length > 0) {
            throw new Error(`Line item update failed: ${data.jobEditLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, job: data.jobEditLineItems.job, lineItems: data.jobEditLineItems.modifiedLineItems };
        }

        case 'quote': {
          const mutation = `
            mutation EditQuoteLineItems($quoteId: EncodedId!, $lineItems: [QuoteEditLineItemAttributes!]!) {
              quoteEditLineItems(quoteId: $quoteId, lineItems: $lineItems) {
                modifiedLineItems {
                  ${JobberClient.lineItemFields}
                  category
                  optional
                  sortOrder
                }
                quote {
                  id
                  quoteNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            quoteId: args.parentId,
            lineItems: attrs,
          });
          if (data.quoteEditLineItems.userErrors?.length > 0) {
            throw new Error(`Line item update failed: ${data.quoteEditLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, quote: data.quoteEditLineItems.quote, lineItems: data.quoteEditLineItems.modifiedLineItems };
        }

        case 'visit': {
          const mutation = `
            mutation EditVisitLineItems($visitId: EncodedId!, $input: VisitEditLineItemsInput!) {
              visitEditLineItems(visitId: $visitId, input: $input) {
                visit {
                  ${JobberClient.visitFields}
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            visitId: args.parentId,
            input: { lineItems: attrs },
          });
          if (data.visitEditLineItems.userErrors?.length > 0) {
            throw new Error(`Line item update failed: ${data.visitEditLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, visit: data.visitEditLineItems.visit };
        }

        case 'request': {
          const mutation = `
            mutation EditRequestLineItems($requestId: EncodedId!, $lineItems: [RequestEditLineItemAttributes!]!) {
              requestEditLineItems(requestId: $requestId, lineItems: $lineItems) {
                lineItems {
                  ${JobberClient.lineItemFields}
                  category
                  sortOrder
                }
                request {
                  id
                  title
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            requestId: args.parentId,
            lineItems: attrs,
          });
          if (data.requestEditLineItems.userErrors?.length > 0) {
            throw new Error(`Line item update failed: ${data.requestEditLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, request: data.requestEditLineItems.request, lineItems: data.requestEditLineItems.lineItems };
        }
      }
    },
  },

  delete_line_items: {
    description: 'Delete one or more line items from a job, quote, visit, or request.',
    inputSchema: z.object({
      parent: z.enum(PARENTS),
      parentId: z.string().describe('EncodedId of the job/quote/visit/request'),
      lineItemIds: z.array(z.string()).min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as ParentType;

      switch (parent) {
        case 'job': {
          const mutation = `
            mutation DeleteJobLineItems($jobId: EncodedId!, $input: JobDeleteLineItemsInput!) {
              jobDeleteLineItems(jobId: $jobId, input: $input) {
                deletedLineItems {
                  id
                  name
                }
                job {
                  id
                  jobNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            jobId: args.parentId,
            input: { lineItemIds: args.lineItemIds },
          });
          if (data.jobDeleteLineItems.userErrors?.length > 0) {
            throw new Error(`Line item deletion failed: ${data.jobDeleteLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, job: data.jobDeleteLineItems.job, deletedLineItems: data.jobDeleteLineItems.deletedLineItems };
        }

        case 'quote': {
          const mutation = `
            mutation DeleteQuoteLineItems($quoteId: EncodedId!, $lineItemIds: [EncodedId!]!) {
              quoteDeleteLineItems(quoteId: $quoteId, lineItemIds: $lineItemIds) {
                deletedLineItems {
                  id
                  name
                }
                quote {
                  id
                  quoteNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            quoteId: args.parentId,
            lineItemIds: args.lineItemIds,
          });
          if (data.quoteDeleteLineItems.userErrors?.length > 0) {
            throw new Error(`Line item deletion failed: ${data.quoteDeleteLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, quote: data.quoteDeleteLineItems.quote, deletedLineItems: data.quoteDeleteLineItems.deletedLineItems };
        }

        case 'visit': {
          const mutation = `
            mutation DeleteVisitLineItems($visitId: EncodedId!, $input: VisitDeleteLineItemsInput!) {
              visitDeleteLineItems(visitId: $visitId, input: $input) {
                visit {
                  ${JobberClient.visitFields}
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            visitId: args.parentId,
            input: { lineItemIds: args.lineItemIds },
          });
          if (data.visitDeleteLineItems.userErrors?.length > 0) {
            throw new Error(`Line item deletion failed: ${data.visitDeleteLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, visit: data.visitDeleteLineItems.visit };
        }

        case 'request': {
          const mutation = `
            mutation DeleteRequestLineItems($requestId: EncodedId!, $lineItemIds: [EncodedId!]!) {
              requestDeleteLineItems(requestId: $requestId, lineItemIds: $lineItemIds) {
                lineItems {
                  id
                  name
                }
                request {
                  id
                  title
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            requestId: args.parentId,
            lineItemIds: args.lineItemIds,
          });
          if (data.requestDeleteLineItems.userErrors?.length > 0) {
            throw new Error(`Line item deletion failed: ${data.requestDeleteLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, request: data.requestDeleteLineItems.request, deletedLineItems: data.requestDeleteLineItems.lineItems };
        }
      }
    },
  },

  reorder_job_line_items: {
    description:
      'Reorder line items within a job. Only jobs support reordering — there is no equivalent mutation for quotes, visits, or requests.',
    inputSchema: z.object({
      jobId: z.string(),
      orderedLineItemIds: z.array(z.string()).min(1).describe('Complete, ordered list of the job line item IDs'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation ReorderJobLineItems($jobId: EncodedId!, $orderedLineItemIds: [EncodedId!]!) {
          jobOrderLineItems(jobId: $jobId, orderedLineItemIds: $orderedLineItemIds) {
            job {
              ${JobberClient.jobFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, {
        jobId: args.jobId,
        orderedLineItemIds: args.orderedLineItemIds,
      });

      if (data.jobOrderLineItems.userErrors?.length > 0) {
        throw new Error(`Line item reorder failed: ${data.jobOrderLineItems.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { job: data.jobOrderLineItems.job };
    },
  },
};
