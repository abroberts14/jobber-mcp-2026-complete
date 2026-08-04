/**
 * A self-describing catalog for the tool set.
 *
 * `tools/list` already gives every client the full JSON Schema for all ~100
 * tools, but that is a lot of context to read and it cannot express the rules
 * that span tools — that IDs are opaque, that job status enums are lowercase,
 * that creating a job needs a property rather than a client. This tool carries
 * that knowledge, and derives the catalog from the live registry so it cannot
 * drift from what is actually exposed.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Cross-cutting rules a caller cannot infer from any single tool schema. */
const CONVENTIONS = [
  'IDs are opaque base64 strings (Jobber "EncodedId", e.g. "Z2lkOi8vSm9iYmVyL0NsaWVudC8x..."). Never construct, guess, or increment one. Always take an ID from a list_/get_/search_ result first.',
  'Money is a plain number. There is no { amount, currency } object. Quote and invoice totals live under `amounts` (subtotal, discountAmount, taxAmount, total, ...).',
  'Status enum values are LOWERCASE for jobs, quotes, invoices and requests (e.g. "active", "draft", "paid", "new"). Other enums are UPPERCASE (e.g. "ONE_OFF", "PRODUCT", "SERVICE", "ACTIVATED"). Check the tool schema.',
  'Pagination is `limit` plus `cursor`. Responses carry pageInfo.hasNextPage and pageInfo.endCursor; pass endCursor back as `cursor` for the next page.',
  'Dates are ISO 8601. Visits and assessments are scheduled with a LOCAL date/time plus an IANA `timezone` (e.g. "America/Denver"), not a bare UTC instant.',
  'Line items and notes are parent-scoped: pass `parent` ("job" | "quote" | "visit" | "request", plus "client" and "invoice" for notes) together with `parentId`. There is no standalone line-item or note object.',
  'create_job takes `propertyId`, NOT a clientId — Jobber derives the client from the property. Create the client first, then a property on it, then the job.',
  'Rate limiting is handled automatically (retry, backoff, self-pacing). Every result carries _meta.jobberApi with the query cost and remaining budget; a delayed call also reports rateLimited: true.',
];

/** Things callers repeatedly assume exist. They do not. Stated so a model stops trying. */
const NOT_SUPPORTED = [
  'Job forms — Jobber exposes no forms API at all (no read and no write).',
  'Creating, editing or deleting timesheet entries — they are read-only via the API.',
  'Recording a payment — there is no payment-create mutation. Payments are read-only (list_payments / get_payment).',
  'Sending or approving a quote — quote approval is a client-hub action. You can create, edit and convert a quote to a job.',
  'Converting a request directly to a job or quote — no such mutation. Create the job or quote separately.',
  'Cross-entity search — there is no "search everything" query. Search per entity (search_clients, search_products) or use list_* with filters.',
  'Deleting clients, jobs, quotes, properties or products — Jobber has no delete for these. Use archive_client, close_job, void_invoice, or set a product not-visible instead. Visits, expenses, tasks and notes CAN be deleted.',
  'Editing a user beyond their display name, and creating or deleting users.',
];

const WORKFLOWS: Record<string, string[]> = {
  'Create work for a new client': [
    'create_client { firstName, lastName }',
    'create_property { clientId, street1, city }   // job needs a property',
    'create_job { propertyId, title }',
    'create_line_items { parent: "job", parentId: jobId, lineItems: [...] }',
    'create_visit { jobId, startAt, timezone }',
  ],
  'Quote to job to invoice': [
    'create_quote { clientId, propertyId, lineItems }   // lineItems required',
    'update_quote / create_quote_text_line_items       // optional edits',
    'convert_quote_to_job { quoteId }',
    'create_invoice { clientId, lineItems }',
    'send_invoice { invoiceId }  then  close_invoice { invoiceId, closeOption: "MARK_RECEIVED" }',
  ],
  'Find something when you only have a name': [
    'search_clients { query } — or list_* with filters for other entities',
    'Take the returned id and pass it to the matching get_* tool',
    'Note: Jobber\'s search index lags writes by a few seconds; a just-created record may not appear immediately.',
  ],
  'Clean up test or mistaken records': [
    'void_invoice — an open invoice blocks archiving its client',
    'close_job for every job on the client',
    'delete_visits / delete_expense / delete_note where supported',
    'archive_client — hides the whole chain beneath it',
  ],
};

export function createHelpTool(
  groups: Record<string, Record<string, any>>,
  isReadOnly: (name: string) => boolean
) {
  const total = Object.values(groups).reduce((n, g) => n + Object.keys(g).length, 0);

  /** Required argument names for a tool, read off its Zod schema. */
  const requiredArgs = (tool: any): string[] => {
    const shape = tool?.inputSchema?._def?.shape?.() ?? {};
    return Object.entries(shape)
      .filter(([, v]: [string, any]) => {
        const t = v?._def?.typeName;
        return t !== 'ZodOptional' && t !== 'ZodDefault' && t !== 'ZodNullable';
      })
      .map(([k]) => k);
  };

  const summarize = (name: string, tool: any) => ({
    name,
    kind: isReadOnly(name) ? 'read' : 'write',
    required: requiredArgs(tool),
    description: tool.description,
  });

  return {
    help: {
      description:
        'Catalog and usage guide for this Jobber MCP server. Call with no arguments for an overview of every tool category plus the conventions that apply across all tools (ID format, enum casing, pagination, what Jobber does NOT support). Pass `category` to list the tools in one area, or `tool` for one tool\'s full input schema. Start here before calling anything else.',
      inputSchema: z.object({
        category: z
          .string()
          .optional()
          .describe(`One of: ${Object.keys(groups).join(', ')}`),
        tool: z.string().optional().describe('Exact tool name, for its full input schema'),
      }),
      execute: async (_client: unknown, args: any) => {
        // One specific tool: everything a caller needs to invoke it.
        if (args?.tool) {
          for (const [group, tools] of Object.entries(groups)) {
            const tool = tools[args.tool];
            if (!tool) continue;
            return {
              name: args.tool,
              category: group,
              kind: isReadOnly(args.tool) ? 'read' : 'write',
              description: tool.description,
              required: requiredArgs(tool),
              inputSchema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }),
            };
          }
          const near = Object.keys(groups)
            .flatMap((g) => Object.keys(groups[g]))
            .filter((n) => n.includes(String(args.tool).replace(/^(list|get|create|update)_/, '')))
            .slice(0, 8);
          return {
            error: `No tool named "${args.tool}".`,
            ...(near.length ? { didYouMean: near } : {}),
            hint: 'Call help with no arguments to see every category.',
          };
        }

        // One category: enough to choose a tool without pulling 100 schemas.
        if (args?.category) {
          const tools = groups[args.category];
          if (!tools) {
            return {
              error: `No category named "${args.category}".`,
              categories: Object.keys(groups),
            };
          }
          return {
            category: args.category,
            count: Object.keys(tools).length,
            tools: Object.entries(tools).map(([n, t]) => summarize(n, t)),
            note: 'Call help { tool: "<name>" } for the full input schema.',
          };
        }

        // Overview.
        return {
          server: 'Jobber MCP — read and write a single Jobber account over its GraphQL API.',
          apiVersion: '2026-07-27',
          toolCount: total,
          categories: Object.fromEntries(
            Object.entries(groups)
              .filter(([, g]) => Object.keys(g).length > 0)
              .map(([name, g]) => [
                name,
                {
                  count: Object.keys(g).length,
                  tools: Object.keys(g),
                },
              ])
          ),
          conventions: CONVENTIONS,
          notSupported: NOT_SUPPORTED,
          workflows: WORKFLOWS,
          next: 'help { category: "jobs" } to browse an area, or help { tool: "create_job" } for one tool\'s schema.',
        };
      },
    },
  };
}
