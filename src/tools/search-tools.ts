/**
 * Search / Schedule / Account Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - `workItemSearch` is NOT a cross-entity global search. `WorkItem` is a
 *     plain object type (not a union/interface) whose fields are all
 *     `@deprecated(reason: "Use ProductOrServiceType instead")`. It only
 *     searches the legacy product/service catalog — it has nothing to do
 *     with jobs, quotes, or clients, and there is no `__typename` to switch
 *     on. It remains wired up here (still callable, still read-only) with a
 *     description that reflects what it actually returns.
 *   - `scheduledItems`' `filter: ScheduledItemsFilterAttributes!` is
 *     non-null, but only one of its fields is itself required:
 *     `occursWithin: DateRange!`. `DateRange` is `{ startAt, endAt }`
 *     (both non-null `ISO8601DateTime`) — NOT `Iso8601DateTimeRangeInput`'s
 *     `{ after, before, eq }` shape used elsewhere in this API. Everything
 *     else on the filter (scheduleItemType, status, assignedTo,
 *     includeUnassigned, includeUnscheduled, schedulingAspects) is optional.
 *   - `ScheduledItemInterfaceConnection` resolves to one of four concrete
 *     types (`Visit`, `Assessment`, `Task`, `Event`) — selected via
 *     `__typename` + inline fragments, per convention.
 *   - `similarClients` is named `search_similar_clients` here rather than
 *     `find_similar_clients` so the server's prefix-based readOnlyHint
 *     (`list_`/`get_`/`search_`) picks it up like the other three tools.
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

/** ScheduledItemType, verbatim. */
const SCHEDULED_ITEM_TYPE = [
  'BASIC_TASK', 'VISIT', 'EVENT', 'ASSESSMENT', 'QUOTE_REMINDER', 'INVOICE_REMINDER',
] as const;

/** ScheduledItemStatus, verbatim. */
const SCHEDULED_ITEM_STATUS = [
  'ACTIVE', 'COMPLETED', 'INCOMPLETE', 'OVERDUE', 'REMAINING',
] as const;

/** SchedulingAspect, verbatim. */
const SCHEDULING_ASPECT = [
  'ALL', 'ASSIGNMENTS', 'UNASSIGNED', 'UNSCHEDULED', 'UNASSIGNED_ONLY',
] as const;

/** ScheduledItemsSortKey, verbatim. */
const SCHEDULED_ITEMS_SORT_KEY = [
  'COMPLETED', 'CREATED_AT', 'CLIENT_NAME', 'VALUE', 'OVERRIDE_ORDER',
] as const;

/** SortDirectionEnum, verbatim. */
const SORT_DIRECTION = ['ASCENDING', 'DESCENDING'] as const;

/**
 * Fields shared by every ScheduledItemInterface implementor, plus the
 * per-type extras that matter for telling a visit from an assessment from a
 * task from an event at a glance.
 */
const SCHEDULED_ITEM_FIELDS = `
  __typename
  id
  title
  startAt
  endAt
  duration
  allDay
  isDefaultTitle
  ... on Visit {
    isComplete
    completedAt
    visitStatus
    client {
      ${JobberClient.clientFields}
    }
    job {
      id
      jobNumber
      title
    }
    property {
      id
    }
  }
  ... on Assessment {
    isComplete
    completedAt
    clientConfirmed
    instructions
    client {
      ${JobberClient.clientFields}
    }
    request {
      id
    }
  }
  ... on Task {
    isComplete
    instructions
    optionalClient: client {
      ${JobberClient.clientFields}
    }
  }
  ... on Event {
    isComplete
    description
    optionalClient: client {
      ${JobberClient.clientFields}
    }
  }
`;

// NOTE: no `search_work_items` tool. `workItemSearch` looked like a global
// cross-entity search, but `WorkItem` is a plain object type whose every field
// is deprecated, and the query itself is marked `@deprecated(reason: "Use
// products instead")`. It searches only the legacy product/service catalog, so
// it would duplicate `search_products` while being deprecated and sounding far
// broader than it is. Jobber exposes NO cross-entity search.
export const searchTools = {
  list_scheduled_items: {
    description:
      'Unified calendar feed of visits, assessments, tasks, and events. The filter is non-null and requires a date range (occursWithin) minimally; startAt/endAt below are that range. Each item carries __typename so callers can tell visits from assessments from tasks from events. By default results are scoped to the authenticated user; use schedulingAspects to broaden.',
    inputSchema: z.object({
      startAt: z.string().describe('ISO 8601 datetime: start of the range to search (occursWithin.startAt)'),
      endAt: z.string().describe('ISO 8601 datetime: end of the range to search (occursWithin.endAt); max 1.5 years after startAt'),
      scheduleItemType: z.enum(SCHEDULED_ITEM_TYPE).optional().describe('Restrict to one kind of scheduled item'),
      status: z.enum(SCHEDULED_ITEM_STATUS).optional(),
      assignedTo: z.array(z.string()).optional().describe('Restrict to items assigned to these user IDs'),
      includeUnassigned: z.boolean().optional().describe('Include unassigned appointments'),
      includeUnscheduled: z.boolean().optional().describe('Include unscheduled appointments'),
      schedulingAspects: z.array(z.enum(SCHEDULING_ASPECT)).optional().describe('Broaden scope beyond the authenticated user (e.g. ALL, UNASSIGNED)'),
      sortKey: z.enum(SCHEDULED_ITEMS_SORT_KEY).optional().describe('Field to sort on; defaults to startAt ascending when omitted'),
      sortDirection: z.enum(SORT_DIRECTION).default('ASCENDING'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query ListScheduledItems(
          $filter: ScheduledItemsFilterAttributes!
          $sort: ScheduledItemsSortInput
          $first: Int
          $after: String
        ) {
          scheduledItems(filter: $filter, sort: $sort, first: $first, after: $after) {
            nodes {
              ${SCHEDULED_ITEM_FIELDS}
            }
            ${PAGE_INFO}
          }
        }
      `;

      const filter: Record<string, unknown> = {
        occursWithin: { startAt: args.startAt, endAt: args.endAt },
      };
      if (args.scheduleItemType) filter.scheduleItemType = args.scheduleItemType;
      if (args.status) filter.status = args.status;
      if (args.assignedTo) filter.assignedTo = args.assignedTo;
      if (args.includeUnassigned !== undefined) filter.includeUnassigned = args.includeUnassigned;
      if (args.includeUnscheduled !== undefined) filter.includeUnscheduled = args.includeUnscheduled;
      if (args.schedulingAspects) filter.schedulingAspects = args.schedulingAspects;

      const sort = args.sortKey ? { key: args.sortKey, direction: args.sortDirection } : undefined;

      const data = await client.query(query, {
        filter,
        sort,
        first: args.limit,
        after: args.cursor,
      });
      return {
        items: data.scheduledItems?.nodes ?? [],
        pageInfo: data.scheduledItems?.pageInfo,
        totalCount: data.scheduledItems?.totalCount,
      };
    },
  },

  get_account: {
    description: 'Get the Jobber account this server is bound to (identity/context: name, industry, region, creation date, enabled features).',
    inputSchema: z.object({}),
    execute: async (client: JobberClient, _args: any) => {
      const query = `
        query GetAccount {
          account {
            id
            name
            industry
            countryCode
            phone
            dedicatedPhoneNumber
            createdAt
            earliestInvoiceIssuedDate
            signupName
            features {
              name
              enabled
              available
              discoverable
            }
          }
        }
      `;

      const data = await client.query(query);
      return { account: data.account };
    },
  },

  search_similar_clients: {
    description:
      'Find clients similar to the given name/company/emails, for duplicate detection before creating a new client. Never returns more than 10 results.',
    inputSchema: z.object({
      name: z.string().optional().describe('The name of the client to compare against'),
      companyName: z.string().optional().describe('The company name of the client to compare against'),
      emails: z.array(z.string()).optional().describe('Email addresses of the client to compare against'),
      limit: z.number().default(10),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query SearchSimilarClients($name: String, $companyName: String, $emails: [String!], $first: Int, $after: String) {
          similarClients(name: $name, companyName: $companyName, emails: $emails, first: $first, after: $after) {
            nodes {
              ${JobberClient.clientFields}
            }
            ${PAGE_INFO}
          }
        }
      `;

      const data = await client.query(query, {
        name: args.name,
        companyName: args.companyName,
        emails: args.emails,
        first: args.limit,
        after: args.cursor,
      });
      return {
        clients: data.similarClients?.nodes ?? [],
        pageInfo: data.similarClients?.pageInfo,
        totalCount: data.similarClients?.totalCount,
      };
    },
  },
};
