/**
 * Products/Services Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - The type is `ProductOrService`. There is no `unitPrice`, `type`, or
 *     `isArchived` field — money is `defaultUnitCost` / `internalUnitCost`
 *     (plain `Float`s), and the product/service split is `category`
 *     (`ProductsAndServicesCategory`: `PRODUCT` | `SERVICE`).
 *   - `ProductsFilterInput.category` is typed `[WorkItemCategoryTypeEnum!]`,
 *     a DIFFERENT enum with differently-cased values (`Product` | `Service`)
 *     from the one used on the entity/mutations (`ProductsAndServicesCategory`:
 *     `PRODUCT` | `SERVICE`). Filtering has to translate between the two.
 *   - There is a singular `product(id: EncodedId!)` query, in addition to
 *     the `products` connection.
 *   - Mutations are `productsAndServicesCreate` / `productsAndServicesEdit`
 *     (not `productCreate`/`productUpdate`/`productArchive`). There is no
 *     archive/delete mutation for products or services at all.
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

/** Standard product/service fields fragment (local to this module). */
const PRODUCT_FIELDS = `
  id
  name
  description
  category
  defaultUnitCost
  internalUnitCost
  markup
  taxable
  visible
  durationMinutes
  onlineBookingsEnabled
`;

/**
 * Translate the entity-facing `ProductsAndServicesCategory` enum
 * (`PRODUCT`/`SERVICE`, used on `ProductOrService.category` and the
 * create/edit mutations) into `WorkItemCategoryTypeEnum` (`Product`/
 * `Service`), which is what `ProductsFilterInput.category` actually expects.
 */
const CATEGORY_FILTER_VALUE: Record<'PRODUCT' | 'SERVICE', 'Product' | 'Service'> = {
  PRODUCT: 'Product',
  SERVICE: 'Service',
};

export const productsTools = {
  list_products: {
    description: 'List all products and services, optionally filtered by category or search term',
    inputSchema: z.object({
      category: z.enum(['PRODUCT', 'SERVICE']).optional(),
      searchTerm: z.string().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.category) filter.category = [CATEGORY_FILTER_VALUE[args.category as 'PRODUCT' | 'SERVICE']];

      const query = `
        query ListProducts($first: Int, $after: String, $filter: ProductsFilterInput, $searchTerm: String) {
          products(first: $first, after: $after, filter: $filter, searchTerm: $searchTerm) {
            nodes {
              ${PRODUCT_FIELDS}
            }
            ${PAGE_INFO}
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        after: args.cursor,
        filter,
        searchTerm: args.searchTerm,
      });
      return {
        products: data.products.nodes,
        pageInfo: data.products.pageInfo,
        totalCount: data.products.totalCount,
      };
    },
  },

  get_product: {
    description: 'Get a specific product or service by ID',
    inputSchema: z.object({
      productId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetProduct($id: EncodedId!) {
          product(id: $id) {
            ${PRODUCT_FIELDS}
          }
        }
      `;

      const data = await client.query(query, { id: args.productId });
      return { product: data.product };
    },
  },

  create_product: {
    description: 'Create a new product or service',
    inputSchema: z.object({
      name: z.string(),
      defaultUnitCost: z.number().describe('The default price for the service or product'),
      description: z.string().optional(),
      category: z.enum(['PRODUCT', 'SERVICE']).optional(),
      taxable: z.boolean().optional(),
      markup: z.number().optional(),
      internalUnitCost: z.number().optional(),
      durationMinutes: z.number().optional(),
      onlineBookingsEnabled: z.boolean().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateProduct($input: ProductsAndServicesInput!) {
          productsAndServicesCreate(input: $input) {
            productOrService {
              ${PRODUCT_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {
        name: args.name,
        defaultUnitCost: args.defaultUnitCost,
      };
      if (args.description) input.description = args.description;
      if (args.category) input.category = args.category;
      if (args.taxable !== undefined) input.taxable = args.taxable;
      if (args.markup !== undefined) input.markup = args.markup;
      if (args.internalUnitCost !== undefined) input.internalUnitCost = args.internalUnitCost;
      if (args.durationMinutes !== undefined) input.durationMinutes = args.durationMinutes;
      if (args.onlineBookingsEnabled !== undefined) input.onlineBookingsEnabled = args.onlineBookingsEnabled;

      const data = await client.mutate(mutation, { input });

      if (data.productsAndServicesCreate.userErrors?.length > 0) {
        throw new Error(
          `Product creation failed: ${data.productsAndServicesCreate.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { product: data.productsAndServicesCreate.productOrService };
    },
  },

  update_product: {
    description: 'Update an existing product or service',
    inputSchema: z.object({
      productId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      defaultUnitCost: z.number().optional(),
      category: z.enum(['PRODUCT', 'SERVICE']).optional(),
      taxable: z.boolean().optional(),
      markup: z.number().optional(),
      internalUnitCost: z.number().optional(),
      durationMinutes: z.number().optional(),
      onlineBookingsEnabled: z.boolean().optional(),
      visible: z.boolean().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateProduct($productOrServiceId: EncodedId!, $input: ProductsAndServicesEditInput!) {
          productsAndServicesEdit(productOrServiceId: $productOrServiceId, input: $input) {
            productOrService {
              ${PRODUCT_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      if (args.name) input.name = args.name;
      if (args.description) input.description = args.description;
      if (args.defaultUnitCost !== undefined) input.defaultUnitCost = args.defaultUnitCost;
      if (args.category) input.category = args.category;
      if (args.taxable !== undefined) input.taxable = args.taxable;
      if (args.markup !== undefined) input.markup = args.markup;
      if (args.internalUnitCost !== undefined) input.internalUnitCost = args.internalUnitCost;
      if (args.durationMinutes !== undefined) input.durationMinutes = args.durationMinutes;
      if (args.onlineBookingsEnabled !== undefined) input.onlineBookingsEnabled = args.onlineBookingsEnabled;
      if (args.visible !== undefined) input.visible = args.visible;

      const data = await client.mutate(mutation, { productOrServiceId: args.productId, input });

      if (data.productsAndServicesEdit.userErrors?.length > 0) {
        throw new Error(
          `Product update failed: ${data.productsAndServicesEdit.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { product: data.productsAndServicesEdit.productOrService };
    },
  },

  // NOTE: `delete_product` was removed. It previously called a nonexistent
  // `productArchive` mutation. The only product/service mutations in the
  // schema are `productsAndServicesCreate` and `productsAndServicesEdit` —
  // there is no archive/delete/unarchive mutation for `ProductOrService`,
  // and `ProductOrService` has no `isArchived` field to toggle via edit
  // either. If Jobber adds one, reintroduce this tool against it.
};
