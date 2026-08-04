/**
 * Expenses Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Notable shape differences from a
 * naive reading of the API:
 *   - IDs are `EncodedId`, not `ID`.
 *   - `Expense` has no `amount`, `category`, `receipt`, `user`, or `job` field.
 *     The money field is `total` (a plain Float, not a `{ amount currency }`
 *     object), and the people/job associations are `enteredBy`, `paidBy`,
 *     `reimbursableTo`, and `linkedJob`.
 *   - `ExpenseFilterAttributes` has no `userId`/`jobId`/`startDate`/`endDate`.
 *     Date filtering goes through `Iso8601DateTimeRangeInput` (`before`/
 *     `after`/`eq`), keyed on `date`, `createdAt`, or `updatedAt`.
 *   - Mutations are `expenseCreate`, `expenseEdit` (not `expenseUpdate`), and
 *     `expenseDelete`. `expenseDelete` returns `deletedExpense`, not an id.
 *   - There is no mutation to approve/reimburse an expense — no field on
 *     `Expense`, `ExpenseEditInput`, or the mutation list exposes payment
 *     status as writable. The old `approve_expense` tool called a
 *     nonexistent shape and has been removed; see the bottom of this file.
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

/** Standard expense fields fragment (local to this module — see header note). */
const EXPENSE_FIELDS = `
  id
  title
  description
  date
  total
  createdAt
  updatedAt
  enteredBy {
    ${JobberClient.userFields}
  }
  paidBy {
    ${JobberClient.userFields}
  }
  reimbursableTo {
    ${JobberClient.userFields}
  }
  linkedJob {
    id
    jobNumber
    title
  }
`;

export const expensesTools = {
  list_expenses: {
    description:
      'List expenses with optional filtering by who entered/is reimbursed, payment status, or a date range.',
    inputSchema: z.object({
      enteredById: z.string().optional().describe('Filter to expenses entered by this user'),
      reimbursableToId: z.string().optional().describe('Filter to expenses reimbursable to this user'),
      paymentStatus: z.enum(['PENDING_REIMBURSEMENT', 'PAID']).optional(),
      dateAfter: z.string().optional().describe('ISO 8601 date; include expenses dated on/after this'),
      dateBefore: z.string().optional().describe('ISO 8601 date; include expenses dated on/before this'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const filter: Record<string, unknown> = {};
      if (args.enteredById) filter.enteredById = args.enteredById;
      if (args.reimbursableToId) filter.reimbursableToId = args.reimbursableToId;
      if (args.paymentStatus) filter.paymentStatus = args.paymentStatus;
      if (args.dateAfter || args.dateBefore) {
        filter.date = {
          ...(args.dateAfter ? { after: args.dateAfter } : {}),
          ...(args.dateBefore ? { before: args.dateBefore } : {}),
        };
      }

      const query = `
        query ListExpenses($first: Int, $after: String, $filter: ExpenseFilterAttributes) {
          expenses(first: $first, after: $after, filter: $filter) {
            nodes {
              ${EXPENSE_FIELDS}
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
        expenses: data.expenses?.nodes ?? [],
        pageInfo: data.expenses?.pageInfo,
        totalCount: data.expenses?.totalCount,
      };
    },
  },

  get_expense: {
    description: 'Get a specific expense by ID',
    inputSchema: z.object({
      expenseId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const query = `
        query GetExpense($id: EncodedId!) {
          expense(id: $id) {
            ${EXPENSE_FIELDS}
          }
        }
      `;

      const data = await client.query(query, { id: args.expenseId });
      return { expense: data.expense };
    },
  },

  create_expense: {
    description: 'Create a new expense',
    inputSchema: z.object({
      title: z.string(),
      description: z.string().optional(),
      date: z.string().describe('ISO 8601 date the expense was incurred'),
      total: z.number().optional().describe('Total cost of the expense'),
      reimbursableToId: z.string().optional().describe('The user to be reimbursed'),
      linkedJobId: z.string().optional().describe('The job this expense is associated with'),
      accountingCodeId: z.string().optional(),
      receiptUrl: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation CreateExpense($input: ExpenseCreateInput!) {
          expenseCreate(input: $input) {
            expense {
              ${EXPENSE_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {
        title: args.title,
        date: args.date,
      };
      if (args.description) input.description = args.description;
      if (args.total !== undefined) input.total = args.total;
      if (args.reimbursableToId) input.reimbursableToId = args.reimbursableToId;
      if (args.linkedJobId) input.linkedJobId = args.linkedJobId;
      if (args.accountingCodeId) input.accountingCodeId = args.accountingCodeId;
      if (args.receiptUrl) input.receiptUrl = args.receiptUrl;

      const data = await client.mutate(mutation, { input });

      if (data.expenseCreate.userErrors?.length > 0) {
        throw new Error(`Expense creation failed: ${data.expenseCreate.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { expense: data.expenseCreate.expense };
    },
  },

  update_expense: {
    description: 'Update an existing expense',
    inputSchema: z.object({
      expenseId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      date: z.string().optional().describe('ISO 8601 date'),
      total: z.number().optional(),
      reimbursableToId: z.string().optional(),
      linkedJobId: z.string().optional(),
      accountingCodeId: z.string().optional(),
      receiptUrl: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation UpdateExpense($expenseId: EncodedId!, $input: ExpenseEditInput!) {
          expenseEdit(expenseId: $expenseId, input: $input) {
            expense {
              ${EXPENSE_FIELDS}
            }
            ${USER_ERRORS}
          }
        }
      `;

      const input: Record<string, unknown> = {};
      if (args.title) input.title = args.title;
      if (args.description) input.description = args.description;
      if (args.date) input.date = args.date;
      if (args.total !== undefined) input.total = args.total;
      if (args.reimbursableToId) input.reimbursableToId = args.reimbursableToId;
      if (args.linkedJobId) input.linkedJobId = args.linkedJobId;
      if (args.accountingCodeId) input.accountingCodeId = args.accountingCodeId;
      if (args.receiptUrl) input.receiptUrl = args.receiptUrl;

      const data = await client.mutate(mutation, { expenseId: args.expenseId, input });

      if (data.expenseEdit.userErrors?.length > 0) {
        throw new Error(`Expense update failed: ${data.expenseEdit.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { expense: data.expenseEdit.expense };
    },
  },

  delete_expense: {
    description: 'Delete an expense',
    inputSchema: z.object({
      expenseId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const mutation = `
        mutation DeleteExpense($expenseId: EncodedId!) {
          expenseDelete(expenseId: $expenseId) {
            deletedExpense {
              id
              title
            }
            userErrors {
              message
              path
            }
          }
        }
      `;

      const data = await client.mutate(mutation, { expenseId: args.expenseId });

      if (data.expenseDelete.userErrors?.length > 0) {
        throw new Error(`Expense deletion failed: ${data.expenseDelete.userErrors.map((e: any) => e.message).join(', ')}`);
      }

      return { deletedExpense: data.expenseDelete.deletedExpense };
    },
  },

  // NOTE: `approve_expense` was removed. It previously called a nonexistent
  // `expenseUpdate` mutation with a `reimburse` boolean input. There is no
  // field on `Expense`, `ExpenseCreateInput`, or `ExpenseEditInput` for
  // payment/reimbursement status, and no mutation in the schema
  // (`expenseCreate` / `expenseEdit` / `expenseDelete` /
  // `expenseUpload*`) sets it. `ExpensePaymentStatus` only appears as a
  // read-only filter on `ExpenseFilterAttributes`, so this state is
  // computed by Jobber, not settable via the API. If Jobber exposes a real
  // mutation for this in the future, reintroduce the tool against it.
};
