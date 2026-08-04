/**
 * Requests Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - `Request` has no `description` and no `status` field — it has
 *     `requestStatus` (lowercase enum values) and a single `salesperson`
 *     (there is no list of "assigned users").
 *   - `requestCreate` requires `clientId`; Jobber does not infer the client.
 *   - `requestEdit` cannot set `requestStatus` directly — status moves via
 *     dedicated mutations (`requestArchive`/`requestUnarchive`; other
 *     transitions happen implicitly through quotes/jobs/assessments).
 *   - There is no `requestConvertToQuote` or `requestConvertToJob` mutation.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

/** RequestStatusTypeEnum, verbatim. */
const REQUEST_STATUS = [
  'new', 'completed', 'converted', 'archived', 'upcoming', 'overdue',
  'unscheduled', 'assessment_completed', 'today', 'needs_approval',
] as const;

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

/** Fields common to a Request, excluding sub-connections. */
const REQUEST_FIELDS = `
  id
  title
  requestStatus
  source
  companyName
  contactName
  email
  phone
  isScheduled
  createdAt
  updatedAt
  client {
    ${JobberClient.clientFields}
  }
  property {
    id
  }
  amounts {
    total
  }
`;

export const requestsTools = {
  list_requests: {
    description:
      'List client requests with optional filtering and pagination. Status values are lowercase (e.g. "new", "converted", "archived") — there is no NEW/IN_PROGRESS/CONVERTED/CLOSED enum.',
    inputSchema: z.object({
      status: z.enum(REQUEST_STATUS).optional(),
      clientId: z.string().optional(),
      searchTerm: z.string().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.clientId) filter.clientId = args.clientId;

      const query = `
        query ListRequests($first: Int, $after: String, $filter: RequestFilterAttributes, $searchTerm: String) {
          requests(first: $first, after: $after, filter: $filter, searchTerm: $searchTerm) {
            nodes {
              ${REQUEST_FIELDS}
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
        requests: data.requests.nodes,
        pageInfo: data.requests.pageInfo,
        totalCount: data.requests.totalCount,
      };
    },
  },

  get_request: {
    description: 'Get a specific request by ID',
    inputSchema: z.object({
      requestId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetRequest($id: EncodedId!) {
          request(id: $id) {
            ${REQUEST_FIELDS}
          }
        }
      `;

      const data = await client.query(query, { id: args.requestId });
      return { request: data.request };
    },
  },

  create_request: {
    description:
      'Create a new client request. clientId is required — Jobber does not derive it from anything else. propertyId defaults to the client\'s last property when omitted.',
    inputSchema: z.object({
      clientId: z.string().describe('The client this request is for'),
      propertyId: z.string().optional(),
      title: z.string().optional(),
      salespersonId: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateRequest($input: RequestCreateInput!) {
          requestCreate(input: $input) {
            request {
              ${REQUEST_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = { clientId: args.clientId };
      if (args.propertyId) input.propertyId = args.propertyId;
      if (args.title) input.title = args.title;
      if (args.salespersonId) input.salespersonId = args.salespersonId;

      const data = await client.mutate(mutation, { input });

      if (data.requestCreate.userErrors?.length > 0) {
        throw new Error(`Request creation failed: ${data.requestCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { request: data.requestCreate.request };
    },
  },

  update_request: {
    description:
      'Update an existing request\'s title, property, or salesperson. Request status cannot be set through this mutation — use archive_request / unarchive_request for status transitions.',
    inputSchema: z.object({
      requestId: z.string(),
      title: z.string().optional(),
      propertyId: z.string().optional(),
      salespersonId: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateRequest($requestId: EncodedId!, $input: RequestEditInput!) {
          requestEdit(requestId: $requestId, input: $input) {
            request {
              ${REQUEST_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      if (args.title) input.title = args.title;
      if (args.propertyId) input.propertyId = args.propertyId;
      if (args.salespersonId) input.salespersonId = args.salespersonId;

      const data = await client.mutate(mutation, { requestId: args.requestId, input });

      if (data.requestEdit.userErrors?.length > 0) {
        throw new Error(`Request update failed: ${data.requestEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { request: data.requestEdit.request };
    },
  },

  archive_request: {
    description: 'Archive a request (sets its status to archived)',
    inputSchema: z.object({
      requestId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation ArchiveRequest($requestId: EncodedId!) {
          requestArchive(requestId: $requestId) {
            request {
              ${REQUEST_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { requestId: args.requestId });

      if (data.requestArchive.userErrors?.length > 0) {
        throw new Error(`Request archive failed: ${data.requestArchive.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { request: data.requestArchive.request };
    },
  },

  unarchive_request: {
    description: 'Unarchive a previously archived request',
    inputSchema: z.object({
      requestId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UnarchiveRequest($requestId: EncodedId!) {
          requestUnarchive(requestId: $requestId) {
            request {
              ${REQUEST_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { requestId: args.requestId });

      if (data.requestUnarchive.userErrors?.length > 0) {
        throw new Error(`Request unarchive failed: ${data.requestUnarchive.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { request: data.requestUnarchive.request };
    },
  },

  assign_request: {
    description:
      'Assign a request to a salesperson. A Request has a single `salesperson`, not a list of assigned users, so this sets (and replaces) that one user.',
    inputSchema: z.object({
      requestId: z.string().describe('The request ID to assign'),
      userId: z.string().describe('The user ID to set as the request salesperson'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation AssignRequest($requestId: EncodedId!, $input: RequestEditInput!) {
          requestEdit(requestId: $requestId, input: $input) {
            request {
              id
              title
              requestStatus
              salesperson {
                ${JobberClient.userFields}
              }
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input = { salespersonId: args.userId };
      const data = await client.mutate(mutation, { requestId: args.requestId, input });

      if (data.requestEdit.userErrors?.length > 0) {
        throw new Error(`Request assignment failed: ${data.requestEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { request: data.requestEdit.request };
    },
  },
};
