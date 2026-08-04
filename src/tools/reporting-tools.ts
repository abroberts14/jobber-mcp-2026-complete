/**
 * Reporting Tools for Jobber MCP Server
 *
 * There is NO `reports` root query in the Jobber GraphQL API — every tool
 * here is a client-side aggregation over a real, filterable query (`jobs`,
 * `invoices`, `timeSheetEntries`, `clients`), computing totals in
 * TypeScript from the returned nodes. Each report is therefore bounded by
 * `limit` (the page it fetches); `truncated`/`totalCount` fields on the
 * response tell the caller whether more records exist than were summed.
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from
 * a naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - Money fields are plain `Float`, never `{ amount currency }`.
 *   - Date ranges are `Iso8601DateTimeRangeInput` = `{ before, after, eq }`,
 *     not `gte`/`lte`.
 *   - `JobStatusTypeEnum` has no COMPLETED or CANCELLED value.
 *   - `Job.jobCosting` already carries Jobber's own revenue/cost/profit
 *     computation per job, so the profit report sums that rather than
 *     reinventing it from line items and expenses.
 *   - Jobber has no "billable hours" concept; `TimeSheetEntry.payable` (time
 *     flagged for pay) is used as the closest available proxy.
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

/** JobStatusTypeEnum, verbatim — used to break the job report down by status. */
const JOB_STATUSES = [
  'requires_invoicing', 'archived', 'late', 'today', 'upcoming',
  'action_required', 'on_hold', 'unscheduled', 'active',
  'expiring_within_30_days',
] as const;

export const reportingTools = {
  get_revenue_report: {
    description:
      'Revenue report for a date range. Computed by summing amounts across invoices whose issuedDate falls in range — there is no reports API, so this aggregates the invoices query client-side and is capped at `limit` invoices.',
    inputSchema: z.object({
      startDate: z.string().describe('ISO 8601 datetime, inclusive lower bound on issuedDate'),
      endDate: z.string().describe('ISO 8601 datetime, inclusive upper bound on issuedDate'),
      limit: z.number().default(200).describe('Max invoices to aggregate over'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query RevenueReportInvoices($first: Int, $filter: InvoiceFilterAttributes) {
          invoices(first: $first, filter: $filter) {
            totalCount
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              invoiceStatus
              issuedDate
              amounts {
                total
                paymentsTotal
                invoiceBalance
              }
            }
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        filter: {
          issuedDate: { after: args.startDate, before: args.endDate },
        },
      });

      const nodes = data.invoices?.nodes ?? [];
      const totals = nodes.reduce(
        (acc: any, inv: any) => {
          acc.totalInvoiced += inv.amounts?.total ?? 0;
          acc.totalPaid += inv.amounts?.paymentsTotal ?? 0;
          acc.totalOutstanding += inv.amounts?.invoiceBalance ?? 0;
          if (inv.invoiceStatus === 'voided') acc.voidedCount += 1;
          return acc;
        },
        { totalInvoiced: 0, totalPaid: 0, totalOutstanding: 0, voidedCount: 0 }
      );

      return {
        revenueReport: {
          startDate: args.startDate,
          endDate: args.endDate,
          invoiceCountAggregated: nodes.length,
          totalInvoiceCountInRange: data.invoices?.totalCount ?? nodes.length,
          truncated: data.invoices?.pageInfo?.hasNextPage ?? false,
          ...totals,
        },
      };
    },
  },

  get_job_profit_report: {
    description:
      'Job profitability report for a date range. Sums the per-job `jobCosting` figures Jobber already computes (revenue, cost, profit) across jobs created in range — there is no reports API, so this is a client-side aggregation capped at `limit` jobs.',
    inputSchema: z.object({
      startDate: z.string().describe('ISO 8601 datetime, inclusive lower bound on job createdAt'),
      endDate: z.string().describe('ISO 8601 datetime, inclusive upper bound on job createdAt'),
      limit: z.number().default(200).describe('Max jobs to aggregate over'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetJobProfitReport($first: Int, $filter: JobFilterAttributes) {
          jobs(first: $first, filter: $filter) {
            totalCount
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              jobNumber
              title
              jobCosting {
                totalRevenue
                totalCost
                profitAmount
                profitPercentage
                expenseCost
                labourCost
                lineItemCost
              }
            }
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        filter: { createdAt: { after: args.startDate, before: args.endDate } },
      });

      const nodes = data.jobs?.nodes ?? [];
      const totals = nodes.reduce(
        (acc: any, job: any) => {
          const costing = job.jobCosting;
          if (!costing) return acc;
          acc.totalRevenue += costing.totalRevenue ?? 0;
          acc.totalCosts += costing.totalCost ?? 0;
          acc.totalProfit += costing.profitAmount ?? 0;
          return acc;
        },
        { totalRevenue: 0, totalCosts: 0, totalProfit: 0 }
      );

      return {
        jobProfitReport: {
          startDate: args.startDate,
          endDate: args.endDate,
          jobCountAggregated: nodes.length,
          totalJobCountInRange: data.jobs?.totalCount ?? nodes.length,
          truncated: data.jobs?.pageInfo?.hasNextPage ?? false,
          ...totals,
          profitMargin: totals.totalRevenue > 0 ? totals.totalProfit / totals.totalRevenue : null,
          jobBreakdown: nodes.map((job: any) => ({
            jobId: job.id,
            jobNumber: job.jobNumber,
            title: job.title,
            revenue: job.jobCosting?.totalRevenue ?? 0,
            costs: job.jobCosting?.totalCost ?? 0,
            profit: job.jobCosting?.profitAmount ?? 0,
            margin: job.jobCosting?.profitPercentage ?? null,
          })),
        },
      };
    },
  },

  get_team_utilization_report: {
    description:
      'Team time-tracking report for a date range, aggregated client-side from timeSheetEntries whose startAt falls in range. Jobber has no "billable hours" concept in the API — `payable` hours (time flagged for pay) are reported as the closest available proxy for billable hours. Capped at `limit` entries.',
    inputSchema: z.object({
      startDate: z.string().describe('ISO 8601 datetime, inclusive lower bound on entry startAt'),
      endDate: z.string().describe('ISO 8601 datetime, inclusive upper bound on entry startAt'),
      limit: z.number().default(250).describe('Max time sheet entries to aggregate over'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetTeamUtilizationReport($first: Int, $filter: TimeSheetEntriesFilterAttributes) {
          timeSheetEntries(first: $first, filter: $filter) {
            totalCount
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              finalDuration
              payable
              user {
                id
                name {
                  first
                  last
                  full
                }
              }
            }
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        filter: { startAt: { after: args.startDate, before: args.endDate } },
      });

      const nodes = data.timeSheetEntries?.nodes ?? [];
      const byUser = new Map<string, { userId: string; name: string; totalSeconds: number; payableSeconds: number; nonPayableSeconds: number }>();

      for (const entry of nodes) {
        const userId = entry.user?.id ?? 'unknown';
        if (!byUser.has(userId)) {
          byUser.set(userId, {
            userId,
            name: entry.user?.name?.full ?? 'Unknown',
            totalSeconds: 0,
            payableSeconds: 0,
            nonPayableSeconds: 0,
          });
        }
        const bucket = byUser.get(userId)!;
        const seconds = entry.finalDuration ?? 0;
        bucket.totalSeconds += seconds;
        if (entry.payable) bucket.payableSeconds += seconds;
        else bucket.nonPayableSeconds += seconds;
      }

      const userBreakdown = Array.from(byUser.values()).map((u) => ({
        userId: u.userId,
        name: u.name,
        totalHours: u.totalSeconds / 3600,
        payableHours: u.payableSeconds / 3600,
        nonPayableHours: u.nonPayableSeconds / 3600,
      }));

      const totals = userBreakdown.reduce(
        (acc, u) => {
          acc.totalHours += u.totalHours;
          acc.payableHours += u.payableHours;
          acc.nonPayableHours += u.nonPayableHours;
          return acc;
        },
        { totalHours: 0, payableHours: 0, nonPayableHours: 0 }
      );

      return {
        utilizationReport: {
          startDate: args.startDate,
          endDate: args.endDate,
          entriesAggregated: nodes.length,
          totalEntryCountInRange: data.timeSheetEntries?.totalCount ?? nodes.length,
          truncated: data.timeSheetEntries?.pageInfo?.hasNextPage ?? false,
          ...totals,
          userBreakdown,
        },
      };
    },
  },

  get_job_report: {
    description:
      'Job counts for a date range, broken down by current JobStatusTypeEnum value (active, archived, unscheduled, etc). There is no reports API, and Jobber has no "completed"/"cancelled" job status — this counts jobs created in range per real status via the jobs query.',
    inputSchema: z.object({
      startDate: z.string().describe('ISO 8601 datetime (start of range, inclusive, on job createdAt)'),
      endDate: z.string().describe('ISO 8601 datetime (end of range, inclusive, on job createdAt)'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const statusFields = JOB_STATUSES.map(
        (status) => `status_${status}: jobs(filter: { status: ${status}, createdAt: $range }, first: 1) { totalCount }`
      ).join('\n');

      const query = `
        query GetJobReport($range: Iso8601DateTimeRangeInput) {
          totalInRange: jobs(filter: { createdAt: $range }, first: 1) {
            totalCount
          }
          ${statusFields}
        }
      `;

      const data = await client.query(query, {
        range: { after: args.startDate, before: args.endDate },
      });

      const jobsByStatus: Record<string, number> = {};
      for (const status of JOB_STATUSES) {
        jobsByStatus[status] = data[`status_${status}`]?.totalCount ?? 0;
      }

      return {
        jobReport: {
          startDate: args.startDate,
          endDate: args.endDate,
          totalJobsCreatedInRange: data.totalInRange?.totalCount ?? 0,
          jobsByStatus,
        },
      };
    },
  },

  get_client_report: {
    description:
      'Client report for a date range: total client count, count of clients created in range (via ClientFilterAttributes.createdAt), and job/invoice counts for up to `limit` of those newly-created clients. Does not sum dollar revenue — use get_revenue_report for that.',
    inputSchema: z.object({
      startDate: z.string().describe('ISO 8601 datetime (start of range, inclusive, on client createdAt)'),
      endDate: z.string().describe('ISO 8601 datetime (end of range, inclusive, on client createdAt)'),
      limit: z.number().default(50).describe('Max newly-created clients to include in the breakdown'),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetClientReport($first: Int, $filter: ClientFilterAttributes) {
          allClients: clients(first: 1) {
            totalCount
          }
          newClients: clients(first: $first, filter: $filter) {
            totalCount
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              firstName
              lastName
              companyName
              createdAt
              isArchived
              jobs {
                totalCount
              }
              invoices {
                totalCount
              }
            }
          }
        }
      `;

      const data = await client.query(query, {
        first: args.limit,
        filter: { createdAt: { after: args.startDate, before: args.endDate } },
      });

      return {
        clientReport: {
          startDate: args.startDate,
          endDate: args.endDate,
          totalClients: data.allClients?.totalCount ?? 0,
          newClientsInRange: data.newClients?.totalCount ?? 0,
          truncated: data.newClients?.pageInfo?.hasNextPage ?? false,
          clients: data.newClients?.nodes ?? [],
        },
      };
    },
  },
};
