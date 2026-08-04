# Jobber MCP — Handoff

Status as of 2026-08-03. Everything below was verified against a live Jobber
account unless explicitly marked otherwise.

---

## 1. What this is

An MCP server exposing **102 tools** over Jobber's GraphQL API (15 tool modules
under `src/tools/`). It ships two transports:

| Transport | Entry point | Use |
| --- | --- | --- |
| stdio | `dist/index.js` | One subprocess per MCP client (local default) |
| Streamable HTTP | `dist/http.js` | One shared service for the team |

It is **single-tenant**. Every caller acts as the one Jobber account the server
is authorized against. This is an access gate for a team that already shares an
account — not a multi-user system.

---

## 2. Authentication: how Jobber actually works

Jobber issues **no static API keys or personal access tokens**. The README used
to claim otherwise ("Settings > API Access") — that screen does not exist.

The real model is OAuth 2.0:

1. Register an app at [developer.getjobber.com](https://developer.getjobber.com)
   → client ID + secret.
2. Authorization code grant → access token + refresh token.
3. **Access tokens expire after 60 minutes.**
4. **Refresh tokens rotate on every refresh and the old one dies immediately.**

Point 4 drives most of the design below.

### Bootstrapping

```bash
cp .env.example .env          # fill in client ID + secret
npm run authorize             # one-time OAuth flow
```

`npm run authorize` prints a `JOBBER_REFRESH_TOKEN` for `.env` and caches the
token pair. It accepts either a pasted redirect URL or a bare code, and verifies
the OAuth `state` parameter.

The `JOBBER_REDIRECT_URI` currently in `.env` is a tunnel hostname that doubles
as the internal API's OAuth callback. It forwards to that API, so the redirect
lands on a service which does not understand the code and **the code must be
pasted in by hand**; the auth code also passes through that service's logs on
the way. Both are cosmetic, not blocking.

If you ever point the redirect at a loopback URI (or set `JOBBER_CALLBACK_PORT`
to a port a tunnel forwards to), the CLI captures the code automatically.

---

## 3. ⚠️ The one rule that will break things

**Only one token store may be live per Jobber app.**

You have decided to use a **single Jobber app for both local and team use**.
That is workable, but it has a hard consequence:

> Once the hosted server is running, **do not also run the stdio server against
> the same app.** Each will invalidate the other's refresh token, and recovery
> means re-running `npm run authorize`.

The supported setup under one app:

- The hosted HTTP server owns the token chain.
- Everyone — including you, locally — connects to it over HTTP with the bearer
  secret. See §6 for client config.
- Remove any local stdio registration, e.g. a previous
  `claude mcp add jobber -- node .../dist/index.js` in a sibling repo
  (`claude mcp remove jobber`).

Use the stdio transport only when the hosted server is not running, or for
throwaway local work before deploying.

**Within** a single store, concurrency is safe: `TokenStore` takes an O_EXCL
lockfile and a process that loses the race re-reads and adopts the winner's
tokens rather than replaying a spent one. That covers several MCP clients on one
machine and overlapping containers during a rolling deploy. It cannot coordinate
two *different* stores — hence the rule above.

---

## 4. Three pre-existing bugs fixed

These were all latent before this work; the server had never successfully served
a tool call to any client.

1. **`tools/list` returned invalid schemas.** `server.ts` sent
   `tool.inputSchema.shape` — raw Zod internals — where MCP requires JSON
   Schema. Every client failed validation on connect with
   `expected "object"`. Now converted with `zod-to-json-schema` (promoted from a
   transitive dep to an explicit one).
2. **`X-JOBBER-GRAPHQL-VERSION: 2024-01-11` did not exist.** Jobber answered
   every request `404 {"message":"GraphQL API version ... does not exist"}`. Now
   `2025-01-20`, matching the version our internal Jobber provider uses.
3. **`JOBBER_OAUTH_URL` was ignored by the server.** Documented and honored by
   the authorize CLI, but never passed into `JobberClient`, so overrides
   silently hit production Jobber. Caught by the container test.

---

## 5. Deploying to the Mac mini (Coolify)

Modeled on our existing Coolify deployment runbook. `Dockerfile` and
`docker-compose.yaml` are in this repo.

The image is multi-stage (build TS → run `dist/http.js`), runs as non-root on
port 3000, and healthchecks `/health` using Node 22's built-in fetch.

### Steps

1. Run `npm run authorize` locally for a fresh refresh token.
2. Generate the shared secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Create a Coolify **Dockerfile Application** (not Docker Image — that trap is
   documented in that runbook), port 3000, health-gated on `/health`,
   FQDN `http://jobber-mcp.<your-domain>` — **`http` scheme on purpose**,
   since Cloudflare terminates TLS at the edge and an `https` FQDN makes Traefik
   redirect-loop behind the tunnel.
4. Set env vars: `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`,
   `JOBBER_REFRESH_TOKEN`, `JOBBER_MCP_SECRET`.
5. **Mount a volume at `/data`.** Not optional — without it every redeploy loses
   the rotated refresh token and someone re-authorizes by hand.
6. Add the tunnel ingress rule for the new hostname → `coolify-proxy:80` on the
   existing `cloudflared-tunnel` service.
7. Deploy. On first boot the server spends the bootstrap token and writes the
   rotated pair to the volume. From then on **the volume is the source of truth**
   and the `JOBBER_REFRESH_TOKEN` env value is stale by design — that is correct,
   not a bug.

### Not done

Steps 3–7 need Coolify/Cloudflare access and have **not** been performed. The
image build and container runtime were verified locally (see §7).

---

## 6. Connecting clients

The server refuses to start without `JOBBER_MCP_SECRET`. That is deliberate: the
tool set includes `create_job`, `close_job`, `archive_client`, `create_invoice`
and friends, so an unauthenticated public endpoint would let anyone who finds
the URL write to the Jobber account.

```json
"jobber": {
  "type": "http",
  "url": "https://jobber-mcp.<your-domain>/mcp",
  "headers": { "Authorization": "Bearer <JOBBER_MCP_SECRET>" }
}
```

Add to your project's `.mcp.json` (if it is tracked — put the secret in each person's local
config, not in the committed file) or via
`claude mcp add --transport http jobber <url> -H "Authorization: Bearer <secret>"`.

`GET /health` is unauthenticated and returns `{"status":"ok"}`.

---

## 7. Verification performed

| Check | Result |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| stdio transport + live Jobber | 102 tools, real client data, launched from unrelated cwd via `JOBBER_ENV_FILE` |
| HTTP transport + live Jobber | 401 without token, 401 wrong token, 404 unknown path, live data, 4 concurrent calls |
| Multi-process refresh (6 processes, shared store) | 6/6 succeed, **1** OAuth call, 0 reuse rejections |
| Same test, lock disabled (control) | **5 of 6 fail** with `invalid_grant` — confirms the fix is load-bearing |
| Docker image build | succeeds (linux/arm64) |
| Container against stub Jobber | healthy, auth gate holds, tool call returns |
| Container restart | reuses volume token — 1 refresh across 2 container lifetimes |

The container tests deliberately used a **stub** Jobber, not the real one:
running it for real would have rotated the refresh token and killed the laptop's
store (§3).

---

## 8. Known gaps

- **No read-only mode.** `readOnlyHint` is derived from the tool name prefix and
  is advisory. If most of the team should not be able to mutate Jobber, filter
  `allTools` behind a `JOBBER_MCP_READ_ONLY` flag — small change, not made.
- **One shared secret, no per-user identity.** No audit trail of who called what.
- **No automated test suite.** All verification above was done with throwaway
  scripts, not committed tests. The multi-process concurrency test in particular
  is worth keeping — it is the one that proved the lock matters.
- **`src/main.ts` is a byte-identical duplicate of `src/index.ts`** and only
  `index.ts` is wired to the `bin` entry. Looks like dead weight; left alone
  because removing it was out of scope.
- **README claims 104 tools; the server exposes 102.** Not chased down.
- **`.DS_Store` is untracked and not in `.gitignore`.** Worth adding.
- **`react`/`react-dom` are runtime `dependencies`** (for `src/ui/react-app/`),
  so they land in the production image unnecessarily. Moving them to
  `devDependencies` would slim it.

---

## 9. File map

| Path | Role |
| --- | --- |
| `src/auth/oauth.ts` | Authorize URL, code exchange, refresh. Expiry from `expires_in` → JWT `exp` → 55 min fallback, 60s skew |
| `src/auth/token-store.ts` | Atomic writes + O_EXCL lockfile with stale-lock breaking |
| `src/auth/authorize-cli.ts` | One-time OAuth bootstrap (`npm run authorize`) |
| `src/clients/jobber.ts` | GraphQL client: proactive refresh, 401 retry, lock-guarded refresh |
| `src/server.ts` | `createJobberRuntime` / `createMcpServer` / `hydrateFromStore`, plus the stdio `JobberServer` |
| `src/http.ts` | Streamable HTTP transport, bearer auth, `/health` |
| `src/load-env.ts` | `.env` loading via Node's built-in `process.loadEnvFile` (no dotenv dep) |
| `Dockerfile`, `docker-compose.yaml` | Coolify deployment unit |

State: committed through `0349a0f "jobber mcp"`. The HTTP transport, Docker
files, and token-store locking are **uncommitted** on `main`.

---

## 10. Relationship to the main application

Our main application already has a production Jobber integration that is
strictly more capable than this one: encrypted per-tenant token storage, a
database lease around refresh so concurrent workers cannot burn the single-use
refresh token, and throttle-aware retry.

This MCP server is a **separate dev/inspection tool** authenticating as one
account. Do not route application traffic through it.

If it ever needs to act per-tenant, the right move is to front that existing
integration layer rather than build a second Jobber auth system here — two
implementations that can disagree about token state is exactly the failure mode
§3 describes, scaled up.
