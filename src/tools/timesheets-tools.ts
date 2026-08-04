/**
 * Timesheets Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. There is NO `timeEntries` /
 * `timeEntry` query and NO `timeEntryCreate` / `timeEntryUpdate` /
 * `timeEntryDelete` mutation. The real queries are `timeSheetEntries`,
 * `timeSheetEntry` (and `timeSheetEntriesByGroup`, not used here), returning
 * `TimeSheetEntry` nodes. There is no timesheet mutation of any kind in the
 * schema — time sheet entries can only be read via the API, never created,
 * edited, deleted, or stopped through this API. Those tools have been
 * deleted rather than faked.
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

/** Fields on TimeSheetEntry, per the ground-truth reference. */
const TIME_SHEET_ENTRY_FIELDS = `
  id
  startAt
  endAt
  duration
  finalDuration
  label
  note
  approved
  payable
  ticking
  labourRate
  timeSheetCategory
  createdAt
  updatedAt
  user {
    id
    name {
      first
      last
      full
    }
  }
  job {
    id
    jobNumber
    title
  }
  client {
    id
    name
  }
  visit {
    id
    title
  }
`;

export const timesheetsTools = {
  list_timesheet_entries: {
    description: 'List time sheet entries with optional filtering and pagination.',
    inputSchema: z.object({
      userId: z.string().optional().describe('EncodedId of the user the entries are assigned to'),
      isApproved: z.boolean().optional(),
      isPayable: z.boolean().optional(),
      ticking: z.boolean().optional().describe('Filter to entries whose timer is currently running'),
      currentUserOnly: z.boolean().optional(),
      startAfter: z.string().optional().describe('ISO 8601 datetime lower bound for startAt'),
      startBefore: z.string().optional().describe('ISO 8601 datetime upper bound for startAt'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.userId) filter.assignedTo = args.userId;
      if (args.isApproved !== undefined) filter.isApproved = args.isApproved;
      if (args.isPayable !== undefined) filter.isPayable = args.isPayable;
      if (args.ticking !== undefined) filter.ticking = args.ticking;
      if (args.currentUserOnly !== undefined) filter.currentUserOnly = args.currentUserOnly;
      if (args.startAfter || args.startBefore) {
        filter.startAt = {
          ...(args.startAfter ? { after: args.startAfter } : {}),
          ...(args.startBefore ? { before: args.startBefore } : {}),
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
        timeSheetEntries: data.timeSheetEntries.nodes,
        pageInfo: data.timeSheetEntries.pageInfo,
        totalCount: data.timeSheetEntries.totalCount,
      };
    },
  },

  get_timesheet_entry: {
    description: 'Get a specific time sheet entry by ID',
    inputSchema: z.object({
      timeSheetEntryId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetTimeSheetEntry($id: EncodedId!) {
          timeSheetEntry(id: $id) {
            ${TIME_SHEET_ENTRY_FIELDS}
          }
        }
      `;

      const data = await client.query(query, { id: args.timeSheetEntryId });
      return { timeSheetEntry: data.timeSheetEntry };
    },
  },

  get_user_timesheet: {
    description:
      'Get a summary of a user\'s time sheet entries over a date range (total tracked hours plus the underlying entries). Reads up to `limit` entries in a single page — pass a smaller date range if a user has more entries than that in the window.',
    inputSchema: z.object({
      userId: z.string().describe('EncodedId of the user'),
      startDate: z.string().describe('ISO 8601 datetime, inclusive lower bound'),
      endDate: z.string().describe('ISO 8601 datetime, inclusive upper bound'),
      limit: z.number().default(250),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetUserTimesheet($userId: EncodedId!, $startDate: ISO8601DateTime!, $endDate: ISO8601DateTime!, $first: Int) {
          timeSheetEntries(
            first: $first
            filter: { assignedTo: $userId, startAt: { after: $startDate, before: $endDate } }
          ) {
            nodes {
              ${TIME_SHEET_ENTRY_FIELDS}
            }
            ${PAGE_INFO}
          }
        }
      `;

      const data = await client.query(query, {
        userId: args.userId,
        startDate: args.startDate,
        endDate: args.endDate,
        first: args.limit,
      });

      const entries = data.timeSheetEntries.nodes;
      const totalSeconds = entries.reduce((sum: number, entry: any) => sum + (entry.finalDuration || 0), 0);

      return {
        userId: args.userId,
        startDate: args.startDate,
        endDate: args.endDate,
        entries,
        totalCount: data.timeSheetEntries.totalCount,
        totalHours: totalSeconds / 3600,
      };
    },
  },
};
