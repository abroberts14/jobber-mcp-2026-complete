# Jobber MCP — Handoff

Status as of 2026-08-03. Everything below was verified against a live Jobber
account unless explicitly marked otherwise.

---

## 1. What this is

An MCP server exposing **73 tools** over Jobber's GraphQL API (15 tool modules
under `src/tools/`). It ships two transports:

| Transport | Entry point | Use |
| --- | --- | --- |
| stdio | `dist/index.js` | One subprocess per MCP client (local default) |
| Streamable HTTP | `dist/http.js` | One shared service for the team |

It is **single-tenant**. Every caller acts as the one Jobber account the server
is authorized against. This is an access gate for a team that already shares an
account — not a multi-user system.

> The tool count was 102. It is now 73 because 29 tools called Jobber
> queries/mutations that do not exist. See §4.

---

## 2. Authentication: how Jobber actually works

Jobber issues **no static API keys or personal access tokens**. The real model
is OAuth 2.0:

1. Register an app at [developer.getjobber.com](https://developer.getjobber.com)
   → client ID + secret.
2. Authorization code grant → access token + refresh token.
3. **Access tokens expire after 60 minutes.**
4. **Refresh tokens are single-use.** Concurrent refreshes with the same token
   fail with `invalid_grant` — this is what the token-store lock in §3 exists
   to prevent.

### Bootstrapping

```bash
cp .env.example .env          # fill in client ID + secret
npm run authorize             # one-time OAuth flow
```

`npm run authorize` prints a `JOBBER_REFRESH_TOKEN` for `.env` and caches the
token pair. It accepts either a pasted redirect URL or a bare code, and verifies
the OAuth `state` parameter.

The `JOBBER_REDIRECT_URI` currently in `.env` is a tunnel hostname that doubles
as the internal API's OAuth callback, so **the code must be pasted in by hand**.
Cosmetic, not blocking. Point the redirect at a loopback URI (or set
`JOBBER_CALLBACK_PORT`) and the CLI captures the code automatically.

---

## 3. ⚠️ The one rule that will break things

**Only one token store may be live per Jobber app.**

A single Jobber app backs both local and team use. Consequence:

> Now that the hosted server is running, **do not also run the stdio server
> against the same app.** Each will invalidate the other's refresh token, and
> recovery means re-running `npm run authorize`.

The supported setup:

- The hosted HTTP server owns the token chain.
- Everyone — including you, locally — connects to it over HTTP with the bearer
  secret. See §7.

**Within** a single store, concurrency is safe: `TokenStore` takes an O_EXCL
lockfile and a process that loses the race re-reads and adopts the winner's
tokens rather than replaying a spent one.

If you need to hit Jobber directly from a script, take the **access** token from
the deployed container and never the refresh token — that is exactly what
`scripts/fetch-schema.mjs` and `scripts/live-read-check.mjs` do, and why neither
accepts a refresh token.

---

## 4. The GraphQL API version and schema (read this before touching a tool)

### The version trap

`X-JOBBER-GRAPHQL-VERSION` fails **silently**. An unrecognized version is not
rejected — Jobber serves `2022-09-01` (long unsupported) and mentions the
fallback only in `extensions.versioning`. A typo therefore degrades quietly
instead of erroring.

| Version | Result |
| --- | --- |
| `2024-01-11` | not a version; no `versioning` block at all |
| `2025-01-20` | real, but **past end-of-support**, warns it may vanish without notice |
| `2026-07-27` | current, no warning — **what we now use** |

`npm run schema:fetch` asserts the served version equals the requested one, so
this cannot regress unnoticed.

### What was wrong

The tool layer had **never been validated against the schema**. At version
`2026-07-27`, **2 of 102 tools** produced a valid GraphQL document. Causes, in
rough order of frequency:

- IDs typed `ID!` where Jobber uses `EncodedId!`
- Status enum values uppercased (`ACTIVE`) where Jobber uses lowercase (`active`)
- Entity fields selected directly on a `*Connection` instead of through `nodes`
- `XUpdate` mutations — Jobber names them `XEdit`, with entity-named ID
  arguments (`jobId:`, not `id:`)
- Money selected as `{ amount currency }`; it is a plain `Float`, and
  quote/invoice totals live under `amounts { … }`
- Whole feature areas that simply do not exist in the API

### What does not exist in Jobber's API

29 tools were deleted because there is no counterpart at any version:

| Area | Deleted | Why |
| --- | --- | --- |
| Forms | all 8 | No `forms`/`form`/`formSubmission*` query and no `form*` mutation. Job forms are not a public API resource. Module is now empty. |
| Timesheet writes | 4 | `timeSheetEntries` is readable; there is **no** timesheet mutation of any kind. |
| Tax writes | 5 | No `taxUpdate`/`taxDelete`/`lineItemTaxApply`/`lineItemTaxRemove`/`invoiceOrQuote`. |
| Quote actions | 3 | No `quoteSend`/`quoteApprove`; approval is a client-hub action. |
| Payments | 2 | No payment-recording mutation exists. |
| Request conversion | 2 | No `requestConvertToJob`/`requestConvertToQuote`. |
| Misc | 5 | `jobArchive`, `propertyDelete`, `set_default_property`, `productArchive`, `approve_expense` — no mutations. |

### Behavior changes worth knowing

- `send_invoice` → `invoiceMarkAsSent`, which takes only an ID; the old custom
  `message` had nowhere to go.
- `convert_quote_to_job` rebuilt on `jobCreate` with `quoteId`.
- `create_job`/`create_quote`/`create_invoice` gained required fields because the
  API requires them (`JobCreateAttributes.invoicing` is non-null; quotes and
  invoices require line items).
- `list_users` now takes `status: ACTIVATED|DEACTIVATED` — the filter's `status`
  is non-null whenever a filter is supplied.
- Expense `amount` → `total`; product `unitPrice` → `defaultUnitCost`.
- Line items have no unified type. `create_line_items`/`edit_line_items`/
  `delete_line_items` take a `parent` discriminator (`job|quote|visit|request`)
  and dispatch to the parent-scoped mutation.
- Reporting has no `reports` query; all 5 tools are client-side aggregations
  over real queries, and each description states what it actually computes.

---

## 5. Verification: what is proven, and what is not

Three layers, in increasing strength. **Run them in this order.**

```bash
npm run schema:fetch      # refresh schema/ from live Jobber (needs an access token)
npm run validate:graphql  # layer 1
node scripts/audit-tools.mjs   # layers 1+2+3
```

| Layer | Script | Catches |
| --- | --- | --- |
| 1. Document | `validate-graphql.mjs` | Fields/args/enums/types that don't exist |
| 2. Variables | `audit-tools.mjs` | Wrong keys in the variables object — invisible to layer 1 |
| 3. Response shape | `audit-tools.mjs` | Post-processing that mishandles a schema-shaped response |

Layer 2 matters because `validate(schema, document)` never inspects the
variables object. A mutation declaring `$input: JobEditInput!` while building
`{ description }` (the real field is `instructions`) is a **valid document that
fails at runtime** — the codebase's original bug, relocated. This layer caught
exactly that in `create_job` (`invoicing` is non-null and was missing).

All three are **fully offline and never send a mutation.**

### Current results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| Document validation | **73/73** |
| Deep audit (documents + variables + response shape) | **73/73** |
| Live read-only run against real Jobber | **33 passed, 0 failed, 5 skipped** |

The 5 skips are `get_invoice`, `list_invoice_payments`, `get_expense`,
`get_timesheet_entry`, `get_tax_rate` — the test account holds no invoices,
expenses, timesheet entries, or tax rates, so no real ID exists to fetch.

### ⚠️ What is still NOT proven

**No mutation has ever been executed against Jobber.** Roughly half the tools
(every `create_`/`update_`/`delete_`/`archive_`) are verified statically only.
Static analysis is strong here — it checks the document, the variables, and the
response handling — but it cannot prove Jobber accepts the write, and it cannot
catch permission scopes, business-rule rejections, or throttling.

Closing that gap means writing real records into a live Jobber account. Options:
a separate sandbox account, or production with cleanup — noting some Jobber
objects cannot be hard-deleted, so residue is likely. **This has not been done
and requires an explicit decision.**

---

## 6. Deployment (Coolify on the Mac mini) — DONE

Live at **`https://jobber-mcp.aaronroberts.xyz/mcp`**.

| Item | Value |
| --- | --- |
| Coolify project | `jobber-mcp` (`wsx0mj9p6dg4fycpi5gqjamo`) |
| Application | `jobber-mcp` (`v97einys55h5vuerubtg74c1`) |
| Server | `mac-mini-colima`, network `coolify` |
| Source | public GitHub repo, branch `main`, Dockerfile build |
| Volume | `/data` (persistent) — **not optional**, see below |
| Cloudflare | tunnel `baseball-model` ingress + proxied CNAME |

Two traps worth recording:

1. **Coolify's healthcheck overrides the Dockerfile's.** It shells out to
   `curl`/`wget`, neither of which exists in `node:22-bookworm-slim`, so the
   first deploy failed with a healthy container. Fix: disable the Coolify
   healthcheck so it uses the image's own `HEALTHCHECK` (which uses Node's
   built-in fetch). Coolify then reports `custom_healthcheck_found: true`.
2. **FQDN uses the `http` scheme on purpose.** Cloudflare terminates TLS at the
   edge; an `https` FQDN makes Traefik redirect-loop behind the tunnel.

The `/data` volume is the source of truth for tokens. `JOBBER_REFRESH_TOKEN` in
the Coolify env is a bootstrap value and goes stale after first boot — that is
correct, not a bug.

---

## 7. Connecting clients

The server refuses to start without `JOBBER_MCP_SECRET`: the tool set can mutate
the Jobber account, so an unauthenticated public endpoint would let anyone who
finds the URL write to it.

```bash
claude mcp add --transport http jobber https://jobber-mcp.aaronroberts.xyz/mcp \
  -H "Authorization: Bearer <JOBBER_MCP_SECRET>"
```

`GET /health` is unauthenticated and returns `{"status":"ok"}`.

---

## 8. Known gaps

- **No mutation has been executed.** See §5. This is the largest remaining gap.
- **No read-only mode.** `readOnlyHint` is derived from the tool name prefix and
  is advisory. Filter `allTools` behind a `JOBBER_MCP_READ_ONLY` flag if most of
  the team should not be able to write.
- **One shared secret, no per-user identity.** No audit trail of who called what.
- **No unit test suite.** The three verification scripts are committed and
  repeatable, but there is no `npm test`.
- **`src/types/jobber.ts` is stale** — it still describes the pre-fix shapes
  (e.g. a `LineItem` type Jobber does not have). Tool modules no longer import
  the dead types, but the file should be regenerated from the schema.
- **`src/main.ts` is a byte-identical duplicate of `src/index.ts`**; only
  `index.ts` is wired to `bin`.
- **`forms-tools.ts` exports an empty object** and is still spread into
  `allTools`. Harmless, and self-documenting, but could be removed.
- **`react`/`react-dom` are runtime `dependencies`** (for `src/ui/react-app/`),
  so they land in the production image unnecessarily.

---

## 9. File map

| Path | Role |
| --- | --- |
| `src/auth/oauth.ts` | Authorize URL, code exchange, refresh |
| `src/auth/token-store.ts` | Atomic writes + O_EXCL lockfile with stale-lock breaking |
| `src/auth/authorize-cli.ts` | One-time OAuth bootstrap (`npm run authorize`) |
| `src/clients/jobber.ts` | GraphQL client, API version, shared field fragments |
| `src/server.ts` | Runtime/MCP server construction, stdio `JobberServer` |
| `src/http.ts` | Streamable HTTP transport, bearer auth, `/health` |
| `scripts/fetch-schema.mjs` | Snapshot the schema; asserts served version |
| `scripts/validate-graphql.mjs` | Layer 1 — document validation |
| `scripts/audit-tools.mjs` | Layers 2+3 — variables and response shape |
| `scripts/live-read-check.mjs` | Live read-only run, in-process |
| `scripts/smoke-read-tools.mjs` | Live read-only run through the deployed HTTP server |
| `schema/jobber-schema.{json,graphql}` | Pinned introspection of `2026-07-27` |
| `Dockerfile`, `docker-compose.yaml` | Coolify deployment unit |

---

## 10. Relationship to the main application

The main application already has a production Jobber integration that is
strictly more capable: encrypted per-tenant token storage, a database lease
around refresh, and throttle-aware retry.

This MCP server is a **separate dev/inspection tool** authenticating as one
account. Do not route application traffic through it. If it ever needs to act
per-tenant, front that existing integration rather than build a second Jobber
auth system here.
