#!/usr/bin/env node
/**
 * Streamable HTTP entry point, for running the server as a shared service
 * rather than a per-client subprocess.
 *
 * Single-tenant by design: every caller acts as the one Jobber account this
 * server is authorized against. The bearer secret is therefore an access gate
 * for the team, not a user identity — do not expose this without one, because
 * the tool set includes mutations (create_job, archive_client, ...).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEnv } from './load-env.js';
import { createJobberRuntime, createMcpServer, hydrateFromStore } from './server.js';

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JOBBER_MCP_SECRET;
const MCP_PATH = process.env.JOBBER_MCP_PATH || '/mcp';

if (!SECRET) {
  console.error(
    'JOBBER_MCP_SECRET is required for the HTTP transport. It gates access to a\n' +
      'server that can mutate your Jobber account. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

const runtime = createJobberRuntime();
await hydrateFromStore(runtime);

const httpServer = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('Unhandled request error:', error);
    if (!res.headersSent) send(res, 500, { error: 'internal_error' });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url || '/', 'http://localhost').pathname;

  // Unauthenticated: the container healthcheck and Coolify's health gate need
  // it, and it reveals nothing beyond liveness.
  if (path === '/health') {
    send(res, 200, { status: 'ok' });
    return;
  }

  if (path !== MCP_PATH) {
    send(res, 404, { error: 'not_found' });
    return;
  }

  if (!authorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    send(res, 401, { error: 'unauthorized' });
    return;
  }

  // Stateless: a fresh server and transport per request, so concurrent requests
  // can never collide on JSON-RPC ids. The Jobber client (and its tokens) is
  // shared across them.
  const server = createMcpServer(runtime.client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) return false;

  // Constant-time, and length-guarded because timingSafeEqual throws on a
  // length mismatch.
  const a = Buffer.from(presented);
  const b = Buffer.from(SECRET as string);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    // Let the transport reject it as a malformed JSON-RPC message.
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

httpServer.listen(PORT, () => {
  console.error(`Jobber MCP server listening on :${PORT} (endpoint ${MCP_PATH})`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
  });
}
