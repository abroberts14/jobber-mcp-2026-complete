#!/usr/bin/env node
/**
 * Deeper static audit than validate-graphql.mjs.
 *
 * Document validation only inspects the query TEXT. Two whole classes of bug
 * survive it, and both are already present in this codebase's history:
 *
 *   1. VARIABLES. `validate(schema, document)` never looks at the JS object
 *      passed as variables. A mutation declaring `$input: JobEditInput!` while
 *      building `{ description }` (the real field is `instructions`) is a
 *      perfectly valid document that fails at runtime. Every create_/update_
 *      tool is exposed to this.
 *
 *   2. RESPONSE SHAPE. Tools post-process what comes back. A tool doing
 *      `data.job.visits.map(...)` when `visits` is a Connection returning
 *      `{ nodes }` validates clean and quietly returns nothing.
 *
 * This script closes both by coercing each tool's actual variables against the
 * schema's input types, then re-running the tool against a response synthesized
 * from the schema for its own selection set.
 *
 * Still 100% offline. No request is ever sent to Jobber.
 *
 *   node scripts/audit-tools.mjs [--json] [--module NAME] [--dist DIR]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  buildClientSchema, parse, validate, specifiedRules, typeFromAST,
  isNonNullType, isListType, isInputObjectType, isEnumType, isScalarType,
  isObjectType, isInterfaceType, isUnionType, getNamedType,
} from 'graphql';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const onlyModule = argv.includes('--module') ? argv[argv.indexOf('--module') + 1] : null;
const distDir = argv.includes('--dist') ? resolve(argv[argv.indexOf('--dist') + 1]) : join(root, 'dist');

const SCHEMA_PATH = process.env.JOBBER_SCHEMA_JSON || join(root, 'schema', 'jobber-schema.json');
if (!existsSync(SCHEMA_PATH)) {
  console.error(`Schema not found at ${SCHEMA_PATH}. Run: npm run schema:fetch`);
  process.exit(2);
}
const schema = buildClientSchema(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

/* ------------------------------------------------------------------ */
/* 1. Variable coercion                                                */
/* ------------------------------------------------------------------ */

const SCALAR_OK = {
  Int: (v) => Number.isInteger(v),
  Float: (v) => typeof v === 'number',
  String: (v) => typeof v === 'string',
  Boolean: (v) => typeof v === 'boolean',
};

/** Collect every way `value` fails to satisfy input `type`. */
function coerce(value, type, path, errors) {
  if (isNonNullType(type)) {
    if (value === null || value === undefined) {
      errors.push(`${path || 'value'} is required (${type}) but was ${value}`);
      return;
    }
    return coerce(value, type.ofType, path, errors);
  }
  if (value === null || value === undefined) return; // nullable, fine

  if (isListType(type)) {
    const items = Array.isArray(value) ? value : [value];
    items.forEach((item, i) => coerce(item, type.ofType, `${path}[${i}]`, errors));
    return;
  }

  if (isInputObjectType(type)) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} should be an object of type ${type.name}, got ${typeof value}`);
      return;
    }
    const fields = type.getFields();
    for (const key of Object.keys(value)) {
      if (!fields[key]) {
        const near = Object.keys(fields)
          .filter((f) => f.toLowerCase().includes(key.toLowerCase().slice(0, 4)))
          .slice(0, 3);
        errors.push(
          `${path}.${key} is not a field on ${type.name}` +
            (near.length ? ` (did you mean ${near.join(', ')}?)` : '')
        );
      }
    }
    for (const [name, field] of Object.entries(fields)) {
      if (isNonNullType(field.type) && field.defaultValue === undefined &&
          (value[name] === undefined || value[name] === null)) {
        errors.push(`${path}.${name} is required on ${type.name} but was not provided`);
      }
      if (value[name] !== undefined) {
        coerce(value[name], field.type, `${path}.${name}`, errors);
      }
    }
    return;
  }

  if (isEnumType(type)) {
    const allowed = type.getValues().map((v) => v.name);
    if (!allowed.includes(value)) {
      errors.push(`${path} = ${JSON.stringify(value)} is not a valid ${type.name} (allowed: ${allowed.slice(0, 8).join(', ')}${allowed.length > 8 ? ', …' : ''})`);
    }
    return;
  }

  if (isScalarType(type)) {
    const check = SCALAR_OK[type.name];
    if (check && !check(value)) {
      errors.push(`${path} = ${JSON.stringify(value)} is not a valid ${type.name}`);
    }
  }
}

/** Check a document's declared variables against the values actually passed. */
function auditVariables(doc, variables, errors) {
  let ast;
  try {
    ast = parse(doc);
  } catch {
    return; // document validation already reports syntax errors
  }
  for (const def of ast.definitions) {
    if (def.kind !== 'OperationDefinition') continue;
    for (const vd of def.variableDefinitions ?? []) {
      const name = vd.variable.name.value;
      const type = typeFromAST(schema, vd.type);
      if (!type) continue;
      const provided = variables ? variables[name] : undefined;
      const hasDefault = vd.defaultValue !== undefined && vd.defaultValue !== null;
      if (provided === undefined && (hasDefault || !isNonNullType(type))) continue;
      coerce(provided, type, `$${name}`, errors);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Response synthesis                                               */
/* ------------------------------------------------------------------ */

const scalarSample = (name) => {
  switch (name) {
    case 'Int': return 1;
    case 'Float': return 1.5;
    case 'Boolean': return true;
    case 'EncodedId': case 'ID': return 'Z2lkOi8vSm9iYmVyL1NhbXBsZS8x';
    case 'ISO8601DateTime': return '2026-01-01T00:00:00Z';
    case 'ISO8601Date': return '2026-01-01';
    case 'Seconds': case 'Minutes': return 60;
    default: return 'sample';
  }
};

/** Build a response object matching `selectionSet` as resolved against `type`. */
function synth(type, selectionSet, fragments, depth = 0) {
  const named = getNamedType(type);
  if (isListType(type) || (isNonNullType(type) && isListType(type.ofType))) {
    const inner = isNonNullType(type) ? type.ofType : type;
    return [synth(inner.ofType, selectionSet, fragments, depth + 1)];
  }
  if (isNonNullType(type)) return synth(type.ofType, selectionSet, fragments, depth);

  if (isScalarType(named)) return scalarSample(named.name);
  if (isEnumType(named)) return named.getValues()[0]?.name ?? 'SAMPLE';
  if (depth > 8 || !selectionSet) return null;

  if (isObjectType(named) || isInterfaceType(named) || isUnionType(named)) {
    const out = {};
    const fields = isUnionType(named) ? {} : named.getFields();
    for (const sel of selectionSet.selections) {
      if (sel.kind === 'Field') {
        const key = sel.alias?.value ?? sel.name.value;
        if (sel.name.value === '__typename') { out[key] = named.name; continue; }
        const field = fields[sel.name.value];
        if (!field) continue;
        // Replay the SUCCESS path: a populated userErrors list would make every
        // well-written tool throw, which tells us nothing about response shape.
        out[key] = /errors$/i.test(sel.name.value)
          ? []
          : synth(field.type, sel.selectionSet, fragments, depth + 1);
      } else if (sel.kind === 'FragmentSpread') {
        const frag = fragments[sel.name.value];
        if (frag) Object.assign(out, synth(named, frag.selectionSet, fragments, depth));
      } else if (sel.kind === 'InlineFragment') {
        Object.assign(out, synth(named, sel.selectionSet, fragments, depth));
      }
    }
    return out;
  }
  return null;
}

/** Synthesize the `data` payload for a whole operation document. */
function synthesizeResponse(doc) {
  const ast = parse(doc);
  const fragments = {};
  for (const d of ast.definitions) if (d.kind === 'FragmentDefinition') fragments[d.name.value] = d;
  const op = ast.definitions.find((d) => d.kind === 'OperationDefinition');
  if (!op) return {};
  const rootType = op.operation === 'mutation' ? schema.getMutationType() : schema.getQueryType();
  return synth(rootType, op.selectionSet, fragments);
}

/* ------------------------------------------------------------------ */

function permissive() {
  const fn = () => permissive();
  return new Proxy(fn, {
    get(_t, p) {
      if (p === 'then') return undefined;
      if (p === Symbol.iterator) return function* () {};
      if (p === 'map' || p === 'filter' || p === 'flatMap') return () => [];
      if (p === 'length') return 0;
      return permissive();
    },
    apply: () => permissive(),
  });
}

function sampleFor(def, key = '') {
  const d = def?._def;
  if (!d) return undefined;
  switch (d.typeName) {
    case 'ZodOptional': case 'ZodNullable': return sampleFor(d.innerType, key);
    case 'ZodDefault': return d.defaultValue();
    case 'ZodString':
      if (/id$/i.test(key)) return 'Z2lkOi8vSm9iYmVyL1NhbXBsZS8x';
      if (/email/i.test(key)) return 'sample@example.com';
      if (/(date|at|start|end)$/i.test(key)) return '2026-01-01T00:00:00Z';
      if (/timezone/i.test(key)) return 'UTC';
      return 'sample';
    case 'ZodNumber': return 1;
    case 'ZodBoolean': return true;
    case 'ZodEnum': return d.values[0];
    case 'ZodNativeEnum': return Object.values(d.values)[0];
    case 'ZodArray': return [sampleFor(d.type, key)];
    case 'ZodObject': {
      const o = {};
      for (const [k, v] of Object.entries(d.shape())) o[k] = sampleFor(v, k);
      return o;
    }
    case 'ZodUnion': return sampleFor(d.options[0], key);
    case 'ZodLiteral': return d.value;
    case 'ZodRecord': return {};
    default: return 'sample';
  }
}

// Discovered from disk so a newly added tool module is validated automatically
// rather than silently skipped because someone forgot this list.
const MODULES = readdirSync(join(distDir, 'tools'))
  .filter((f) => f.endsWith('-tools.js'))
  .map((f) => f.replace(/\.js$/, ''))
  .sort();

const results = [];

for (const mod of MODULES) {
  if (onlyModule && mod !== onlyModule) continue;
  const path = join(distDir, 'tools', `${mod}.js`);
  if (!existsSync(path)) continue;
  const ns = await import(path);
  const tools = Object.values(ns).find((v) => v && typeof v === 'object');
  if (!tools) continue;

  for (const [name, tool] of Object.entries(tools)) {
    const docErrors = [];
    const varErrors = [];
    const shapeErrors = [];

    // --- capture pass: what documents and variables does this tool send?
    const calls = [];
    const capturing = {
      query: (q, v) => (calls.push({ doc: q, vars: v }), permissive()),
      mutate: (m, v) => (calls.push({ doc: m, vars: v }), permissive()),
      paginate: async function* () {},
    };
    const args = sampleFor(tool.inputSchema);
    try {
      await tool.execute(capturing, args);
    } catch { /* post-processing against the proxy may throw; irrelevant here */ }

    if (!calls.length) {
      results.push({ module: mod, tool: name, status: 'NO_DOCUMENT', docErrors: [], varErrors: [], shapeErrors: [] });
      continue;
    }

    for (const { doc, vars } of calls) {
      let ast;
      try { ast = parse(doc); } catch (e) { docErrors.push(`SYNTAX: ${e.message}`); continue; }
      for (const err of validate(schema, ast, specifiedRules)) docErrors.push(err.message);
      auditVariables(doc, vars, varErrors);
    }

    // --- replay pass: does post-processing survive a realistic response?
    if (docErrors.length === 0) {
      let i = 0;
      const realistic = {
        query: () => { try { return synthesizeResponse(calls[Math.min(i, calls.length - 1)].doc); } finally { i++; } },
        mutate: () => { try { return synthesizeResponse(calls[Math.min(i, calls.length - 1)].doc); } finally { i++; } },
        paginate: async function* () {},
      };
      try {
        const out = await tool.execute(realistic, args);
        if (out === undefined) shapeErrors.push('execute() returned undefined for a well-formed response');
      } catch (e) {
        shapeErrors.push(`post-processing threw on a schema-shaped response: ${e?.message ?? e}`);
      }
    }

    const status =
      docErrors.length ? 'DOC_INVALID'
      : varErrors.length ? 'BAD_VARIABLES'
      : shapeErrors.length ? 'BAD_RESPONSE_HANDLING'
      : 'OK';
    results.push({ module: mod, tool: name, status, docErrors, varErrors, shapeErrors });
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results.filter((x) => x.status !== 'OK')) {
    console.log(`\n${r.status}  ${r.module} :: ${r.tool}`);
    for (const e of [...new Set([...r.docErrors, ...r.varErrors, ...r.shapeErrors])]) {
      console.log(`    ${e}`);
    }
  }
  const ok = results.filter((r) => r.status === 'OK').length;
  const by = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`${ok}/${results.length} tools fully clean`);
  console.log(`  invalid document      ${by('DOC_INVALID')}`);
  console.log(`  bad variables         ${by('BAD_VARIABLES')}`);
  console.log(`  bad response handling ${by('BAD_RESPONSE_HANDLING')}`);
  console.log(`  issued no document    ${by('NO_DOCUMENT')}`);
}

process.exit(results.some((r) => r.status !== 'OK') ? 1 : 0);
