/**
 * Clients Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - Mutation signatures are `clientCreate`/`clientEdit`/`clientArchive`; the
 *     edit/archive ID argument is `clientId`, not `id`.
 *   - `ClientCreateInput`/`ClientEditInput` have no scalar `email`/`phone`
 *     field. Emails/phones are lists (`EmailCreateAttributes`/
 *     `PhoneNumberCreateAttributes`) — `emails`/`phones` on create,
 *     `emailsToAdd`/`phonesToAdd` (plus ToEdit/ToDelete) on edit.
 *   - `clients` has no `filter: { search }`; free-text search is the
 *     top-level `searchTerm` argument.
 *   - `Client.properties` is deprecated in favor of `clientProperties`, a
 *     Connection (`nodes { ... }`), and `Property` has no `isDefault` field.
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

export const clientsTools = {
  list_clients: {
    description: 'List all clients with optional filtering',
    inputSchema: z.object({
      isArchived: z.boolean().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.isArchived !== undefined) filter.isArchived = args.isArchived;

      const query = `
        query ListClients($first: Int, $after: String, $filter: ClientFilterAttributes) {
          clients(first: $first, after: $after, filter: $filter) {
            edges {
              node {
                ${JobberClient.clientFields}
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
        clients: data.clients.edges.map((e: any) => e.node),
        pageInfo: data.clients.pageInfo,
        totalCount: data.clients.totalCount,
      };
    },
  },

  get_client: {
    description: 'Get a specific client by ID',
    inputSchema: z.object({
      clientId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetClient($id: EncodedId!) {
          client(id: $id) {
            ${JobberClient.clientFields}
          }
        }
      `;

      const data = await client.query(query, { id: args.clientId });
      return { client: data.client };
    },
  },

  create_client: {
    description:
      'Create a new client. Email and phone, if given, are stored as the primary entry in Jobber’s email/phone lists (there is no scalar email/phone field on the create input).',
    inputSchema: z.object({
      firstName: z.string(),
      lastName: z.string(),
      companyName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      billingAddress: z.object({
        street1: z.string().optional(),
        street2: z.string().optional(),
        city: z.string().optional(),
        province: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
      }).optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateClient($input: ClientCreateInput!) {
          clientCreate(input: $input) {
            client {
              ${JobberClient.clientFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {
        firstName: args.firstName,
        lastName: args.lastName,
      };
      if (args.companyName) input.companyName = args.companyName;
      if (args.email) input.emails = [{ address: args.email, primary: true }];
      if (args.phone) input.phones = [{ number: args.phone, primary: true }];
      if (args.billingAddress) input.billingAddress = args.billingAddress;

      const data = await client.mutate(mutation, { input });

      if (data.clientCreate.userErrors?.length > 0) {
        throw new Error(`Client creation failed: ${data.clientCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { client: data.clientCreate.client };
    },
  },

  update_client: {
    description:
      'Update an existing client. Email and phone, if given, are ADDED to the client’s email/phone lists as a new primary entry — Jobber has no scalar field to overwrite an existing one in place.',
    inputSchema: z.object({
      clientId: z.string(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      companyName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateClient($clientId: EncodedId!, $input: ClientEditInput!) {
          clientEdit(clientId: $clientId, input: $input) {
            client {
              ${JobberClient.clientFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      if (args.firstName) input.firstName = args.firstName;
      if (args.lastName) input.lastName = args.lastName;
      if (args.companyName) input.companyName = args.companyName;
      if (args.email) input.emailsToAdd = [{ address: args.email, primary: true }];
      if (args.phone) input.phonesToAdd = [{ number: args.phone, primary: true }];

      const data = await client.mutate(mutation, { clientId: args.clientId, input });

      if (data.clientEdit.userErrors?.length > 0) {
        throw new Error(`Client update failed: ${data.clientEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { client: data.clientEdit.client };
    },
  },

  archive_client: {
    description: 'Archive a client',
    inputSchema: z.object({
      clientId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation ArchiveClient($clientId: EncodedId!) {
          clientArchive(clientId: $clientId) {
            client {
              ${JobberClient.clientFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { clientId: args.clientId });

      if (data.clientArchive.userErrors?.length > 0) {
        throw new Error(`Client archive failed: ${data.clientArchive.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { client: data.clientArchive.client };
    },
  },

  search_clients: {
    description: 'Search clients by name, email, or company',
    inputSchema: z.object({
      query: z.string().describe('Search query string'),
      limit: z.number().default(50),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query SearchClients($searchTerm: String, $first: Int) {
          clients(searchTerm: $searchTerm, first: $first) {
            edges {
              node {
                ${JobberClient.clientFields}
              }
            }
            totalCount
          }
        }
      `;

      const data = await client.query(query, { searchTerm: args.query, first: args.limit });
      return {
        clients: data.clients.edges.map((e: any) => e.node),
        totalCount: data.clients.totalCount,
      };
    },
  },

  list_client_properties: {
    description: 'List all properties for a specific client',
    inputSchema: z.object({
      clientId: z.string(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetClientProperties($id: EncodedId!, $first: Int, $after: String) {
          client(id: $id) {
            clientProperties(first: $first, after: $after) {
              nodes {
                ${PROPERTY_FIELDS}
              }
              ${PAGE_INFO}
            }
          }
        }
      `;

      const data = await client.query(query, {
        id: args.clientId,
        first: args.limit,
        after: args.cursor,
      });
      return {
        properties: data.client?.clientProperties?.nodes ?? [],
        pageInfo: data.client?.clientProperties?.pageInfo,
        totalCount: data.client?.clientProperties?.totalCount,
      };
    },
  },

  unarchive_client: {
    description: 'Restore a previously archived client',
    inputSchema: z.object({
      clientId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UnarchiveClient($clientId: EncodedId!) {
          clientUnarchive(clientId: $clientId) {
            client {
              ${JobberClient.clientFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { clientId: args.clientId });

      if (data.clientUnarchive.userErrors?.length > 0) {
        throw new Error(
          `Client unarchive failed: ${data.clientUnarchive.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { client: data.clientUnarchive.client };
    },
  },
};
