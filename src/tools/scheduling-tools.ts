/**
 * Scheduling Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - `visitCreate` takes a required `jobId` — a visit can't be created
 *     without a job, so `jobId` is now a required input (was optional).
 *   - `visitEdit` (title/instructions) and `visitEditSchedule` (start/end) are
 *     two separate mutations with different argument names — there is no
 *     single mutation that updates both. `VisitEditAttributes` has no
 *     start/end/notes fields at all.
 *   - `visitComplete`'s argument is `visitId`, not `id`.
 *   - `assignedUsers` on Visit is a `UserConnection`, so it needs
 *     `assignedUsers { nodes { ... } }`, not direct field selection.
 *   - `VisitFilterAttributes` uses `startAt`/`endAt`
 *     (`Iso8601DateTimeRangeInput` = `{ after, before, eq }`), not
 *     `startDate`/`endDate` with gte/lte.
 *   - `VisitStatusTypeEnum` is ACTIVE/COMPLETED/LATE/TODAY/UNSCHEDULED/UPCOMING
 *     — not the UNSCHEDULED/SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED set this
 *     file used to declare.
 *   - `updateFutureVisits(input: UpdateFutureVisitsInput!)` bulk-edits future
 *     visits on a recurring job by propagating a reference visit's settings
 *     forward; it queues an async job and its payload is just
 *     `{ success, userErrors }` — no visit list comes back.
 *   - `onMyWayTrackingLinkCreate(visitId, input)` does NOT generate a tracking
 *     URL — `OnMyWayTrackingLinkCreateInput.onMyWayTrackingLink` is a `Url!`
 *     the caller supplies (e.g. from a fleet/dispatch provider). Jobber just
 *     attaches that link to the visit for the client to see.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

/** VisitStatusTypeEnum, verbatim. */
const VISIT_STATUS = ['ACTIVE', 'COMPLETED', 'LATE', 'TODAY', 'UNSCHEDULED', 'UPCOMING'] as const;

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

/** Split an ISO 8601 instant into Jobber's LocalDateTimeAttributes. */
function toLocalDateTime(iso: string, timezone: string) {
  const [date, rest] = iso.split('T');
  const time = rest ? rest.replace(/(Z|[+-]\d{2}:?\d{2})$/, '') : undefined;
  return { date, time, timezone };
}

export const schedulingTools = {
  list_visits: {
    description: 'List all visits with optional date-range and status filtering',
    inputSchema: z.object({
      startDate: z.string().optional().describe('ISO 8601 datetime — lower bound for visit startAt'),
      endDate: z.string().optional().describe('ISO 8601 datetime — upper bound for visit startAt'),
      status: z.enum(VISIT_STATUS).optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.startDate || args.endDate) {
        filter.startAt = {
          after: args.startDate,
          before: args.endDate,
        };
      }

      const query = `
        query ListVisits($first: Int, $after: String, $filter: VisitFilterAttributes) {
          visits(first: $first, after: $after, filter: $filter) {
            nodes {
              ${JobberClient.visitFields}
              job {
                id
                jobNumber
                title
              }
              assignedUsers {
                nodes {
                  ${JobberClient.userFields}
                }
              }
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
        visits: data.visits.nodes,
        pageInfo: data.visits.pageInfo,
        totalCount: data.visits.totalCount,
      };
    },
  },

  get_visit: {
    description: 'Get a specific visit by ID',
    inputSchema: z.object({
      visitId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetVisit($id: EncodedId!) {
          visit(id: $id) {
            ${JobberClient.visitFields}
            job {
              id
              jobNumber
              title
            }
            assignedUsers {
              nodes {
                ${JobberClient.userFields}
              }
            }
          }
        }
      `;

      const data = await client.query(query, { id: args.visitId });
      return { visit: data.visit };
    },
  },

  create_visit: {
    description:
      'Create a new visit on a job. Every visit belongs to a job (jobId is required), and Jobber schedules it with a local date/time plus timezone rather than a bare UTC instant.',
    inputSchema: z.object({
      jobId: z.string().describe('The job to create the visit on'),
      title: z.string().optional(),
      instructions: z.string().optional(),
      startAt: z.string().describe('ISO 8601 datetime, e.g. 2026-03-01T09:00:00'),
      endAt: z.string().optional().describe('ISO 8601 datetime'),
      timezone: z.string().default('UTC').describe('IANA timezone, e.g. America/Denver'),
      assignedUserIds: z.array(z.string()).optional(),
      notifyTeam: z.boolean().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateVisit($jobId: EncodedId!, $input: VisitCreateInput!) {
          visitCreate(jobId: $jobId, input: $input) {
            createdVisits {
              ${JobberClient.visitFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const schedule: Record<string, unknown> = {
        startAt: toLocalDateTime(args.startAt, args.timezone),
      };
      if (args.endAt) schedule.endAt = toLocalDateTime(args.endAt, args.timezone);
      if (args.assignedUserIds) schedule.teamMemberIdsToAssign = args.assignedUserIds;
      if (args.notifyTeam !== undefined) schedule.notifyTeam = args.notifyTeam;

      const visit: Record<string, unknown> = { schedule };
      if (args.title) visit.title = args.title;
      if (args.instructions) visit.instructions = args.instructions;

      const data = await client.mutate(mutation, {
        jobId: args.jobId,
        input: { visits: [visit] },
      });

      if (data.visitCreate.userErrors?.length > 0) {
        throw new Error(`Visit creation failed: ${data.visitCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { visits: data.visitCreate.createdVisits };
    },
  },

  update_visit: {
    description:
      'Update an existing visit. Title/instructions go through visitEdit; a start/end reschedule goes through the separate visitEditSchedule mutation, since VisitEditAttributes carries no schedule fields.',
    inputSchema: z.object({
      visitId: z.string(),
      title: z.string().optional(),
      instructions: z.string().optional(),
      startAt: z.string().optional().describe('ISO 8601 datetime'),
      endAt: z.string().optional().describe('ISO 8601 datetime'),
      timezone: z.string().default('UTC').describe('IANA timezone, used only when rescheduling'),
    }),
    execute: async (client: JobberClient, args: any) => {
      let visit: any;

      if (args.title !== undefined || args.instructions !== undefined) {
        const mutation = `
          mutation UpdateVisit($id: EncodedId!, $attributes: VisitEditAttributes!) {
            visitEdit(id: $id, attributes: $attributes) {
              visit {
                ${JobberClient.visitFields}
              }
              ${USER_ERRORS}
            }
          }
        `;

        const attributes: Record<string, unknown> = {};
        if (args.title !== undefined) attributes.title = args.title;
        if (args.instructions !== undefined) attributes.instructions = args.instructions;

        const data = await client.mutate(mutation, { id: args.visitId, attributes });

        if (data.visitEdit.userErrors?.length > 0) {
          throw new Error(`Visit update failed: ${data.visitEdit.userErrors.map((e: any) => e.message).join(', ')}`);
        }
        visit = data.visitEdit.visit;
      }

      if (args.startAt || args.endAt) {
        const mutation = `
          mutation RescheduleVisit($id: EncodedId!, $input: VisitEditScheduleInput!) {
            visitEditSchedule(id: $id, input: $input) {
              visit {
                ${JobberClient.visitFields}
              }
              ${USER_ERRORS}
            }
          }
        `;

        const input: Record<string, unknown> = {};
        if (args.startAt) input.startAt = toLocalDateTime(args.startAt, args.timezone);
        if (args.endAt) input.endAt = toLocalDateTime(args.endAt, args.timezone);

        const data = await client.mutate(mutation, { id: args.visitId, input });

        if (data.visitEditSchedule.userErrors?.length > 0) {
          throw new Error(`Visit reschedule failed: ${data.visitEditSchedule.userErrors.map((e: any) => e.message).join(', ')}`);
        }
        visit = data.visitEditSchedule.visit;
      }

      return { visit };
    },
  },

  complete_visit: {
    description: 'Mark a visit as completed',
    inputSchema: z.object({
      visitId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CompleteVisit($visitId: EncodedId!) {
          visitComplete(visitId: $visitId) {
            visit {
              ${JobberClient.visitFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { visitId: args.visitId });

      if (data.visitComplete.userErrors?.length > 0) {
        throw new Error(`Visit completion failed: ${data.visitComplete.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { visit: data.visitComplete.visit };
    },
  },

  list_visit_assignments: {
    description: 'List all user assignments for a specific visit',
    inputSchema: z.object({
      visitId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetVisitAssignments($id: EncodedId!) {
          visit(id: $id) {
            assignedUsers {
              nodes {
                ${JobberClient.userFields}
              }
            }
          }
        }
      `;

      const data = await client.query(query, { id: args.visitId });
      return { assignedUsers: data.visit?.assignedUsers?.nodes ?? [] };
    },
  },

  uncomplete_visit: {
    description: 'Mark a completed visit as not complete',
    inputSchema: z.object({
      visitId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UncompleteVisit($visitId: EncodedId!) {
          visitUncomplete(visitId: $visitId) {
            visit {
              ${JobberClient.visitFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { visitId: args.visitId });

      if (data.visitUncomplete.userErrors?.length > 0) {
        throw new Error(
          `Visit uncomplete failed: ${data.visitUncomplete.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { visit: data.visitUncomplete.visit };
    },
  },

  delete_visits: {
    description:
      'Delete one or more visits. Takes a list because Jobber deletes visits in batches (visitDelete accepts visitIds).',
    inputSchema: z.object({
      visitIds: z.array(z.string()).min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation DeleteVisits($visitIds: [EncodedId!]!) {
          visitDelete(visitIds: $visitIds) {
            visits {
              id
              title
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { visitIds: args.visitIds });

      if (data.visitDelete.userErrors?.length > 0) {
        throw new Error(`Visit delete failed: ${data.visitDelete.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { deletedVisits: data.visitDelete.visits ?? [] };
    },
  },

  assign_visit_users: {
    description:
      'Set the team members assigned to a visit. This replaces the full assignment list rather than adding to it.',
    inputSchema: z.object({
      visitId: z.string(),
      assignedUserIds: z.array(z.string()).describe('Full replacement list; pass [] to unassign everyone'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation AssignVisitUsers($visitId: EncodedId!, $input: VisitEditAssignedUsersInput!) {
          visitEditAssignedUsers(visitId: $visitId, input: $input) {
            visit {
              ${JobberClient.visitFields}
              assignedUsers {
                nodes {
                  ${JobberClient.userFields}
                }
              }
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, {
        visitId: args.visitId,
        input: { assignedUserIds: args.assignedUserIds },
      });

      if (data.visitEditAssignedUsers.userErrors?.length > 0) {
        throw new Error(
          `Visit assignment failed: ${data.visitEditAssignedUsers.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { visit: data.visitEditAssignedUsers.visit };
    },
  },

  update_future_visits: {
    description:
      'Bulk-edit future visits on a recurring job by propagating settings forward from a reference visit. This queues an async operation — the response only reports whether it was successfully queued, not the resulting visits. copyOptions controls what gets copied (time, team assignment, quantity overrides); dispatchRecurrenceRule (an iCalendar RRULE) changes the recurrence pattern going forward, and if omitted the existing visit dates are kept.',
    inputSchema: z.object({
      visitId: z.string().describe("Reference visit whose settings are propagated to future visits in its recurring chain"),
      copyTime: z.boolean().optional().describe("Copy the reference visit's time settings forward"),
      copyAssignment: z.boolean().optional().describe("Copy the reference visit's team assignment forward"),
      copyOverride: z.boolean().optional().describe("Copy the reference visit's quantity overrides forward"),
      dispatchRecurrenceRule: z
        .string()
        .optional()
        .describe('An iCalendar RRULE controlling how future visits are scheduled going forward'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateFutureVisits($input: UpdateFutureVisitsInput!) {
          updateFutureVisits(input: $input) {
            success
            ${USER_ERRORS}
          }
        }
      `;

      const copyOptions: Record<string, unknown> = {};
      if (args.copyTime !== undefined) copyOptions.time = args.copyTime;
      if (args.copyAssignment !== undefined) copyOptions.assignment = args.copyAssignment;
      if (args.copyOverride !== undefined) copyOptions.override = args.copyOverride;

      const input: Record<string, unknown> = { visitId: args.visitId };
      if (Object.keys(copyOptions).length > 0) input.copyOptions = copyOptions;
      if (args.dispatchRecurrenceRule) input.dispatchRecurrenceRule = args.dispatchRecurrenceRule;

      const data = await client.mutate(mutation, { input });

      if (data.updateFutureVisits.userErrors?.length > 0) {
        throw new Error(
          `Future visit update failed: ${data.updateFutureVisits.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { success: data.updateFutureVisits.success };
    },
  },

  create_on_my_way_link: {
    description:
      'Attach a customer-facing "on my way" arrival tracking link to a visit. The tracking URL itself is supplied by the caller (e.g. from a fleet/dispatch tracking provider) — Jobber does not generate the URL, it just associates an existing one with the visit for the client to view.',
    inputSchema: z.object({
      visitId: z.string(),
      trackingLink: z.string().describe('The URL of the tracking link to attach to this visit'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateOnMyWayLink($visitId: EncodedId!, $input: OnMyWayTrackingLinkCreateInput!) {
          onMyWayTrackingLinkCreate(visitId: $visitId, input: $input) {
            onMyWayTrackingLink {
              trackingLink
              vehicle {
                id
                name
                make
                model
                licensePlate
              }
              visit {
                ${JobberClient.visitFields}
              }
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, {
        visitId: args.visitId,
        input: { onMyWayTrackingLink: args.trackingLink },
      });

      if (data.onMyWayTrackingLinkCreate.userErrors?.length > 0) {
        throw new Error(
          `On-my-way link creation failed: ${data.onMyWayTrackingLinkCreate.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { onMyWayTrackingLink: data.onMyWayTrackingLinkCreate.onMyWayTrackingLink };
    },
  },
};
