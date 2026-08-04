/**
 * Taxes Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - The queryable/mutable resource is `TaxRate` (a "tax rate", not a
 *     "tax"). There is no `taxes`/`tax` query — only a `taxRates` connection,
 *     and there is no singular `taxRate(id)` query at all, so a lookup by ID
 *     has to scan the connection client-side.
 *   - `TaxRate` / `TaxRateBase` have no `rate`, `isActive`, or `isCompound`
 *     fields. The percentage lives on `tax: Float!` (a plain percentage,
 *     e.g. `13` for 13% — NOT a `0.13` decimal ratio). "Compound" tax rates
 *     are represented as a `TaxRate` whose `components: [TaxRateBase!]`
 *     holds the underlying simple rates; there is no boolean flag for it.
 *     There is no `isActive` concept for tax rates in this API at all.
 *   - Mutations are `taxCreate` (returns a `TaxRateBase`, input
 *     `TaxCreateInput { name, rate, internalDescription, defaultTax }`) and
 *     `taxGroupCreate` (returns a `TaxRate`, input `TaxGroupCreateInput {
 *     name, taxRateIds, internalDescription }`). There is NO `taxUpdate`,
 *     `taxDelete`, `lineItemTaxApply`, or `lineItemTaxRemove` mutation
 *     anywhere in the schema — tax rates can only be created, never edited,
 *     deleted, or attached/detached from a line item directly through this
 *     API (that happens via `taxRateId` on the relevant line item's own
 *     create/edit input, which is owned by the invoice/quote/job line-item
 *     tools, not this module).
 *   - There is no `invoiceOrQuote` query (or any such polymorphic lookup).
 *     Tax totals are read via `Invoice.taxDetails` / `Quote.taxDetails`
 *     (`TaxDetails { totalTaxAmount, totalTaxRate }`), which belong to the
 *     invoices/quotes tools, not this module.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

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

/** Fields common to `TaxRate` and `TaxRateBase`. */
const TAX_RATE_BASE_FIELDS = `
  id
  name
  label
  description
  tax
  default
  qboTaxType
`;

/** `TaxRate` adds `components` (the simple rates making up a tax group) over `TaxRateBase`. */
const TAX_RATE_FIELDS = `
  ${TAX_RATE_BASE_FIELDS}
  components {
    ${TAX_RATE_BASE_FIELDS}
  }
`;

export const taxesTools = {
  list_tax_rates: {
    description:
      'List tax rates (and tax groups) configured on the account, optionally filtered by a search term matched against the name.',
    inputSchema: z.object({
      searchTerm: z.string().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query ListTaxRates($first: Int, $after: String, $searchTerm: String) {
          taxRates(first: $first, after: $after, searchTerm: $searchTerm) {
            nodes {
              ${TAX_RATE_FIELDS}
            }
            ${PAGE_INFO}
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        after: args.cursor,
        searchTerm: args.searchTerm,
      });
      return {
        taxRates: data.taxRates.nodes,
        pageInfo: data.taxRates.pageInfo,
        totalCount: data.taxRates.totalCount,
      };
    },
  },

  get_tax_rate: {
    description:
      'Get a specific tax rate by ID. Jobber has no single-tax-rate query, so this scans the `taxRates` connection client-side looking for a match — it inspects at most `scanLimit` rates (default 250) across as many pages as needed.',
    inputSchema: z.object({
      taxRateId: z.string(),
      scanLimit: z.number().default(250).describe('Maximum number of tax rates to scan before giving up'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query ScanTaxRates($first: Int, $after: String) {
          taxRates(first: $first, after: $after) {
            nodes {
              ${TAX_RATE_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      let after: string | undefined;
      let scanned = 0;
      const pageSize = 100;

      while (scanned < args.scanLimit) {
        const first = Math.min(pageSize, args.scanLimit - scanned);
        const data = await client.query(query, { first, after });
        const nodes = data.taxRates.nodes as any[];

        const match = nodes.find((n) => n.id === args.taxRateId);
        if (match) {
          return { taxRate: match };
        }

        scanned += nodes.length;
        if (!data.taxRates.pageInfo.hasNextPage) break;
        after = data.taxRates.pageInfo.endCursor;
      }

      throw new Error(
        `Tax rate ${args.taxRateId} not found in the first ${scanned} tax rate(s). Try list_tax_rates with a searchTerm, or increase scanLimit.`
      );
    },
  },

  create_tax_rate: {
    description: 'Create a new (simple) tax rate.',
    inputSchema: z.object({
      name: z.string(),
      rate: z.number().describe('Tax rate as a percentage, e.g. 13 for 13% (NOT a 0.13 decimal ratio)'),
      internalDescription: z.string().optional(),
      defaultTax: z.boolean().optional().describe('Make this tax the default for quotes and invoices'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateTaxRate($input: TaxCreateInput!) {
          taxCreate(input: $input) {
            tax {
              ${TAX_RATE_BASE_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {
        name: args.name,
        rate: args.rate,
      };
      if (args.internalDescription) input.internalDescription = args.internalDescription;
      if (args.defaultTax !== undefined) input.defaultTax = args.defaultTax;

      const data = await client.mutate(mutation, { input });

      if (data.taxCreate.userErrors?.length > 0) {
        throw new Error(`Tax rate creation failed: ${data.taxCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { taxRate: data.taxCreate.tax };
    },
  },

  create_tax_group: {
    description: 'Create a new tax group from existing tax rates (e.g. combining a federal and provincial/state rate).',
    inputSchema: z.object({
      name: z.string(),
      taxRateIds: z.array(z.string()).min(1).describe('IDs of existing tax rates to combine into the group'),
      internalDescription: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateTaxGroup($input: TaxGroupCreateInput!) {
          taxGroupCreate(input: $input) {
            taxGroup {
              ${TAX_RATE_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {
        name: args.name,
        taxRateIds: args.taxRateIds,
      };
      if (args.internalDescription) input.internalDescription = args.internalDescription;

      const data = await client.mutate(mutation, { input });

      if (data.taxGroupCreate.userErrors?.length > 0) {
        throw new Error(
          `Tax group creation failed: ${data.taxGroupCreate.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { taxGroup: data.taxGroupCreate.taxGroup };
    },
  },

  // NOTE: the following tools were removed because they called
  // queries/mutations that do not exist anywhere in the schema:
  //   - get_tax / list_taxes -> replaced by get_tax_rate / list_tax_rates
  //     against the real `taxRates` connection.
  //   - update_tax -> there is no `taxUpdate` mutation. Tax rates cannot be
  //     edited through this API once created.
  //   - delete_tax -> there is no `taxDelete` mutation. Tax rates cannot be
  //     deleted through this API.
  //   - apply_tax_to_line_item / remove_tax_from_line_item -> there is no
  //     `lineItemTaxApply` / `lineItemTaxRemove` mutation. A line item's tax
  //     is set via `taxRateId` / `taxable` on that line item's own
  //     create/edit input (invoice/quote/job line-item tools), not a
  //     standalone mutation this module can drive.
  //   - calculate_tax_total -> there is no `invoiceOrQuote` query. Tax
  //     totals live on `Invoice.taxDetails` / `Quote.taxDetails`
  //     (`TaxDetails { totalTaxAmount, totalTaxRate }`), which belong to the
  //     invoices/quotes tools, not this module.
};
