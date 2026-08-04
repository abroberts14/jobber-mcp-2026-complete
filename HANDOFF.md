# Jobber MCP — Handoff

Status as of 2026-08-03. Everything below was verified against a live Jobber
account unless explicitly marked otherwise.

---

## 1. What this is

An MCP server exposing **108 tools** over Jobber's GraphQL API — 107 Jobber
tools across 19 modules under `src/tools/`, plus a `help` tool. It ships two
transports:

| Transport | Entry point | Use |
| --- | --- | --- |
| stdio | `dist/index.js` | One subprocess per MCP client (local default) |
| Streamable HTTP | `dist/http.js` | One shared service for the team |

It is **single-tenant**. Every caller acts as the one Jobber account the server
is authorized against. This is an access gate for a team that already shares an
account — not a multi-user system.

> The tool count was 102. 29 tools called Jobber queries/mutations that do not
> exist and were deleted; 13 real operations had no tool and were added. See §4.

---

## 2. Authentication: how Jobber actually works

Jobber issues **no static API keys or personal access tokens**. The real model
is OAuth 2.0:

1. Register an app at [developer.getjobber.com](https://developer.getjobber.com)
   → client ID + secret.
2. Authorization code grant → access token + refresh token.
3. **Access tokens expire after 60 minutes.** Refresh is fully automatic and
   invisible to callers: the client renews proactively before expiry (60s skew)
   and also refreshes-and-replays once on a 401.
4. **Refresh-token rotation is a per-app setting, and it is DISABLED on this
   app.** Verified against live Jobber on 2026-08-04: the refresh response
   returns the *same* `refresh_token` value, so `JOBBER_REFRESH_TOKEN` stays
   usable indefinitely. This corrects an earlier claim in this document that
   the token rotated on every refresh.

   `refreshTokens()` still persists a returned token when it differs, because
   that is required on an app with rotation enabled. Do not simplify it away.
5. **Concurrent refreshes are still not safe**, and a token can still be
   invalidated server-side — see §3.

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

## 3. ⚠️ Token-store discipline

**Prefer one live token store per Jobber app.**

This is less severe than earlier versions of this document claimed, because
rotation is disabled on this app (§2.4): two stores hold the same,
never-changing refresh token rather than invalidating each other on every
refresh. The rule still stands for two reasons — overlapping refreshes are
rejected regardless of rotation, and if rotation is ever enabled on the app the
original hazard returns in full.

The supported setup:

- The hosted HTTP server owns the token chain.
- Everyone — including you, locally — connects to it over HTTP with the bearer
  secret. See §7.

**Within** a single store, concurrency is handled: `TokenStore` takes an O_EXCL
lockfile and a process that loses the race re-reads and adopts the winner's
tokens rather than replaying a spent one.

### Recovering a dead refresh token

Observed once, on 2026-08-04: refreshes began failing with `The provided
refresh token is not valid`, taking the server down an hour after the last
successful refresh. **The cause was never conclusively established** — with
rotation disabled, ordinary refreshes should not consume the token. The most
plausible trigger is two containers overlapping during a rolling deploy that
coincided with access-token expiry.

Recovery:

```bash
npm run authorize                      # interactive; prints a new refresh token
```
Then update `JOBBER_REFRESH_TOKEN` in Coolify and redeploy. That is all.

Deleting `/data/tokens.json` used to be a required third step, because
`hydrateFromStore` prefers the stored token over the environment and a stale
store silently re-adopted the dead one. The client now retries once with the
bootstrap token from the environment when the stored token is rejected, so it
heals itself on the next tool call and the caller sees nothing.

Verified by poisoning the store with a bogus refresh token plus an expired
access token: the next call fell back, succeeded, rewrote the store with a
valid pair, and returned normal data.

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
| Document validation | **107/107** |
| Deep audit (documents + variables + response shape) | **107/107** |
| Live read-only run through the deployed server | **41 passed, 0 failed, 6 skipped** |
| Live mutation run against the sandbox | **38 passed, 4 failed** (see below) |

`help` is not counted: it makes no GraphQL call, so the query validators
correctly ignore it.

Read skips are `get_payment`, `get_expense`, `get_timesheet_entry`,
`get_tax_rate` — the account holds no such records, so no real ID exists to
fetch. `scripts/live-mutation-check.mjs` covers the write half; run it only
against a sandbox.

### The 4 mutation failures are an OAuth scope limit, not code

```
create_expense   -> "An object of type ExpenseCreate was hidden due to permissions"
create_tax_rate  -> "An object of type TaxCreate was hidden due to permissions"
```

`update_expense` and `create_tax_group` then fail only because they had no ID to
work with. The tools are schema-correct; the **Jobber app lacks expense and tax
write scopes**. Add them at developer.getjobber.com, re-authorize, and re-run.

### Two live-only findings that no static check could reach

- **`productsSearch` is broken server-side.** It is in the schema but its
  resolver returns HTTP 500 for every input, including the most minimal
  selection. `search_products` therefore uses `products(searchTerm:)`, which
  takes the same argument and works.
- **Jobber's search index lags writes by seconds.** A client created and then
  immediately searched for returns 0 results, then appears shortly after. Not a
  bug — but it means "the call succeeded" and "the data is findable" are
  different claims.

### ⚠️ What is still NOT proven

Every tool has now been executed against live Jobber except the four blocked by
scopes above and the four read tools with no data to fetch. What remains
unproven is narrower than before but real: tools were exercised on **one
account with one shape of data**, so business-rule edge cases (multi-property
clients, recurring jobs, partial payments) are untested.

Cleanup is best-effort by design. Jobber has no delete for clients, jobs,
quotes, properties or products — the run archives the client (which hides the
chain beneath it), voids invoices, deletes visits, and hides products. Records
are tagged `MCPTEST-<timestamp>` so anything left is easy to find.

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

### Discovering the tool set

`tools/list` carries every schema, but that is a lot of context and it cannot
express rules that span tools. Call **`help`** first:

| Call | Returns |
| --- | --- |
| `help {}` | Categories, cross-cutting conventions, what Jobber does NOT support, workflow recipes |
| `help { category: "jobs" }` | Tools in one area with their required arguments |
| `help { tool: "create_job" }` | One tool's full input schema (with did-you-mean on typos) |

The catalog is generated from `TOOL_GROUPS` in `src/server.ts` — the same object
used for dispatch and the duplicate-name check — so it cannot drift from what is
actually exposed. `src/help.ts` deliberately sits outside `src/tools/`: it
issues no GraphQL, and the query validators flag a `tools/` module that never
produces a document.

The `notSupported` list matters most for other models: it stops them retrying
things Jobber has no API for (forms, recording payments, sending quotes,
cross-entity search, deleting most records).

---

## 8. Known gaps

- **Expense and tax writes are blocked by OAuth scope.** See §5.
- **Push does not auto-deploy.** The Coolify app uses a *public repository*
  source, which installs no GitHub webhook (only GitHub App sources do), so
  deploys must be triggered manually. Fix by adding a GitHub webhook pointing at
  Coolify's manual endpoint, or by granting the existing GitHub App access to
  this repo and switching the source.
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
