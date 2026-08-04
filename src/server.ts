/**
 * Jobber MCP Server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { JobberClient } from './clients/jobber.js';
import { TokenStore } from './auth/token-store.js';
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

// Combine all tools
const allTools = {
  ...jobsTools,
  ...clientsTools,
  ...quotesTools,
  ...invoicesTools,
  ...schedulingTools,
  ...teamTools,
  ...expensesTools,
  ...productsTools,
  ...requestsTools,
  ...reportingTools,
  ...propertiesTools,
  ...timesheetsTools,
  ...lineItemsTools,
  ...formsTools,
  ...taxesTools,
};

export class JobberServer {
  private server: Server;
  private client: JobberClient;
  private tokenStore: TokenStore;

  constructor() {
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

    this.tokenStore = new TokenStore();
    this.client = new JobberClient({
      clientId,
      clientSecret,
      refreshToken,
      accessToken: process.env.JOBBER_ACCESS_TOKEN,
      apiUrl: process.env.JOBBER_API_URL,
      graphqlVersion: process.env.JOBBER_GRAPHQL_VERSION,
      onTokensRefreshed: async (tokens) => {
        // Jobber rotates the refresh token on every refresh; losing the new one
        // means re-running the authorization flow by hand.
        await this.tokenStore.write(tokens);
      },
    });

    this.server = new Server(
      {
        name: 'jobber-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Derive readOnlyHint from tool name
    const isReadOnly = (name: string) =>
      name.startsWith('list_') || name.startsWith('get_') || name.startsWith('search_');

    // Tool schemas are authored as Zod but MCP requires JSON Schema on the
    // wire, so convert once at startup rather than per request.
    const toolList = Object.entries(allTools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }),
      ...(isReadOnly(name) ? { readOnlyHint: true } : {}),
    }));

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: toolList };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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

        // Execute tool
        const result = await tool.execute(this.client, validatedArgs);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
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
  }

  async run(): Promise<void> {
    // Prefer stored tokens over the .env bootstrap values: after the first
    // refresh the .env refresh token is stale and single-use.
    const stored = await this.tokenStore.read();
    if (stored) {
      this.client.setTokens(stored);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Jobber MCP server running on stdio');
  }
}
