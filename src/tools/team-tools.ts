/**
 * Team Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`; `user(id:)` takes a nullable `EncodedId`.
 *   - `User` has no firstName/lastName/role/isActive — see
 *     `JobberClient.userFields` for the real shape (`name { first last full }`,
 *     `email { raw isValid }`, `status`, etc).
 *   - `UsersFilterAttributes.status` (`UsersStatusFilterEnum`) is required
 *     *within* the filter object and there is no `isActive`, so this tool now
 *     exposes `status` and only sends a filter at all when one is given (the
 *     root `filter` argument itself stays optional).
 *   - The root time-entry query is `timeSheetEntries`, not `timeEntries`, and
 *     `TimeSheetEntriesFilterAttributes` has no `visitId` field — scoping to a
 *     visit goes through `visit(id:) { timeSheetEntries }` instead.
 *   - There is no mutation to create a time sheet entry anywhere in the
 *     schema (no `timeSheetEntryCreate`/`timeEntryCreate` — entries come from
 *     starting/stopping timers, which isn't exposed as a direct create
 *     mutation), so `create_team_time_entry` has been removed; see the note
 *     below.
 *   - Only `userEdit` exists for users — there is no userCreate/userDelete.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

/** UsersStatusFilterEnum, verbatim. */
const USER_STATUS = ['ACTIVATED', 'DEACTIVATED'] as const;

const PAGE_INFO = `
  pageInfo {
    hasNextPage
    endCursor
  }
  totalCount
`;

/** Fields common to a TimeSheetEntry, whether fetched root-level or via a visit. */
const TIME_SHEET_ENTRY_FIELDS = `
  id
  startAt
  endAt
  finalDuration
  note
  user {
    ${JobberClient.userFields}
  }
  job {
    id
    jobNumber
    title
  }
`;

export const teamTools = {
  list_users: {
    description: 'List all users in the organization, optionally filtered by activation status',
    inputSchema: z.object({
      status: z.enum(USER_STATUS).optional().describe('ACTIVATED or DEACTIVATED'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter = args.status ? { status: args.status } : undefined;

      const query = `
        query ListUsers($first: Int, $after: String, $filter: UsersFilterAttributes) {
          users(first: $first, after: $after, filter: $filter) {
            nodes {
              ${JobberClient.userFields}
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
        users: data.users.nodes,
        pageInfo: data.users.pageInfo,
        totalCount: data.users.totalCount,
      };
    },
  },

  get_user: {
    description: 'Get a specific user by ID',
    inputSchema: z.object({
      userId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetUser($id: EncodedId) {
          user(id: $id) {
            ${JobberClient.userFields}
          }
        }
      `;

      const data = await client.query(query, { id: args.userId });
      return { user: data.user };
    },
  },

  list_team_time_entries: {
    description:
      'List time sheet entries. Pass visitId to scope to a single visit (via visit.timeSheetEntries, since the filter has no visitId); otherwise lists from the root timeSheetEntries query, optionally filtered by assigned user and a startAt date range.',
    inputSchema: z.object({
      userId: z.string().optional().describe('Filter to entries assigned to this user'),
      visitId: z.string().optional().describe('List entries for this visit instead of the org-wide query'),
      startDate: z.string().optional().describe('ISO 8601 datetime — lower bound for startAt'),
      endDate: z.string().optional().describe('ISO 8601 datetime — upper bound for startAt'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      if (args.visitId) {
        const query = `
          query GetVisitTimeSheetEntries($id: EncodedId!, $first: Int, $after: String) {
            visit(id: $id) {
              timeSheetEntries(first: $first, after: $after) {
                nodes {
                  ${TIME_SHEET_ENTRY_FIELDS}
                }
                ${PAGE_INFO}
              }
            }
          }
        `;

        const data = await client.query(query, {
          id: args.visitId,
          first: args.limit,
          after: args.cursor,
        });
        return {
          timeEntries: data.visit?.timeSheetEntries?.nodes ?? [],
          pageInfo: data.visit?.timeSheetEntries?.pageInfo,
          totalCount: data.visit?.timeSheetEntries?.totalCount,
        };
      }

      const filter: Record<string, unknown> = {};
      if (args.userId) filter.assignedTo = args.userId;
      if (args.startDate || args.endDate) {
        filter.startAt = {
          after: args.startDate,
          before: args.endDate,
        };
      }

      const query = `
        query ListTimeSheetEntries($first: Int, $after: String, $filter: TimeSheetEntriesFilterAttributes) {
          timeSheetEntries(first: $first, after: $after, filter: $filter) {
            nodes {
              ${TIME_SHEET_ENTRY_FIELDS}
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
        timeEntries: data.timeSheetEntries.nodes,
        pageInfo: data.timeSheetEntries.pageInfo,
        totalCount: data.timeSheetEntries.totalCount,
      };
    },
  },
};
