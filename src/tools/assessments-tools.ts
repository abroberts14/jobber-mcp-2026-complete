/**
 * Assessments Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - An assessment is Jobber's on-site quoting visit and always hangs off a
 *     Request — `assessmentCreate(requestId: EncodedId!, input)` requires the
 *     parent request, and each request has at most one assessment
 *     (`Request.assessment`, singular, not a list).
 *   - There is NO `assessments` root list query and no
 *     `AssessmentFilterAttributes` anywhere in the schema — only
 *     `assessment(id: EncodedId!)`. The only other way to reach one is via
 *     its parent request (`request(id).assessment`), which requests-tools.ts
 *     already exposes through `get_request`. `list_assessments` was
 *     deliberately NOT built here; see the bottom of this file.
 *   - Scheduling uses `ScheduledItemAttributes` /
 *     `LocalDateTimeAttributes` (local date + time + timezone), same as a
 *     visit — NOT a bare UTC instant, and NOT the plain `ISO8601DateTime`
 *     scalar that tasks-tools.ts uses for tasks.
 *   - `assessmentCreate`/`assessmentEdit`/`assessmentDelete` all return the
 *     related `request` alongside the assessment; `assessmentComplete`/
 *     `assessmentUncomplete` do not (their payload is just
 *     `{ assessment, userErrors }`).
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

const USER_ERRORS = `
  userErrors {
    message
    path
  }
`;

/** No shared JobberClient.assessmentFields fragment exists, so it's local here. */
const ASSESSMENT_FIELDS = `
  id
  title
  instructions
  allDay
  startAt
  endAt
  duration
  isComplete
  isDefaultTitle
  clientConfirmed
  completedAt
  incompleteChecklistsCount
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
  assignedUsers {
    nodes {
      ${JobberClient.userFields}
    }
  }
`;

/** Fields for the parent Request, kept shallow to avoid over-fetching. */
const REQUEST_SUMMARY_FIELDS = `
  id
  title
  requestStatus
`;

/** Split an ISO 8601 instant into Jobber's LocalDateTimeAttributes. */
function toLocalDateTime(iso: string, timezone: string) {
  const [date, rest] = iso.split('T');
  const time = rest ? rest.replace(/(Z|[+-]\d{2}:?\d{2})$/, '') : undefined;
  return { date, time, timezone };
}

export const assessmentsTools = {
  get_assessment: {
    description:
      'Get a specific assessment (on-site quoting visit) by ID, including the parent request it belongs to. There is no assessments list query — use this by ID, or read request.assessment via get_request.',
    inputSchema: z.object({
      assessmentId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetAssessment($id: EncodedId!) {
          assessment(id: $id) {
            ${ASSESSMENT_FIELDS}
            request {
              ${REQUEST_SUMMARY_FIELDS}
            }
          }
        }
      `;

      const data = await client.query(query, { id: args.assessmentId });
      return { assessment: data.assessment };
    },
  },

  create_assessment: {
    description:
      'Create an assessment (on-site quoting visit) on a request. requestId is required — an assessment always belongs to exactly one request. Scheduling uses a local date/time plus timezone, like a visit.',
    inputSchema: z.object({
      requestId: z.string(),
      instructions: z.string().optional(),
      startAt: z.string().optional().describe('ISO 8601 datetime, e.g. 2026-03-01T09:00:00'),
      endAt: z.string().optional().describe('ISO 8601 datetime'),
      timezone: z.string().default('UTC').describe('IANA timezone, e.g. America/Denver'),
      assignedUserIds: z.array(z.string()).optional(),
      notifyTeam: z.boolean().optional(),
      teamReminderOffset: z.number().optional().describe('Minutes before the assessment to notify the team'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateAssessment($requestId: EncodedId!, $input: AssessmentCreateInput!) {
          assessmentCreate(requestId: $requestId, input: $input) {
            assessment {
              ${ASSESSMENT_FIELDS}
            }
            request {
              ${REQUEST_SUMMARY_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const schedule: Record<string, unknown> = {};
      if (args.startAt) schedule.startAt = toLocalDateTime(args.startAt, args.timezone);
      if (args.endAt) schedule.endAt = toLocalDateTime(args.endAt, args.timezone);
      if (args.assignedUserIds) schedule.teamMemberIdsToAssign = args.assignedUserIds;
      if (args.notifyTeam !== undefined) schedule.notifyTeam = args.notifyTeam;
      if (args.teamReminderOffset !== undefined) schedule.teamReminderOffset = args.teamReminderOffset;

      const input: Record<string, unknown> = {};
      if (args.instructions) input.instructions = args.instructions;
      if (Object.keys(schedule).length > 0) input.schedule = schedule;

      const data = await client.mutate(mutation, { requestId: args.requestId, input });

      if (data.assessmentCreate.userErrors?.length > 0) {
        throw new Error(
          `Assessment creation failed: ${data.assessmentCreate.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { assessment: data.assessmentCreate.assessment, request: data.assessmentCreate.request };
    },
  },

  update_assessment: {
    description:
      'Update an assessment: its title, instructions, or schedule (local date/time plus timezone).',
    inputSchema: z.object({
      assessmentId: z.string(),
      title: z.string().optional(),
      instructions: z.string().optional(),
      startAt: z.string().optional().describe('ISO 8601 datetime'),
      endAt: z.string().optional().describe('ISO 8601 datetime'),
      timezone: z.string().default('UTC').describe('IANA timezone, used only when rescheduling'),
      assignedUserIds: z.array(z.string()).optional(),
      notifyTeam: z.boolean().optional(),
      teamReminderOffset: z.number().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateAssessment($assessmentId: EncodedId!, $input: AssessmentEditInput!) {
          assessmentEdit(assessmentId: $assessmentId, input: $input) {
            assessment {
              ${ASSESSMENT_FIELDS}
            }
            request {
              ${REQUEST_SUMMARY_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const schedule: Record<string, unknown> = {};
      if (args.startAt) schedule.startAt = toLocalDateTime(args.startAt, args.timezone);
      if (args.endAt) schedule.endAt = toLocalDateTime(args.endAt, args.timezone);
      if (args.assignedUserIds) schedule.teamMemberIdsToAssign = args.assignedUserIds;
      if (args.notifyTeam !== undefined) schedule.notifyTeam = args.notifyTeam;
      if (args.teamReminderOffset !== undefined) schedule.teamReminderOffset = args.teamReminderOffset;

      const input: Record<string, unknown> = {};
      if (args.title !== undefined) input.title = args.title;
      if (args.instructions !== undefined) input.instructions = args.instructions;
      if (Object.keys(schedule).length > 0) input.schedule = schedule;

      const data = await client.mutate(mutation, { assessmentId: args.assessmentId, input });

      if (data.assessmentEdit.userErrors?.length > 0) {
        throw new Error(
          `Assessment update failed: ${data.assessmentEdit.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { assessment: data.assessmentEdit.assessment, request: data.assessmentEdit.request };
    },
  },

  complete_assessment: {
    description: 'Mark an assessment as completed',
    inputSchema: z.object({
      assessmentId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CompleteAssessment($assessmentId: EncodedId!) {
          assessmentComplete(assessmentId: $assessmentId) {
            assessment {
              ${ASSESSMENT_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { assessmentId: args.assessmentId });

      if (data.assessmentComplete.userErrors?.length > 0) {
        throw new Error(
          `Assessment completion failed: ${data.assessmentComplete.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { assessment: data.assessmentComplete.assessment };
    },
  },

  uncomplete_assessment: {
    description: 'Mark a completed assessment as not complete',
    inputSchema: z.object({
      assessmentId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UncompleteAssessment($assessmentId: EncodedId!) {
          assessmentUncomplete(assessmentId: $assessmentId) {
            assessment {
              ${ASSESSMENT_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { assessmentId: args.assessmentId });

      if (data.assessmentUncomplete.userErrors?.length > 0) {
        throw new Error(
          `Assessment uncomplete failed: ${data.assessmentUncomplete.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return { assessment: data.assessmentUncomplete.assessment };
    },
  },

  delete_assessment: {
    description: 'Delete an assessment from its request',
    inputSchema: z.object({
      assessmentId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation DeleteAssessment($assessmentId: EncodedId!) {
          assessmentDelete(assessmentId: $assessmentId) {
            deletedAssessment {
              id
              title
            }
            request {
              ${REQUEST_SUMMARY_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { assessmentId: args.assessmentId });

      if (data.assessmentDelete.userErrors?.length > 0) {
        throw new Error(
          `Assessment delete failed: ${data.assessmentDelete.userErrors.map((e: any) => e.message).join(', ')}`
        );
      }

      return {
        deletedAssessment: data.assessmentDelete.deletedAssessment,
        request: data.assessmentDelete.request,
      };
    },
  },

  // Not built: `list_assessments`. There is no `assessments` root query and
  // no `AssessmentFilterAttributes` in the schema (confirmed by grepping the
  // SDL and introspection) — the only query-level entry point is
  // `assessment(id: EncodedId!)`. Each request carries at most one assessment
  // (`Request.assessment`), so bulk discovery goes through `list_requests`/
  // `get_request` (requests-tools.ts) rather than a dedicated listing here.
};
