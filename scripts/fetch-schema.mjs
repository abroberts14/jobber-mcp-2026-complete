#!/usr/bin/env node
/**
 * Snapshot Jobber's GraphQL schema for offline validation.
 *
 * Deliberately takes an access token rather than driving the OAuth refresh
 * itself: refresh tokens are single-use and the deployed server owns the token
 * chain, so a second refresher here could invalidate its store.
 *
 *   JOBBER_ACCESS_TOKEN=... node scripts/fetch-schema.mjs
 *
 * To borrow the deployed container's live access token:
 *   CID=$(docker ps -q --filter name=<app-uuid>)
 *   export JOBBER_ACCESS_TOKEN=$(docker exec $CID node -e \
 *     'process.stdout.write(require("/data/tokens.json").accessToken)')
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getIntrospectionQuery, buildClientSchema, printSchema } from 'graphql';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const token = process.env.JOBBER_ACCESS_TOKEN;
if (!token) {
  console.error('JOBBER_ACCESS_TOKEN is required (see header comment).');
  process.exit(2);
}

const API_URL = process.env.JOBBER_API_URL || 'https://api.getjobber.com/api/graphql';
const VERSION = process.env.JOBBER_GRAPHQL_VERSION || '2026-07-27';

const res = await fetch(API_URL, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-JOBBER-GRAPHQL-VERSION': VERSION,
  },
  body: JSON.stringify({ query: getIntrospectionQuery() }),
});

const body = await res.json();
if (body.errors) {
  console.error('Introspection failed:', JSON.stringify(body.errors).slice(0, 800));
  process.exit(1);
}

// Jobber reports the version it actually served here. An unrecognized version
// is NOT an error — it silently falls back to a long-deprecated one — so this
// is the only reliable confirmation that VERSION was honored.
const versioning = body.extensions?.versioning;
if (versioning) {
  console.log(`served version: ${versioning.version}`);
  if (versioning.warning) console.warn(`WARNING: ${versioning.warning}`);
}
if (versioning?.version && versioning.version !== VERSION) {
  console.error(`Requested ${VERSION} but Jobber served ${versioning.version}.`);
  process.exit(1);
}

const outDir = join(root, 'schema');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'jobber-schema.json'), JSON.stringify(body.data));
writeFileSync(join(outDir, 'jobber-schema.graphql'), printSchema(buildClientSchema(body.data)));

const schema = buildClientSchema(body.data);
console.log(
  `wrote schema/ — ${body.data.__schema.types.length} types, ` +
    `${Object.keys(schema.getQueryType().getFields()).length} queries, ` +
    `${Object.keys(schema.getMutationType().getFields()).length} mutations`
);
