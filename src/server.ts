/**
 * Jobber MCP Server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  SetLevelRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { JobberClient } from './clients/jobber.js';
import { TokenStore } from './auth/token-store.js';
import { withThrottleReporter, type ThrottleWait, type QueryCost } from './throttle-context.js';
import { createMetaTools } from './help.js';
import { jobsTools } from './tools/jobs-tools.js';
import { clientsTools } from './tools/clients-tools.js';
import { quotesTools } from './tools/quotes-tools.js';
import { invoicesTools } from './tools/invoices-tools.js';
import { schedulingTools } from './tools/scheduling-tools.js';
import { teamTools } from './tools/team-tools.js';
import { expensesTools } from './tools/expenses-tools.js';
import { productsTools } from './tools/products-tools.js';
import { requestsTools } from './tools/requests-tools.js';
import { reportingTools } from './tools/reporting-tools.js';
import { propertiesTools } from './tools/properties-tools.js';
import { timesheetsTools } from './tools/timesheets-tools.js';
import { lineItemsTools } from './tools/line-items-tools.js';
import { formsTools } from './tools/forms-tools.js';
import { taxesTools } from './tools/taxes-tools.js';
import { notesTools } from './tools/notes-tools.js';
import { searchTools } from './tools/search-tools.js';
import { tasksTools } from './tools/tasks-tools.js';
import { assessmentsTools } from './tools/assessments-tools.js';

// Combine all tools
/**
 * Tools grouped by domain. Single source of truth: dispatch, the duplicate
 * check and the `help` catalog all derive from this, so help cannot drift out
 * of sync with what is actually exposed.
 */
const TOOL_GROUPS: Record<string, Record<string, any>> = {
  jobs: jobsTools,
  clients: clientsTools,
  quotes: quotesTools,
  invoices: invoicesTools,
  scheduling: schedulingTools,
  team: teamTools,
  expenses: expensesTools,
  products: productsTools,
  requests: requestsTools,
  reporting: reportingTools,
  properties: propertiesTools,
  timesheets: timesheetsTools,
  'line-items': lineItemsTools,
  forms: formsTools,
  taxes: taxesTools,
  notes: notesTools,
  search: searchTools,
  tasks: tasksTools,
  assessments: assessmentsTools,
};

/** Which group each tool came from, for `help`. */
const toolGroup = new Map<string, string>();

// Object spread means two modules defining the same key would silently drop one
// tool with no error anywhere. Fail loudly on collision instead.
{
  const collisions: string[] = [];
  for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
    for (const name of Object.keys(tools)) {
      const prior = toolGroup.get(name);
      if (prior) collisions.push(`${name} (${prior} and ${group})`);
      else toolGroup.set(name, group);
    }
  }
  if (collisions.length) {
    throw new Error(`Duplicate tool names would shadow each other: ${collisions.join(', ')}`);
  }
}

// Derive readOnlyHint from tool name
const isReadOnly = (name: string) =>
  name === 'help' || name === 'get_api_budget' ||
  name.startsWith('list_') ||
  name.startsWith('get_') ||
  name.startsWith('search_');

const allTools: Record<string, any> = Object.assign(
  {},
  ...Object.values(TOOL_GROUPS),
  // Built from TOOL_GROUPS above, so the catalog always matches what is
  // exposed. Deliberately not a src/tools/ module: it issues no GraphQL, and
  // the query validators would flag it for that.
  createMetaTools(TOOL_GROUPS, isReadOnly)
);

/**
 * Tool schemas are authored as Zod but MCP requires JSON Schema on the wire.
 * Converting 102 schemas is not free, so do it once per process rather than per
 * request or per connection.
 */
const toolList = Object.entries(allTools).map(([name, tool]) => ({
  name,
  description: tool.description,
  inputSchema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }),
  ...(isReadOnly(name) ? { readOnlyHint: true } : {}),
}));

export interface JobberRuntime {
  client: JobberClient;
  tokenStore: TokenStore;
}

/**
 * Build the Jobber client and its token store from the environment.
 *
 * Shared by every transport: one client per process means one set of tokens and
 * one refresh lock, however many MCP connections are served.
 */
export function createJobberRuntime(): JobberRuntime {
  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;
  const refreshToken = process.env.JOBBER_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error(
      'JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET are required. ' +
        'Create an app at https://developer.getjobber.com to get them.'
    );
  }
  if (!refreshToken) {
    throw new Error(
      'JOBBER_REFRESH_TOKEN is required. Run `npm run authorize` to complete the ' +
        'OAuth flow and obtain one — Jobber does not issue static API tokens.'
    );
  }

  const tokenStore = new TokenStore();
  const client = new JobberClient({
    clientId,
    clientSecret,
    refreshToken,
    accessToken: process.env.JOBBER_ACCESS_TOKEN,
    apiUrl: process.env.JOBBER_API_URL,
    oauthUrl: process.env.JOBBER_OAUTH_URL,
    graphqlVersion: process.env.JOBBER_GRAPHQL_VERSION,
    // Rotation is a per-app Jobber setting and is OFF for this app, so the
    // returned refresh token matches the one sent. The lock still matters:
    // overlapping refreshes are rejected regardless of rotation, and it keeps
    // several MCP clients (or containers sharing the volume) from racing.
    onTokensRefreshed: (tokens) => tokenStore.write(tokens),
    loadTokens: () => tokenStore.read(),
    withLock: (fn) => tokenStore.withLock(fn),
  });

  return { client, tokenStore };
}

/**
 * Seed the client from the token store, preferring it over the .env bootstrap
 * values so a live access token survives a restart.
 *
 * If the stored refresh token is ever rejected, the client falls back to the
 * environment value once — otherwise a stale store would keep re-adopting a
 * dead token and an operator's fix to JOBBER_REFRESH_TOKEN would appear to do
 * nothing.
 */
export async function hydrateFromStore(runtime: JobberRuntime): Promise<void> {
  const stored = await runtime.tokenStore.read();
  if (stored) {
    runtime.client.setTokens(stored);
  }
}

/** A configured MCP server exposing every Jobber tool against `client`. */
export function createMcpServer(client: JobberClient): Server {
  const server = new Server(
    {
      name: 'jobber-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        // Declared so the server can tell callers when it is sleeping off a
        // Jobber rate limit rather than just appearing to hang.
        logging: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: toolList };
  });

  // Per-request API cost is logged at debug so it stays out of the way by
  // default. The baseline comes from the environment because the HTTP transport
  // is stateless — it builds a fresh Server per request, so a `logging/setLevel`
  // call would be discarded before the next one and debug could never be
  // reached. setLevel still works within a session on the stdio transport.
  const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
  let logLevel = LEVELS.includes(process.env.JOBBER_LOG_LEVEL ?? '')
    ? (process.env.JOBBER_LOG_LEVEL as string)
    : 'info';
  const enabled = (level: string) => LEVELS.indexOf(level) >= LEVELS.indexOf(logLevel);

  server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    logLevel = request.params.level;
    return {};
  });

  const log = (level: string, logger: string, data: unknown) => {
    if (!enabled(level)) return;
    // Fire-and-forget: a client that ignores notifications must not break, and
    // a failed notify must never fail the tool call.
    void server.sendLoggingMessage({ level: level as any, logger, data } as any).catch(() => {});
  };

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = allTools[name as keyof typeof allTools];
    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}`
      );
    }

    try {
      // Validate arguments
      const validatedArgs = tool.inputSchema.parse(args);

      // A rate-limit wait is otherwise invisible — the call just takes longer.
      // Report each wait as it happens, and summarize on the result.
      const waits: ThrottleWait[] = [];
      const costs: QueryCost[] = [];
      const progressToken = (request.params as any)?._meta?.progressToken;

      // Explicit <any>: `tool.execute` is a union across every tool, so
      // inference would otherwise pin T to the first member's return type.
      const result = await withThrottleReporter<any>(
        {
          onWait: (wait) => {
            waits.push(wait);
            const seconds = (wait.waitMs / 1000).toFixed(1);
            const detail =
              wait.reason === 'throttled'
                ? `Jobber rate limit hit; waiting ${seconds}s before retry ${wait.attempt}/${wait.maxAttempts}`
                : `Pausing ${seconds}s to stay within Jobber's rate limit`;

            log('warning', 'jobber-rate-limit', { message: detail, tool: name, ...wait });

            if (progressToken !== undefined) {
              void server
                .notification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: wait.attempt, total: wait.maxAttempts, message: detail },
                })
                .catch(() => {});
            }
          },
          onCost: (cost) => {
            costs.push(cost);
            const s = cost.throttleStatus;
            log('debug', 'jobber-api-cost', {
              tool: name,
              requestedQueryCost: cost.requestedQueryCost,
              actualQueryCost: cost.actualQueryCost,
              ...(s
                ? {
                    available: s.currentlyAvailable,
                    maximum: s.maximumAvailable,
                    restoreRate: s.restoreRate,
                    percentRemaining: Math.round((s.currentlyAvailable / s.maximumAvailable) * 100),
                  }
                : {}),
            });
          },
        },
        () => tool.execute(client, validatedArgs)
      );

      const totalWaitMs = waits.reduce((sum, w) => sum + w.waitMs, 0);

      // _meta and logging notifications are both at the client's discretion to
      // display, and most don't. With JOBBER_SHOW_API_COST=1 the cost goes into
      // the visible text content instead, where every client shows it.
      const costLine = () => {
        const b = client.getThrottleStatus();
        const requested = costs.reduce((n, c) => n + c.requestedQueryCost, 0);
        const actual = costs.reduce((n, c) => n + c.actualQueryCost, 0);
        const budget = b
          ? `, budget ${Math.round(b.projectedAvailable)}/${b.maximumAvailable}`
          : '';
        const waited = totalWaitMs > 0 ? `, rate-limited ${(totalWaitMs / 1000).toFixed(1)}s` : '';
        return `[jobber api] ${costs.length} request(s), cost ${actual} (requested ${requested})${budget}${waited}`;
      };

      // Appended INSIDE the first block, not as a second one: MCP log
      // notifications are optional for clients to render (Claude Code routes
      // them to the debug log, not the transcript), and a second content block
      // is not reliably shown either. The primary block always is.
      const showCost = process.env.JOBBER_SHOW_API_COST === '1' && costs.length > 0;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2) + (showCost ? `\n\n${costLine()}` : ''),
          },
        ],
        structuredContent: result,
        _meta: {
          // Reported on every call so a caller can see what a tool actually
          // costs and how much budget is left, not only when it goes wrong.
          jobberApi: {
            requests: costs.length,
            requestedQueryCost: costs.reduce((n, c) => n + c.requestedQueryCost, 0),
            actualQueryCost: costs.reduce((n, c) => n + c.actualQueryCost, 0),
            budget: client.getThrottleStatus(),
            ...(totalWaitMs > 0
              ? {
                  rateLimited: true,
                  totalWaitMs,
                  waits: waits.length,
                  note: "This call was delayed to stay within Jobber's API rate limit.",
                }
              : {}),
          },
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error.message}`
        );
      }
      throw error;
    }
  });

  return server;
}

export class JobberServer {
  private server: Server;
  private runtime: JobberRuntime;

  constructor() {
    this.runtime = createJobberRuntime();
    this.server = createMcpServer(this.runtime.client);
  }

  async run(): Promise<void> {
    await hydrateFromStore(this.runtime);

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Jobber MCP server running on stdio');
  }
}
