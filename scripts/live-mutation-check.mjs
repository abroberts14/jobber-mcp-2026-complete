#!/usr/bin/env node
/**
 * Exercise every MUTATING tool against a running Jobber MCP server.
 *
 * THIS WRITES REAL RECORDS. Only point it at a sandbox/seed Jobber account.
 * It creates a dependency chain (client -> property -> job -> visits, quotes,
 * invoices, ...), asserts each mutation succeeds, then deletes everything the
 * API permits deleting and reports whatever it could not remove.
 *
 * Every record is tagged with a run marker so leftovers are easy to find and
 * purge by hand.
 *
 *   JOBBER_MCP_URL=... JOBBER_MCP_SECRET=... node scripts/live-mutation-check.mjs
 *
 * Add --dry-run to print the plan without sending anything.
 */
const URL_ = process.env.JOBBER_MCP_URL;
const SECRET = process.env.JOBBER_MCP_SECRET;
const dryRun = process.argv.includes('--dry-run');

if (!URL_ || !SECRET) {
  console.error('JOBBER_MCP_URL and JOBBER_MCP_SECRET are required.');
  process.exit(2);
}

const TAG = `MCPTEST-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
console.log(`run marker: ${TAG}\ntarget:     ${URL_}\n`);

let rpcId = 0;
async function call(name, args) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: ++rpcId,
      method: 'tools/call', params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const frames = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const body = JSON.parse(frames.length ? frames[frames.length - 1] : text);
  if (body.error) throw new Error(body.error.message);
  const payload = body.result?.content?.[0]?.text;
  const data = payload ? JSON.parse(payload) : body.result;
  if (body.result?.isError) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data;
}

const pass = [];
const fail = [];
const ctx = {};
const created = [];   // { kind, id, cleanup: 'deleted' | 'archived' | 'RESIDUE' }

/** Run one step; record pass/fail but keep going so later steps still report. */
async function step(tool, argsFn, after) {
  if (dryRun) { console.log(`would call ${tool}`); return; }
  try {
    const args = typeof argsFn === 'function' ? argsFn() : argsFn;
    const out = await call(tool, args);
    pass.push(tool);
    console.log(`ok    ${tool}`);
    if (after) after(out);
  } catch (e) {
    const msg = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
    fail.push({ tool, msg });
    console.log(`FAIL  ${tool}\n        ${msg}`);
  }
}

const firstId = (o, depth = 0) => {
  if (!o || depth > 5) return null;
  if (Array.isArray(o)) { for (const x of o) { const r = firstId(x, depth + 1); if (r) return r; } return null; }
  if (typeof o !== 'object') return null;
  if (typeof o.id === 'string') return o.id;
  for (const v of Object.values(o)) { const r = firstId(v, depth + 1); if (r) return r; }
  return null;
};

const LINE_ITEM = (n) => ({
  name: `${TAG} item ${n}`,
  description: 'created by live-mutation-check',
  quantity: 2,
  unitPrice: 25,
  saveToProductsAndServices: false,
});

console.log('=== phase 1: client + property ===');
await step('create_client', { firstName: TAG, lastName: 'Sandbox' }, (o) => {
  ctx.clientId = firstId(o); created.push({ kind: 'client', id: ctx.clientId });
});
await step('update_client', () => ({ clientId: ctx.clientId, companyName: `${TAG} Co` }));
await step('create_property', () => ({
  clientId: ctx.clientId, street1: '1 Test Way', city: 'Denver', province: 'CO',
  postalCode: '80202', country: 'USA',
}), (o) => { ctx.propertyId = firstId(o); created.push({ kind: 'property', id: ctx.propertyId }); });
await step('update_property', () => ({ propertyId: ctx.propertyId, name: `${TAG} site` }));

console.log('\n=== phase 2: job + line items ===');
await step('create_job', () => ({ propertyId: ctx.propertyId, title: `${TAG} job` }),
  (o) => { ctx.jobId = firstId(o); created.push({ kind: 'job', id: ctx.jobId }); });
await step('update_job', () => ({ jobId: ctx.jobId, instructions: 'updated by test' }));
await step('create_line_items', () => ({
  parent: 'job', parentId: ctx.jobId, lineItems: [LINE_ITEM(1), LINE_ITEM(2)],
}), (o) => { ctx.jobLineItems = (o?.lineItems ?? []).map((li) => li.id).filter(Boolean); });
await step('edit_line_items', () => ({
  parent: 'job', parentId: ctx.jobId,
  lineItems: [{ lineItemId: ctx.jobLineItems?.[0], name: `${TAG} item 1 edited`, quantity: 3 }],
}));
await step('reorder_job_line_items', () => ({
  jobId: ctx.jobId, orderedLineItemIds: [...(ctx.jobLineItems ?? [])].reverse(),
}));
await step('delete_line_items', () => ({
  parent: 'job', parentId: ctx.jobId, lineItemIds: [ctx.jobLineItems?.[1]],
}));

// Needed by phase 3 (visit assignment) as well as phase 5.
try {
  const users = await call('list_users', { limit: 1 });
  ctx.userId = firstId(users);
  ctx.userName = users?.users?.[0]?.name?.full ?? users?.users?.[0]?.name;
} catch { /* surfaced by the steps that need it */ }

console.log('\n=== phase 3: visits ===');
const start = new Date(Date.now() + 7 * 864e5).toISOString();
await step('create_visit', () => ({
  jobId: ctx.jobId, title: `${TAG} visit`, startAt: start,
  endAt: new Date(Date.now() + 7 * 864e5 + 36e5).toISOString(),
  timezone: 'America/Denver', notifyTeam: false,
}), (o) => { ctx.visitId = firstId(o); created.push({ kind: 'visit', id: ctx.visitId }); });
await step('update_visit', () => ({ visitId: ctx.visitId, title: `${TAG} visit edited` }));
await step('complete_visit', () => ({ visitId: ctx.visitId }));
await step('uncomplete_visit', () => ({ visitId: ctx.visitId }));
await step('assign_visit_users', () => ({
  visitId: ctx.visitId, assignedUserIds: ctx.userId ? [ctx.userId] : [],
}));
await step('create_job_visit', () => ({
  jobId: ctx.jobId, title: `${TAG} visit2`, startAt: start,
  timezone: 'America/Denver', notifyTeam: false,
}), (o) => { const v = firstId(o); if (v) created.push({ kind: 'visit', id: v }); });

console.log('\n=== phase 4: quotes ===');
await step('create_quote', () => ({
  clientId: ctx.clientId, propertyId: ctx.propertyId,
  title: `${TAG} quote`, lineItems: [LINE_ITEM('q')],
}), (o) => { ctx.quoteId = firstId(o); created.push({ kind: 'quote', id: ctx.quoteId }); });
await step('update_quote', () => ({ quoteId: ctx.quoteId, message: 'updated by test' }));
await step('create_quote_text_line_items', () => ({
  quoteId: ctx.quoteId, lineItems: [{ name: `${TAG} note`, description: 'text only' }],
}));
await step('convert_quote_to_job', () => ({ quoteId: ctx.quoteId }),
  (o) => { const j = firstId(o); if (j) created.push({ kind: 'job', id: j }); });

console.log('\n=== phase 5: requests ===');
await step('create_request', () => ({ clientId: ctx.clientId, title: `${TAG} request` }),
  (o) => { ctx.requestId = firstId(o); created.push({ kind: 'request', id: ctx.requestId }); });
await step('update_request', () => ({ requestId: ctx.requestId, title: `${TAG} request edited` }));
await step('assign_request', () => ({ requestId: ctx.requestId, userId: ctx.userId }));
await step('archive_request', () => ({ requestId: ctx.requestId }));
await step('unarchive_request', () => ({ requestId: ctx.requestId }));

console.log('\n=== phase 6: expenses + products ===');
await step('create_expense', () => ({
  title: `${TAG} expense`, date: new Date().toISOString(), total: 42.5,
}), (o) => { ctx.expenseId = firstId(o); created.push({ kind: 'expense', id: ctx.expenseId }); });
await step('update_expense', () => ({ expenseId: ctx.expenseId, total: 43.75 }));
await step('create_product', () => ({ name: `${TAG} product`, defaultUnitCost: 19.99 }),
  (o) => { ctx.productId = firstId(o); created.push({ kind: 'product', id: ctx.productId }); });
await step('update_product', () => ({ productId: ctx.productId, description: 'updated by test' }));

console.log('\n=== phase 7: taxes + invoices ===');
await step('create_tax_rate', () => ({ name: `${TAG} tax`, rate: 7.5 }),
  (o) => { ctx.taxRateId = firstId(o); created.push({ kind: 'taxRate', id: ctx.taxRateId }); });
await step('create_tax_group', () => ({
  name: `${TAG} tax group`, taxRateIds: [ctx.taxRateId],
}), (o) => { const t = firstId(o); if (t) created.push({ kind: 'taxGroup', id: t }); });
await step('create_invoice', () => ({
  clientId: ctx.clientId, subject: `${TAG} invoice`, lineItems: [LINE_ITEM('i')],
}), (o) => { ctx.invoiceId = firstId(o); created.push({ kind: 'invoice', id: ctx.invoiceId }); });
await step('update_invoice', () => ({ invoiceId: ctx.invoiceId, message: 'updated by test' }));
await step('send_invoice', () => ({ invoiceId: ctx.invoiceId }));
await step('close_invoice', () => ({ invoiceId: ctx.invoiceId, closeOption: 'MARK_RECEIVED' }));
await step('reopen_invoice', () => ({ invoiceId: ctx.invoiceId }));
await step('close_invoice', () => ({ invoiceId: ctx.invoiceId, closeOption: 'BAD_DEBT' }));
await step('unmark_invoice_bad_debt', () => ({ invoiceId: ctx.invoiceId }));
// Void last: an open invoice blocks archiving the client in cleanup.
await step('void_invoice', () => ({
  invoiceId: ctx.invoiceId, voidReasonCode: 'CREATED_IN_ERROR',
  voidReasonDetails: 'automated tool verification',
}), () => { const inv = created.find((c) => c.id === ctx.invoiceId); if (inv) inv.cleanup = 'voided'; });

console.log('\n=== phase 8: job + team lifecycle ===');
await step('close_job', () => ({ jobId: ctx.jobId }));
await step('reopen_job', () => ({ jobId: ctx.jobId }));
// Write the user's existing name back: exercises the mutation without
// actually renaming a real team member.
if (ctx.userId && ctx.userName) {
  await step('update_user', () => ({ userId: ctx.userId, name: ctx.userName }));
} else {
  console.log('skip  update_user  (no user/name discovered)');
}

console.log('\n=== cleanup ===');
if (!dryRun) {
  if (ctx.expenseId) {
    try { await call('delete_expense', { expenseId: ctx.expenseId });
      console.log('deleted expense');
      const e = created.find((c) => c.id === ctx.expenseId); if (e) e.cleanup = 'deleted';
    } catch (e) { console.log(`could not delete expense: ${e.message.slice(0, 120)}`); }
  }
  // Delete visits BEFORE closing jobs: close_job's default
  // COMPLETE_PAST_DESTROY_FUTURE already destroys future-dated visits, after
  // which delete_visits fails with "Visit does not exist".
  const visitIds = created.filter((c) => c.kind === 'visit').map((c) => c.id).filter(Boolean);
  if (visitIds.length) {
    try { await call('delete_visits', { visitIds }); console.log(`deleted ${visitIds.length} visit(s)`);
      for (const c of created) if (c.kind === 'visit') c.cleanup = 'deleted';
    } catch (e) { console.log(`could not delete visits: ${e.message.slice(0, 120)}`); }
  }
  // Close EVERY job created, not just the first: convert_quote_to_job makes a
  // second one, and any open job blocks archiving the client.
  for (const j of created.filter((c) => c.kind === 'job')) {
    try { await call('close_job', { jobId: j.id }); j.cleanup = 'closed'; } catch {}
  }
  if (created.some((c) => c.kind === 'job')) console.log('closed jobs');
  if (ctx.requestId) {
    try { await call('archive_request', { requestId: ctx.requestId }); console.log('archived request');
      const r = created.find((c) => c.id === ctx.requestId); if (r) r.cleanup = 'archived';
    } catch {}
  }
  // Products cannot be deleted; hiding is the closest thing available.
  for (const p of created.filter((c) => c.kind === 'product')) {
    try { await call('update_product', { productId: p.id, visible: false }); p.cleanup = 'hidden'; } catch {}
  }
  if (ctx.clientId) {
    // Archiving the client is the strongest removal Jobber offers and hides
    // the whole chain hanging off it. Round-trip through unarchive so that
    // mutation is exercised too, then leave the client archived.
    try {
      await call('archive_client', { clientId: ctx.clientId }); console.log('archived client');
      await call('unarchive_client', { clientId: ctx.clientId }); console.log('unarchived client (round-trip)');
      pass.push('unarchive_client');
      await call('archive_client', { clientId: ctx.clientId }); console.log('re-archived client');
      const c = created.find((x) => x.id === ctx.clientId); if (c) c.cleanup = 'archived';
    } catch (e) { console.log(`client archive round-trip failed: ${e.message.slice(0, 160)}`); }
  }
}

console.log(`\n${'='.repeat(64)}`);
console.log(`${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log('\nFailures:');
  for (const f of fail) console.log(`  ${f.tool}: ${f.msg}`);
}
console.log(`\nRecords created (marker ${TAG}):`);
for (const c of created) {
  console.log(`  ${c.kind.padEnd(10)} ${c.cleanup ?? 'RESIDUE — Jobber exposes no delete'}`);
}
process.exit(fail.length ? 1 : 0);
