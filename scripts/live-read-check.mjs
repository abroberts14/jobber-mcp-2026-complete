#!/usr/bin/env node
/**
 * Run every READ-ONLY tool against live Jobber, in-process.
 *
 * Static analysis proves a query matches the schema; only Jobber can prove it
 * accepts the query. This runs the real tool code against the real API.
 *
 * Takes an ACCESS token only and deliberately supplies no refresh token: the
 * deployed server owns the refresh chain, and Jobber's refresh tokens are
 * single-use, so a refresh from here could invalidate the running server. If
 * the access token expires mid-run the client fails loudly instead.
 *
 * Only list_/get_/search_ tools are invoked. Mutations are never called, and
 * there is no flag to make them run.
 *
 *   JOBBER_ACCESS_TOKEN=... node scripts/live-read-check.mjs [--verbose]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const distDir = process.argv.includes('--dist')
  ? resolve(process.argv[process.argv.indexOf('--dist') + 1])
  : join(root, 'dist');

const token = process.env.JOBBER_ACCESS_TOKEN;
if (!token) {
  console.error('JOBBER_ACCESS_TOKEN is required.');
  process.exit(2);
}

const { JobberClient } = await import(join(distDir, 'clients', 'jobber.js'));

const MODULES = [
  'jobs-tools', 'clients-tools', 'quotes-tools', 'invoices-tools',
  'scheduling-tools', 'team-tools', 'expenses-tools', 'products-tools',
  'requests-tools', 'reporting-tools', 'properties-tools', 'timesheets-tools',
  'line-items-tools', 'forms-tools', 'taxes-tools',
];

const READ_ONLY = /^(list_|get_|search_)/;

const tools = {};
for (const mod of MODULES) {
  const ns = await import(join(distDir, 'tools', `${mod}.js`));
  const obj = Object.values(ns).find((v) => v && typeof v === 'object');
  for (const [name, tool] of Object.entries(obj ?? {})) tools[name] = { ...tool, module: mod };
}

// No refreshToken on purpose — see header.
const client = new JobberClient({ accessToken: token, refreshToken: '' });

/** Required arg names, read off the Zod schema. */
function requiredKeys(schema) {
  const shape = schema?._def?.shape?.() ?? {};
  return Object.entries(shape)
    .filter(([, v]) => {
      const t = v?._def?.typeName;
      return t !== 'ZodOptional' && t !== 'ZodDefault' && t !== 'ZodNullable';
    })
    .map(([k]) => k);
}

const harvested = new Map();
function harvest(obj, depth = 0) {
  if (!obj || depth > 5) return;
  if (Array.isArray(obj)) return obj.slice(0, 2).forEach((o) => harvest(o, depth + 1));
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id' && typeof v === 'string') {
      // Remember by the containing collection's name where we can.
      if (!harvested.has('_any')) harvested.set('_any', v);
    }
    harvest(v, depth + 1);
  }
}

function recordIds(toolName, data) {
  const entity = toolName.replace(/^list_/, '').replace(/s$/, '');
  const findFirstId = (o, depth = 0) => {
    if (!o || depth > 4) return null;
    if (Array.isArray(o)) {
      for (const x of o) { const r = findFirstId(x, depth + 1); if (r) return r; }
      return null;
    }
    if (typeof o !== 'object') return null;
    if (typeof o.id === 'string') return o.id;
    for (const v of Object.values(o)) { const r = findFirstId(v, depth + 1); if (r) return r; }
    return null;
  };
  const id = findFirstId(data);
  if (id && !harvested.has(entity)) harvested.set(entity, id);
  harvest(data);
}

const pass = [];
const fail = [];
const skip = [];

async function invoke(name, tool, args) {
  try {
    const out = await tool.execute(client, args);
    pass.push(name);
    console.log(`ok    ${name}`);
    if (verbose) console.log(`        ${JSON.stringify(out).slice(0, 220)}`);
    return out;
  } catch (e) {
    const msg = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 240);
    fail.push({ name, module: tool.module, msg });
    console.log(`FAIL  ${name}\n        ${msg}`);
    return null;
  }
}

const readTools = Object.entries(tools).filter(([n]) => READ_ONLY.test(n));
console.log(`${Object.keys(tools).length} tools total, ${readTools.length} read-only\n`);

console.log('--- pass 1: no required arguments ---');
const deferred = [];
for (const [name, tool] of readTools) {
  const req = requiredKeys(tool.inputSchema);
  if (req.length) { deferred.push([name, tool, req]); continue; }
  const out = await invoke(name, tool, { limit: 2 });
  if (out) recordIds(name, out);
}

/**
 * Only *Id/*Ids arguments get a harvested ID. Everything else is filled by
 * type/name — an earlier version fell back to "any id we've seen", which fed
 * job IDs into startDate and produced failures that looked like tool bugs.
 */
function valueForArg(key, zodType) {
  if (/Ids$/.test(key) || /Id$/.test(key)) return undefined; // resolved by caller
  const t = zodType?._def?.typeName;
  if (t === 'ZodNumber') return 1;
  if (t === 'ZodBoolean') return false;
  if (t === 'ZodEnum') return zodType._def.values[0];
  if (/(date|At|start|end|after|before)$/i.test(key)) {
    const d = new Date(Date.now() - 90 * 864e5).toISOString();
    return /^end|before/i.test(key) ? new Date().toISOString() : d;
  }
  if (/timezone/i.test(key)) return 'UTC';
  return 'sample';
}

console.log('\n--- pass 2: needs an ID discovered above ---');
for (const [name, tool, req] of deferred) {
  const args = { limit: 2 };
  const shape = tool.inputSchema?._def?.shape?.() ?? {};
  let ok = true;
  for (const key of req) {
    if (/Ids?$/.test(key)) {
      const entity = key.replace(/Ids?$/, '').toLowerCase();
      const id =
        harvested.get(entity) ??
        harvested.get(`${entity}e`) ??
        harvested.get(entity.replace(/y$/, 'ie'));
      if (id) args[key] = key.endsWith('Ids') ? [id] : id;
      else ok = false; // no real ID of this entity exists in the account
    } else {
      args[key] = valueForArg(key, shape[key]);
    }
  }
  if (!ok) {
    skip.push(name);
    console.log(`skip  ${name}  (no live ${req.filter((k) => /Ids?$/.test(k)).join(', ')} in this account)`);
    continue;
  }
  await invoke(name, tool, args);
}

console.log(`\n${'='.repeat(64)}`);
console.log(`${pass.length} passed, ${fail.length} failed, ${skip.length} skipped`);
if (fail.length) {
  console.log('\nFailures:');
  for (const f of fail) console.log(`  [${f.module}] ${f.name}: ${f.msg}`);
}
process.exit(fail.length ? 1 : 0);
