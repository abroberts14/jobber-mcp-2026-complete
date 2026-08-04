/**
 * Tasks Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - `taskCreate(clientId, propertyId, quoteId, requestId, input)` takes all
 *     four parent associations as OPTIONAL top-level arguments (not inside
 *     `input`, and not a single "parentId"). Jobber allows any combination —
 *     including none, for a free-floating task — rather than requiring
 *     exactly one. `taskEdit`, by contrast, can only re-point `clientId`/
 *     `propertyId` (both live inside `TaskEditInput`); a task's quote/request
 *     attachment is set at creation and isn't editable afterwards.
 *   - Unlike visits/assessments, `TaskCreateInput.startAt`/`endAt` (and
 *     `TaskEditInput`'s) are plain `ISO8601DateTime` scalars, NOT
 *     `LocalDateTimeAttributes` — no timezone wrapping needed here.
 *   - `TaskFilterAttributes.assignedTo` is a single `EncodedId`, not a list —
 *     there's no way to filter by more than one assignee at once.
 *   - `taskDelete(taskIds: [EncodedId!]!, deleteFutureRecurring)` is a batch
 *     mutation (always takes a list) and returns `deletedTasks`, not a
 *     boolean/id.
 *   - The work object a task is attached to (`Task.workObject`) is a union of
 *     `Quote | Request`, distinct from the `client`/`property` fields.
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

/** No shared JobberClient.taskFields fragment exists, so it's local here. */
const TASK_FIELDS = `
  id
  title
  instructions
  isComplete
  isDefaultTitle
  isRecurring
  allDay
  startAt
  endAt
  duration
  overrideOrder
  routingOrder
  teamReminderOffset
  createdBy {
    ${JobberClient.userFields}
  }
  client {
    ${JobberClient.clientFields}
  }
  property {
    id
    name
    address {
      street1
      street2
      city
      province
      postalCode
      country
    }
  }
  recurrenceSchedule {
    calendarRule
    friendly
  }
  assignedUsers {
    nodes {
      ${JobberClient.userFields}
    }
  }
  workObject {
    __typename
    ... on Quote {
      id
      quoteNumber
      title
    }
    ... on Request {
      id
      title
      requestStatus
    }
  }
`;

export const tasksTools = {
  list_tasks: {
    description:
      'List tasks (scheduled items such as client meetings or administrative duties) with optional filtering by assignee/date range, sorting by start date, and pagination.',
    inputSchema: z.object({
      assignedToId: z.string().optional().describe('Filter to tasks assigned to this single user'),
      ids: z.array(z.string()).optional().describe('Filter to specific task IDs'),
      startAfter: z.string().optional().describe('ISO 8601 datetime — lower bound for task startAt'),
      startBefore: z.string().optional().describe('ISO 8601 datetime — upper bound for task startAt'),
      sortDirection: z
        .enum(['ASCENDING', 'DESCENDING'])
        .optional()
        .describe('Sort by start date; omitted means unsorted'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.assignedToId) filter.assignedTo = args.assignedToId;
      if (args.ids) filter.ids = args.ids;
      if (args.startAfter || args.startBefore) {
        filter.startAt = {
          ...(args.startAfter ? { after: args.startAfter } : {}),
          ...(args.startBefore ? { before: args.startBefore } : {}),
        };
      }

      const sort = args.sortDirection
        ? [{ key: 'START_AT', direction: args.sortDirection }]
        : undefined;

      const query = `
        query ListTasks($first: Int, $after: String, $filter: TaskFilterAttributes, $sort: [TaskSortInput!]) {
          tasks(first: $first, after: $after, filter: $filter, sort: $sort) {
            nodes {
              ${TASK_FIELDS}
            }
            ${PAGE_INFO}
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        after: args.cursor,
        filter,
        sort,
      });
      return {
        tasks: data.tasks.nodes,
        pageInfo: data.tasks.pageInfo,
        totalCount: data.tasks.totalCount,
      };
    },
  },

  get_task: {
    description: 'Get a specific task by ID',
    inputSchema: z.object({
      taskId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetTask($id: EncodedId!) {
          task(id: $id) {
            ${TASK_FIELDS}
          }
        }
      `;

      const data = await client.query(query, { id: args.taskId });
      return { task: data.task };
    },
  },

  create_task: {
    description:
      'Create a task. It can optionally attach to a client, property, quote, and/or request — Jobber accepts any combination of these top-level IDs (or none, for a free-floating task) rather than requiring exactly one parent.',
    inputSchema: z.object({
      title: z.string(),
      instructions: z.string().optional(),
      startAt: z.string().optional().describe('ISO 8601 datetime, e.g. 2026-03-01T09:00:00Z'),
      endAt: z.string().optional().describe('ISO 8601 datetime'),
      allDay: z.boolean().optional(),
      assignedToIds: z.array(z.string()).optional().describe('Users/employees to assign to the task'),
      emailAssignments: z.boolean().optional().describe('Whether assigned users are emailed about this task'),
      teamReminderOffset: z.number().optional().describe('Minutes before the task to notify the team'),
      recurrenceRule: z.string().optional().describe('An iCalendar (RRULE) recurrence rule for repeating tasks'),
      clientId: z.string().optional().describe('Attach the task to this client'),
      propertyId: z.string().optional().describe('Attach the task to this property'),
      quoteId: z.string().optional().describe('Attach the task to this quote'),
      requestId: z.string().optional().describe('Attach the task to this request'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateTask($clientId: EncodedId, $propertyId: EncodedId, $quoteId: EncodedId, $requestId: EncodedId, $input: TaskCreateInput!) {
          taskCreate(clientId: $clientId, propertyId: $propertyId, quoteId: $quoteId, requestId: $requestId, input: $input) {
            task {
              ${TASK_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = { title: args.title };
      if (args.instructions) input.instructions = args.instructions;
      if (args.startAt) input.startAt = args.startAt;
      if (args.endAt) input.endAt = args.endAt;
      if (args.allDay !== undefined) input.allDay = args.allDay;
      if (args.assignedToIds) input.assignedTo = args.assignedToIds;
      if (args.emailAssignments !== undefined) input.emailAssignments = args.emailAssignments;
      if (args.teamReminderOffset !== undefined) input.teamReminderOffset = args.teamReminderOffset;
      if (args.recurrenceRule) input.recurrenceRule = args.recurrenceRule;

      const data = await client.mutate(mutation, {
        clientId: args.clientId,
        propertyId: args.propertyId,
        quoteId: args.quoteId,
        requestId: args.requestId,
        input,
      });

      if (data.taskCreate.userErrors?.length > 0) {
        throw new Error(`Task creation failed: ${data.taskCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { task: data.taskCreate.task };
    },
  },

  update_task: {
    description:
      'Update an existing task, including re-pointing its client/property attachment. Use editFutureRecurring to apply the edit to all future instances of a recurring task instead of just this one.',
    inputSchema: z.object({
      taskId: z.string(),
      title: z.string().optional(),
      instructions: z.string().optional(),
      startAt: z.string().optional().describe('ISO 8601 datetime'),
      endAt: z.string().optional().describe('ISO 8601 datetime'),
      allDay: z.boolean().optional(),
      assignedToIds: z.array(z.string()).optional(),
      emailAssignments: z.boolean().optional(),
      teamReminderOffset: z.number().optional(),
      recurrenceRule: z.string().optional(),
      clientId: z.string().optional().describe('Re-point the task to this client'),
      propertyId: z.string().optional().describe('Re-point the task to this property'),
      editFutureRecurring: z
        .boolean()
        .optional()
        .describe('Apply this edit to all future instances of a recurring task, not just this one'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateTask($taskId: EncodedId!, $input: TaskEditInput!) {
          taskEdit(taskId: $taskId, input: $input) {
            task {
              ${TASK_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      if (args.title !== undefined) input.title = args.title;
      if (args.instructions !== undefined) input.instructions = args.instructions;
      if (args.startAt) input.startAt = args.startAt;
      if (args.endAt) input.endAt = args.endAt;
      if (args.allDay !== undefined) input.allDay = args.allDay;
      if (args.assignedToIds) input.assignedTo = args.assignedToIds;
      if (args.emailAssignments !== undefined) input.emailAssignments = args.emailAssignments;
      if (args.teamReminderOffset !== undefined) input.teamReminderOffset = args.teamReminderOffset;
      if (args.recurrenceRule) input.recurrenceRule = args.recurrenceRule;
      if (args.clientId) input.clientId = args.clientId;
      if (args.propertyId) input.propertyId = args.propertyId;
      if (args.editFutureRecurring !== undefined) input.editFutureRecurring = args.editFutureRecurring;

      const data = await client.mutate(mutation, { taskId: args.taskId, input });

      if (data.taskEdit.userErrors?.length > 0) {
        throw new Error(`Task update failed: ${data.taskEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { task: data.taskEdit.task };
    },
  },

  delete_task: {
    description:
      'Delete one or more tasks. Takes a list because taskDelete accepts taskIds in a batch; deleteFutureRecurring also removes all future instances of a recurring task chain.',
    inputSchema: z.object({
      taskIds: z.array(z.string()).min(1),
      deleteFutureRecurring: z.boolean().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation DeleteTasks($taskIds: [EncodedId!]!, $deleteFutureRecurring: Boolean) {
          taskDelete(taskIds: $taskIds, deleteFutureRecurring: $deleteFutureRecurring) {
            deletedTasks {
              id
              title
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, {
        taskIds: args.taskIds,
        deleteFutureRecurring: args.deleteFutureRecurring,
      });

      if (data.taskDelete.userErrors?.length > 0) {
        throw new Error(`Task delete failed: ${data.taskDelete.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { deletedTasks: data.taskDelete.deletedTasks ?? [] };
    },
  },
};
