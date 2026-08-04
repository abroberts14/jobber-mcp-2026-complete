#!/usr/bin/env node
/**
 * Validate every tool's GraphQL document against the live Jobber schema.
 *
 * Tools build their queries by string interpolation at call time, so the only
 * faithful way to see the real document is to run `execute` with a client that
 * captures the string instead of sending it. Post-processing (`data.jobs.edges
 * .map(...)`) then runs against a permissive proxy so a tool can issue several
 * queries in one call without the first shape mismatch aborting it.
 *
 * Static validation only — no mutation is ever sent to Jobber.
 *
 *   node scripts/validate-graphql.mjs [--json] [--tool NAME] [--module NAME]
 *
 * Schema comes from JOBBER_SCHEMA_JSON (introspection result), default
 * ./schema/jobber-schema.json.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildClientSchema, parse, validate, specifiedRules } from 'graphql';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const SCHEMA_PATH =
  process.env.JOBBER_SCHEMA_JSON || join(root, 'schema', 'jobber-schema.json');

if (!existsSync(SCHEMA_PATH)) {
  console.error(
    `Schema introspection not found at ${SCHEMA_PATH}.\n` +
      `Run: node scripts/fetch-schema.mjs   (or set JOBBER_SCHEMA_JSON)`
  );
  process.exit(2);
}

const schema = buildClientSchema(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

/** Every property access yields another proxy; list-ish access yields []. */
function permissive() {
  const fn = () => permissive();
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined; // must not look thenable
      if (prop === Symbol.toPrimitive || prop === Symbol.toStringTag)
        return () => 'x';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'length') return 0;
      if (prop === 'map' || prop === 'filter' || prop === 'flatMap')
        return () => [];
      return permissive();
    },
    apply: () => permissive(),
  });
}

/** Minimal value satisfying a Zod schema, enough to interpolate realistically. */
function sampleFor(def, key = '') {
  const d = def?._def;
  if (!d) return undefined;
  switch (d.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
      return sampleFor(d.innerType, key);
    case 'ZodDefault':
      return d.defaultValue();
    case 'ZodString': {
      if (/id$/i.test(key)) return 'Z2lkOi8vSm9iYmVyL1NhbXBsZS8x';
      if (/(email)/i.test(key)) return 'sample@example.com';
      if (/(date|at|start|end)$/i.test(key)) return '2026-01-01T00:00:00Z';
      return 'sample';
    }
    case 'ZodNumber':
      return 1;
    case 'ZodBoolean':
      return true;
    case 'ZodEnum':
      return d.values[0];
    case 'ZodNativeEnum':
      return Object.values(d.values)[0];
    case 'ZodArray':
      return [sampleFor(d.type, key)];
    case 'ZodObject': {
      const out = {};
      for (const [k, v] of Object.entries(d.shape())) out[k] = sampleFor(v, k);
      return out;
    }
    case 'ZodUnion':
      return sampleFor(d.options[0], key);
    case 'ZodRecord':
      return {};
    case 'ZodLiteral':
      return d.value;
    case 'ZodAny':
    case 'ZodUnknown':
      return 'sample';
    default:
      return 'sample';
  }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const onlyTool = args.includes('--tool') ? args[args.indexOf('--tool') + 1] : null;
const onlyModule = args.includes('--module') ? args[args.indexOf('--module') + 1] : null;
// Lets concurrent workers compile to their own outDir instead of racing on dist/.
const distDir = args.includes('--dist')
  ? resolve(args[args.indexOf('--dist') + 1])
  : join(root, 'dist');

// Discovered from disk so a newly added tool module is validated automatically
// rather than silently skipped because someone forgot this list.
const MODULES = readdirSync(join(distDir, 'tools'))
  .filter((f) => f.endsWith('-tools.js'))
  .map((f) => f.replace(/\.js$/, ''))
  .sort();

const results = [];

for (const mod of MODULES) {
  if (onlyModule && mod !== onlyModule) continue;
  const ns = await import(join(distDir, 'tools', `${mod}.js`));
  const tools = Object.values(ns).find((v) => v && typeof v === 'object');
  for (const [name, tool] of Object.entries(tools)) {
    if (onlyTool && name !== onlyTool) continue;

    const docs = [];
    const client = {
      query: (q) => (docs.push(q), permissive()),
      mutate: (m) => (docs.push(m), permissive()),
      paginate: async function* () {},
    };

    let runtimeError = null;
    try {
      await tool.execute(client, sampleFor(tool.inputSchema));
    } catch (e) {
      runtimeError = e?.message ?? String(e);
    }

    if (docs.length === 0) {
      results.push({
        module: mod, tool: name, status: 'NO_DOCUMENT',
        errors: [runtimeError ?? 'execute() issued no GraphQL document'],
      });
      continue;
    }

    const errors = [];
    for (const doc of docs) {
      let ast;
      try {
        ast = parse(doc);
      } catch (e) {
        errors.push(`SYNTAX: ${e.message}`);
        continue;
      }
      for (const err of validate(schema, ast, specifiedRules)) {
        errors.push(err.message);
      }
    }

    results.push({
      module: mod, tool: name,
      status: errors.length ? 'INVALID' : 'VALID',
      docCount: docs.length,
      errors,
    });
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const bad = results.filter((r) => r.status !== 'VALID');
  for (const r of bad) {
    console.log(`\n${r.status}  ${r.module} :: ${r.tool}`);
    for (const e of [...new Set(r.errors)]) console.log(`    ${e}`);
  }
  const valid = results.length - bad.length;
  console.log(
    `\n${'='.repeat(60)}\n${valid}/${results.length} tools valid against the schema` +
      (bad.length ? `  —  ${bad.length} need fixing` : '  —  all clean')
  );
}

process.exit(results.some((r) => r.status !== 'VALID') ? 1 : 0);
