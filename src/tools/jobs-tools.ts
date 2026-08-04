/**
 * Jobs Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - Job status enum values are lowercase (`active`, not `ACTIVE`).
 *   - `jobs` has no clientId filter; scope by client via `client { jobs }`.
 *   - `jobClose` requires an explicit decision about incomplete visits.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

/** JobStatusTypeEnum, verbatim. */
const JOB_STATUS = [
  'requires_invoicing', 'archived', 'late', 'today', 'upcoming',
  'action_required', 'on_hold', 'unscheduled', 'active',
  'expiring_within_30_days',
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

/** Split an ISO 8601 instant into Jobber's LocalDateTimeAttributes. */
function toLocalDateTime(iso: string, timezone: string) {
  const [date, rest] = iso.split('T');
  const time = rest ? rest.replace(/(Z|[+-]\d{2}:?\d{2})$/, '') : undefined;
  return { date, time, timezone };
}

export const jobsTools = {
  list_jobs: {
    description:
      'List jobs with optional filtering and pagination. Filtering by client is supported and is routed through the client record, since the jobs query itself has no client filter.',
    inputSchema: z.object({
      status: z.enum(JOB_STATUS).optional(),
      jobType: z.enum(['ONE_OFF', 'RECURRING']).optional(),
      clientId: z.string().optional(),
      searchTerm: z.string().optional(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.status) filter.status = args.status;
      if (args.jobType) filter.jobType = args.jobType;

      // The `jobs` root query cannot filter by client, so scope through the
      // client record when a clientId is supplied.
      if (args.clientId) {
        const query = `
          query ListClientJobs($clientId: EncodedId!, $first: Int, $after: String, $filter: JobFilterAttributes) {
            client(id: $clientId) {
              jobs(first: $first, after: $after, filter: $filter) {
                nodes {
                  ${JobberClient.jobFields}
                }
                ${PAGE_INFO}
              }
            }
          }
        `;
        const data = await client.query(query, {
          clientId: args.clientId,
          first: args.limit,
          after: args.cursor,
          filter,
        });
        return {
          jobs: data.client?.jobs?.nodes ?? [],
          pageInfo: data.client?.jobs?.pageInfo,
          totalCount: data.client?.jobs?.totalCount,
        };
      }

      const query = `
        query ListJobs($first: Int, $after: String, $filter: JobFilterAttributes, $searchTerm: String) {
          jobs(first: $first, after: $after, filter: $filter, searchTerm: $searchTerm) {
            nodes {
              ${JobberClient.jobFields}
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
        jobs: data.jobs.nodes,
        pageInfo: data.jobs.pageInfo,
        totalCount: data.jobs.totalCount,
      };
    },
  },

  get_job: {
    description: 'Get a specific job by ID',
    inputSchema: z.object({
      jobId: z.string().describe('The job ID'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetJob($id: EncodedId!) {
          job(id: $id) {
            ${JobberClient.jobFields}
          }
        }
      `;

      const data = await client.query(query, { id: args.jobId });
      return { job: data.job };
    },
  },

  create_job: {
    description:
      'Create a new job. Jobber derives the client from the property, so propertyId is required and there is no clientId field.',
    inputSchema: z.object({
      propertyId: z.string().describe("The client property the job is for; determines the job's client"),
      title: z.string().optional(),
      instructions: z.string().optional(),
      jobNumber: z.number().optional(),
      quoteId: z.string().optional(),
      requestId: z.string().optional(),
      salespersonId: z.string().optional(),
      // JobCreateAttributes.invoicing is non-null, so Jobber rejects a create
      // without it. Defaulted rather than made required, since these two values
      // are the common case and forcing every caller to supply them is noise.
      invoicingType: z.enum(['FIXED_PRICE', 'VISIT_BASED']).default('FIXED_PRICE'),
      invoicingSchedule: z
        .enum(['ON_COMPLETION', 'PERIODIC', 'PER_VISIT', 'NEVER'])
        .default('ON_COMPLETION'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateJob($input: JobCreateAttributes!) {
          jobCreate(input: $input) {
            job {
              ${JobberClient.jobFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {
        propertyId: args.propertyId,
        invoicing: {
          invoicingType: args.invoicingType,
          invoicingSchedule: args.invoicingSchedule,
        },
      };
      if (args.title) input.title = args.title;
      if (args.instructions) input.instructions = args.instructions;
      if (args.jobNumber) input.jobNumber = args.jobNumber;
      if (args.quoteId) input.quoteId = args.quoteId;
      if (args.requestId) input.requestId = args.requestId;
      if (args.salespersonId) input.salespersonId = args.salespersonId;

      const data = await client.mutate(mutation, { input });

      if (data.jobCreate.userErrors?.length > 0) {
        throw new Error(`Job creation failed: ${data.jobCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { job: data.jobCreate.job };
    },
  },

  update_job: {
    description: 'Update an existing job',
    inputSchema: z.object({
      jobId: z.string(),
      title: z.string().optional(),
      instructions: z.string().optional(),
      jobNumber: z.number().optional(),
      salespersonId: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateJob($jobId: EncodedId!, $input: JobEditInput!) {
          jobEdit(jobId: $jobId, input: $input) {
            job {
              ${JobberClient.jobFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      if (args.title) input.title = args.title;
      if (args.instructions) input.instructions = args.instructions;
      if (args.jobNumber) input.jobNumber = args.jobNumber;
      if (args.salespersonId) input.salespersonId = args.salespersonId;

      const data = await client.mutate(mutation, { jobId: args.jobId, input });

      if (data.jobEdit.userErrors?.length > 0) {
        throw new Error(`Job update failed: ${data.jobEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { job: data.jobEdit.job };
    },
  },

  close_job: {
    description:
      'Close a job. Closing forces a decision about visits that are still incomplete: destroy them all, or keep past ones and destroy future ones.',
    inputSchema: z.object({
      jobId: z.string(),
      modifyIncompleteVisitsBy: z
        .enum(['DESTROY_ALL', 'COMPLETE_PAST_DESTROY_FUTURE'])
        .default('COMPLETE_PAST_DESTROY_FUTURE'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CloseJob($jobId: EncodedId!, $input: JobCloseInput!) {
          jobClose(jobId: $jobId, input: $input) {
            job {
              ${JobberClient.jobFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, {
        jobId: args.jobId,
        input: { modifyIncompleteVisitsBy: args.modifyIncompleteVisitsBy },
      });

      if (data.jobClose.userErrors?.length > 0) {
        throw new Error(`Job close failed: ${data.jobClose.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { job: data.jobClose.job };
    },
  },

  reopen_job: {
    description: 'Reopen a previously closed job',
    inputSchema: z.object({
      jobId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation ReopenJob($jobId: EncodedId!) {
          jobReopen(jobId: $jobId) {
            job {
              ${JobberClient.jobFields}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const data = await client.mutate(mutation, { jobId: args.jobId });

      if (data.jobReopen.userErrors?.length > 0) {
        throw new Error(`Job reopen failed: ${data.jobReopen.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { job: data.jobReopen.job };
    },
  },

  list_job_visits: {
    description: 'List all visits for a specific job',
    inputSchema: z.object({
      jobId: z.string(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetJobVisits($id: EncodedId!, $first: Int, $after: String) {
          job(id: $id) {
            visits(first: $first, after: $after) {
              nodes {
                ${JobberClient.visitFields}
              }
              ${PAGE_INFO}
            }
          }
        }
      `;

      const data = await client.query(query, {
        id: args.jobId,
        first: args.limit,
        after: args.cursor,
      });
      return {
        visits: data.job?.visits?.nodes ?? [],
        pageInfo: data.job?.visits?.pageInfo,
        totalCount: data.job?.visits?.totalCount,
      };
    },
  },

  create_job_visit: {
    description:
      'Create one or more visits on a job. Jobber schedules visits with a local date/time plus timezone rather than a UTC instant.',
    inputSchema: z.object({
      jobId: z.string(),
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

  list_job_line_items: {
    description: 'List all line items for a specific job',
    inputSchema: z.object({
      jobId: z.string(),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetJobLineItems($id: EncodedId!, $first: Int, $after: String) {
          job(id: $id) {
            lineItems(first: $first, after: $after) {
              nodes {
                ${JobberClient.lineItemFields}
              }
              ${PAGE_INFO}
            }
          }
        }
      `;

      const data = await client.query(query, {
        id: args.jobId,
        first: args.limit,
        after: args.cursor,
      });
      return {
        lineItems: data.job?.lineItems?.nodes ?? [],
        pageInfo: data.job?.lineItems?.pageInfo,
        totalCount: data.job?.lineItems?.totalCount,
      };
    },
  },
};
