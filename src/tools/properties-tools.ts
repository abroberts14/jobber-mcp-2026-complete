/**
 * Properties Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - `Property` has no `isDefault` field, and no mutation exists to set a
 *     "default"/primary property or to delete a property — `delete_property`
 *     and `set_default_property` were removed (see below).
 *   - `propertyCreate(clientId: EncodedId!, input: PropertyCreateInput!)`
 *     takes the client as a top-level argument, not inside `input`, and
 *     `input.properties` is a LIST of `PropertyAttributes`.
 *     `PropertyCreatePayload` returns `properties` (plural), not `property`.
 *   - `propertyEdit(propertyId: EncodedId!, input: PropertyEditInput!)` keys
 *     off `propertyId`, not `id`, and its `address` field type
 *     (`ClientAddressUpdateAttributes`) is distinct from the create-side
 *     `AddressAttributes`, though the fields used here overlap exactly.
 *
 * Removed tools (no equivalent mutation exists in the schema):
 *   - delete_property: there is no `propertyDelete`/`propertyArchive`/
 *     `propertyDestroy` mutation.
 *   - set_default_property: `Property.isBillingAddress` is read-only; neither
 *     `PropertyCreateInput`/`PropertyAttributes` nor `PropertyEditInput`/
 *     `PropertyEditAttributes` expose a field to set it.
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

/** No shared JobberClient.propertyFields fragment exists, so it's local here. */
const PROPERTY_FIELDS = `
  id
  name
  isBillingAddress
  address {
    street1
    street2
    city
    province
    postalCode
    country
  }
`;

export const propertiesTools = {
  list_properties: {
    description: 'List all properties with optional filtering',
    inputSchema: z.object({
      clientId: z.string().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.clientId) filter.clientId = args.clientId;

      const query = `
        query ListProperties($first: Int, $after: String, $filter: PropertiesFilterAttributes) {
          properties(first: $first, after: $after, filter: $filter) {
            edges {
              node {
                ${PROPERTY_FIELDS}
                client {
                  id
                  firstName
                  lastName
                  companyName
                }
              }
              cursor
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
        properties: data.properties.edges.map((e: any) => e.node),
        pageInfo: data.properties.pageInfo,
        totalCount: data.properties.totalCount,
      };
    },
  },

  get_property: {
    description: 'Get a specific property by ID',
    inputSchema: z.object({
      propertyId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetProperty($id: EncodedId!) {
          property(id: $id) {
            ${PROPERTY_FIELDS}
            client {
              id
              firstName
              lastName
              companyName
            }
          }
        }
      `;

      const data = await client.query(query, { id: args.propertyId });
      return { property: data.property };
    },
  },

  create_property: {
    description:
      'Create a new property for a client. Returns a `properties` list (Jobber\'s propertyCreate mutation can create several properties in one call, even though this tool only ever sends one).',
    inputSchema: z.object({
      clientId: z.string(),
      name: z.string().optional(),
      street1: z.string(),
      street2: z.string().optional(),
      city: z.string(),
      province: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateProperty($clientId: EncodedId!, $input: PropertyCreateInput!) {
          propertyCreate(clientId: $clientId, input: $input) {
            properties {
              ${PROPERTY_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const propertyAttributes: Record<string, unknown> = {
        address: {
          street1: args.street1,
          street2: args.street2,
          city: args.city,
          province: args.province,
          postalCode: args.postalCode,
          country: args.country,
        },
      };
      if (args.name) propertyAttributes.name = args.name;

      const data = await client.mutate(mutation, {
        clientId: args.clientId,
        input: { properties: [propertyAttributes] },
      });

      if (data.propertyCreate.userErrors?.length > 0) {
        throw new Error(`Property creation failed: ${data.propertyCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { properties: data.propertyCreate.properties };
    },
  },

  update_property: {
    description: 'Update an existing property',
    inputSchema: z.object({
      propertyId: z.string(),
      name: z.string().optional(),
      street1: z.string().optional(),
      street2: z.string().optional(),
      city: z.string().optional(),
      province: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateProperty($propertyId: EncodedId!, $input: PropertyEditInput!) {
          propertyEdit(propertyId: $propertyId, input: $input) {
            property {
              ${PROPERTY_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      if (args.name) input.name = args.name;
      if (args.street1 || args.street2 || args.city || args.province || args.postalCode || args.country) {
        input.address = {
          street1: args.street1,
          street2: args.street2,
          city: args.city,
          province: args.province,
          postalCode: args.postalCode,
          country: args.country,
        };
      }

      const data = await client.mutate(mutation, { propertyId: args.propertyId, input });

      if (data.propertyEdit.userErrors?.length > 0) {
        throw new Error(`Property update failed: ${data.propertyEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { property: data.propertyEdit.property };
    },
  },
};
