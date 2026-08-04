#!/usr/bin/env node
/**
 * Exercise every READ-ONLY tool against a running Jobber MCP server.
 *
 * Static validation (scripts/validate-graphql.mjs) proves a document matches
 * the schema. It cannot prove Jobber accepts it — argument coercion, required
 * filters and permission scopes only show up at runtime. This closes that gap.
 *
 * Strictly read-only: only list_/get_/search_ tools are ever invoked, so this
 * is safe to run against the production Jobber account. Mutations are never
 * called and there is no flag to make it call them.
 *
 *   JOBBER_MCP_URL=https://jobber-mcp.example.com/mcp \
 *   JOBBER_MCP_SECRET=... node scripts/smoke-read-tools.mjs [--verbose]
 *
 * Pass 1 runs the no-argument list tools and harvests real IDs from results.
 * Pass 2 replays those IDs into the get_* tools that need them.
 */
const URL_ = process.env.JOBBER_MCP_URL;
const SECRET = process.env.JOBBER_MCP_SECRET;
const verbose = process.argv.includes('--verbose');

if (!URL_ || !SECRET) {
  console.error('JOBBER_MCP_URL and JOBBER_MCP_SECRET are required.');
  process.exit(2);
}

const READ_ONLY = /^(list_|get_|search_)/;

let id = 0;
async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  // Streamable HTTP replies as SSE; take the last data: frame.
  const frames = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));
  const payload = frames.length ? frames[frames.length - 1] : text;
  try {
    return JSON.parse(payload);
  } catch {
    return { error: { message: `unparseable response: ${text.slice(0, 200)}` } };
  }
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-read-tools', version: '1' },
});

const listed = await rpc('tools/list');
const tools = listed.result?.tools ?? [];
if (!tools.length) {
  console.error('No tools returned:', JSON.stringify(listed).slice(0, 300));
  process.exit(1);
}

const readTools = tools.filter((t) => READ_ONLY.test(t.name));
console.log(`${tools.length} tools exposed, ${readTools.length} read-only\n`);

/** Required args, per the tool's JSON Schema. */
const requiredOf = (t) => t.inputSchema?.required ?? [];

/** Harvest plausible entity IDs out of an arbitrary result payload. */
const harvested = new Map(); // entity -> id
function harvest(name, obj) {
  const entity = name.replace(/^list_/, '').replace(/s$/, '');
  const walk = (v, depth) => {
    if (!v || depth > 4) return;
    if (Array.isArray(v)) return v.slice(0, 1).forEach((x) => walk(x, depth + 1));
    if (typeof v !== 'object') return;
    if (typeof v.id === 'string' && !harvested.has(entity)) harvested.set(entity, v.id);
    for (const val of Object.values(v)) walk(val, depth + 1);
  };
  walk(obj, 0);
}

function unwrap(result) {
  const text = result?.result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const pass = [];
const fail = [];

async function run(tool, args) {
  const r = await rpc('tools/call', { name: tool.name, arguments: args });
  const errMsg = r.error?.message ?? (r.result?.isError ? unwrap(r) : null);
  if (errMsg) {
    fail.push({ name: tool.name, error: String(errMsg).slice(0, 220) });
    console.log(`FAIL  ${tool.name}\n        ${String(errMsg).slice(0, 200)}`);
    return null;
  }
  const data = unwrap(r);
  pass.push(tool.name);
  console.log(`ok    ${tool.name}`);
  if (verbose) console.log(`        ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Pass 1 — tools needing no arguments.
console.log('--- pass 1: no-argument reads ---');
const deferred = [];
for (const tool of readTools) {
  const req = requiredOf(tool);
  if (req.length) {
    deferred.push(tool);
    continue;
  }
  const data = await run(tool, { limit: 2 });
  if (data) harvest(tool.name, data);
}

/**
 * Only *Id/*Ids arguments need a harvested ID. Everything else is filled from
 * the tool's JSON Schema by type and name — otherwise date-ranged tools like
 * the reports get skipped for want of a `startDate` that was never an ID.
 */
function valueForArg(key, schema) {
  const prop = schema?.properties?.[key] ?? {};
  if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum[0];
  if (prop.type === 'number' || prop.type === 'integer') return 1;
  if (prop.type === 'boolean') return false;
  if (/(date|At|start|end|after|before)$/i.test(key)) {
    return /^end|before/i.test(key)
      ? new Date().toISOString()
      : new Date(Date.now() - 90 * 864e5).toISOString();
  }
  if (/timezone/i.test(key)) return 'UTC';
  if (/(query|search|term)/i.test(key)) return 'a';
  return 'sample';
}

// Pass 2 — replay harvested IDs into tools that require one.
console.log('\n--- pass 2: reads needing an ID ---');
for (const tool of deferred) {
  const req = requiredOf(tool);
  const args = { limit: 2 };
  const missing = [];
  for (const key of req) {
    if (/Ids?$/.test(key)) {
      const entity = key.replace(/Ids?$/, '').toLowerCase();
      const found =
        harvested.get(entity) ??
        harvested.get(entity.replace(/y$/, 'ie')) ??
        harvested.get(`${entity}e`);
      if (found) args[key] = key.endsWith('Ids') ? [found] : found;
      else missing.push(key);
    } else {
      args[key] = valueForArg(key, tool.inputSchema);
    }
  }
  if (missing.length) {
    console.log(`skip  ${tool.name}  (no live ${missing.join(', ')} in this account)`);
    continue;
  }
  await run(tool, args);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log('\nFailures:');
  for (const f of fail) console.log(`  ${f.name}: ${f.error}`);
}
process.exit(fail.length ? 1 : 0);
