# TCS-12 — Remote MCP server at mcp.tocsin.sh (issue #12)

## Context read
- Issue #12 body read in full. Comment thread: 0 comments (checked 2026-10-22 13:5xZ). Labels: ai-build. State OPEN.
- Blocked-by #3 (CLOSED, merged 48f6b3d) and #9 (CLOSED, merged 105274e). The ticket is buildable.
- Already on main? `git log origin/main --since=2026-10-22T00:26:57Z` shows no commit after the ticket was filed except TCS-9 (105274e, the check endpoint this ticket depends on). No `workers/` dir, no `agents` dependency, no `McpAgent` symbol on main. Nothing of this ticket is done.
- `/.well-known/tocsin.json` already carries `"mcp": "https://mcp.tocsin.sh"` (TCS-3, src/routes/discovery.ts). `llms.txt` has no MCP section.
- CodeGraph: NOT AVAILABLE on this box. Callers found with grep: `parseEventsFilters`/`buildEventsQuery` are used by `src/routes/events.ts` and `tests/routes/events-plan.tcs-3.test.ts`; `eventsEtag` by `src/routes/events.ts` only; `WELL_KNOWN`/`LLMS_TXT` by `src/routes/discovery.ts` only (pinned by `tests/routes/discovery.tcs-3.test.ts`).
- Watch lists (#8) are OPEN and not built. `GET /v1/watchlists/:id/events` does not exist on main (spec: docs/tickets/07-watchlists-keys.md).

## Spec changes from comments
none

## Scope
1. A second worker under `workers/mcp/`, built on the Cloudflare `agents` SDK `McpAgent`, streamable HTTP at `/mcp`. It reads the Tocsin API over HTTP only (no D1 binding), base URL from `TOCSIN_BASE_URL` (default `https://tocsin.sh`).
2. Four tools: `tocsin_latest`, `tocsin_check`, `tocsin_get`, `tocsin_watchlist_events`. Each result carries `human` (one line, no newline) and `data`.
3. Bearer pass-through: the `Authorization: Bearer …` header on the MCP connection reaches `tocsin_watchlist_events` as agent props.
4. `workers/mcp/wrangler.toml` with route `mcp.tocsin.sh/*`.
5. Discovery: the MCP URL `https://mcp.tocsin.sh/mcp` in `/.well-known/tocsin.json` and an MCP section in `llms.txt` with copy-paste config for Claude Code, Cursor and Claude Desktop.
6. One additive feed option so "latest" is really the newest: `GET /v1/events?order=desc` (see ASSUMPTIONS A1).

## ASSUMPTIONS
- A1. "latest" vs an oldest-first feed. `/v1/events` returns rows oldest first from `since` (default 0). Read as-is, `tocsin_latest` would return the OLDEST 50 advisories, which is wrong data. Assumed: add an additive, opt-in `order=desc` query option to `/v1/events` (default `asc`, unchanged byte for byte, ETag for asc unchanged). `tocsin_latest` calls `?order=desc`. Other reading: page the whole feed to the end in the MCP worker (unbounded calls, breaks iron rule 8) or answer the oldest rows (wrong data). Rejected both.
- A2. Semantics of `order=desc`: rows with `cursor > since`, newest first, `limit` rows. `next_cursor` = the highest cursor on the page (or `since` when empty), so an agent can send it as `since=` in the normal ascending mode to poll from now on. `has_more` = more matching older rows exist. Documented in llms.txt.
- A3. Discovery URL. Ticket says "add the MCP URL". The top-level `mcp` field already holds `https://mcp.tocsin.sh` and TCS-3's test pins it. Assumed: keep top-level `mcp` unchanged and ADD `endpoints.mcp = "https://mcp.tocsin.sh/mcp"` (the schema allows extra `endpoints` keys). No other ticket's test changes. Other reading: rewrite top-level `mcp` to `/mcp` and edit `tests/routes/discovery.tcs-3.test.ts`.
- A4. `tocsin_watchlist_events` targets `GET {base}/v1/watchlists/{id}/events` (spec in docs/tickets/07-watchlists-keys.md), which ships with #8 and does not exist yet. The tool forwards the bearer and reports the API status and error body faithfully. With no bearer on the connection it answers `isError: true` and makes no HTTP call. It never claims "no events" on a non-2xx.
- A5. Dependencies (`agents`, `@modelcontextprotocol/sdk`, `zod`) go into the ROOT package.json (one lockfile, one `npm ci` in CI). No separate workers/mcp/package.json.
- A6. Deploy. CI's deploy job gets one extra step `npx wrangler deploy -c workers/mcp/wrangler.toml`, behind the same `DEPLOY_ENABLED` gate. The DNS record for `mcp.tocsin.sh` is an operator step listed in the PR body and README. Other reading: no CI change, manual deploy only.
- A7. `tocsin_check` with `lockfile_text` sends multipart with field name = `lockfile_name` (the API's own contract). With `runtimes` only, it sends JSON `{runtimes}`. The API takes runtimes only as JSON or query, and lockfiles only as multipart, so one call cannot carry both. Assumed: lockfile + runtimes → one multipart call for the lockfile and one JSON call for the runtimes, run in parallel and merged in the tool (`checked` summed, `affected` concatenated in API order, `skipped` concatenated, `feed_cursor` = min of the two so no advisory is skipped). If only one is given, one call. Neither given → `isError`, no call.
- A8. `limit` on `tocsin_latest`: default 10, max 100 (the API cap), validated by zod; out of range is a tool input error (not clamped, D11).

## Files to touch
- `workers/mcp/src/index.ts` (create): `TocsinMcp extends McpAgent<Env, unknown, Props>`; `init()` registers the 4 tools from tools.ts; default export `fetch` reads `Authorization`, sets `ctx.props = { bearer }`, routes `/mcp` to `TocsinMcp.serve("/mcp")`, `GET /` answers a one-line JSON pointer, everything else 404.
- `workers/mcp/src/tools.ts` (create): pure tool handlers `latest`, `check`, `get`, `watchlistEvents`, each `(api: TocsinApi, args) => Promise<ToolResult>`; the `human` line builders; `ToolResult = { human, data }` plus `toCallToolResult()` (content text = JSON of `{human,data}`, `structuredContent`, `isError` on failure).
- `workers/mcp/src/api.ts` (create): `TocsinApi` HTTP client, the one seam to the Tocsin API. Takes `baseUrl` and an injectable `fetch` (default `globalThis.fetch`). Never throws on non-2xx; returns `{ ok, status, body }`.
- `workers/mcp/src/env.ts` (create): `Env { MCP_OBJECT: DurableObjectNamespace; TOCSIN_BASE_URL?: string }`, `Props { bearer: string | null }`.
- `workers/mcp/wrangler.toml` (create): name `tocsin-mcp`, main `src/index.ts`, `compatibility_flags = ["nodejs_compat"]`, `[[durable_objects.bindings]] MCP_OBJECT → TocsinMcp`, `[[migrations]] tag="v1" new_sqlite_classes=["TocsinMcp"]`, `routes = [{ pattern = "mcp.tocsin.sh/*", zone_name = "tocsin.sh" }]`, `[vars] TOCSIN_BASE_URL = "https://tocsin.sh"`.
- `src/feed/query.ts` (edit): `EventsFilters.order: "asc" | "desc"`; parse `order` (only `asc`/`desc`, else 400); `buildEventsQuery` emits `ORDER BY cursor DESC` for desc.
- `src/feed/etag.ts` (edit): add `order` to the canonical JSON ONLY when `desc` (asc tags stay identical).
- `src/routes/events.ts` (edit): `next_cursor` for desc = `page[0].cursor` (highest) or `since`.
- `src/routes/discovery.ts` (edit): `endpoints.mcp`; llms.txt `order=desc` line under Filters and a new `## MCP` section with the three config blocks.
- `package.json` (edit): deps `agents`, `@modelcontextprotocol/sdk`, `zod` (versions that `agents` peers on: sdk 1.32.1, zod ^4); `package-lock.json` regenerated by `npm install`.
- `vitest.config.ts` (edit): `test.projects` with two inline projects: `api` (current config, `exclude: ["tests/mcp/**"]`) and `mcp` (`cloudflareTest({ wrangler: { configPath: "./workers/mcp/wrangler.toml" } })`, `include: ["tests/mcp/**/*.test.ts"]`, no D1 setup file). Fallback if inline per-project plugins fail: `workers/mcp/vitest.config.ts` and `"test": "vitest run && vitest run -c workers/mcp/vitest.config.ts"`.
- `tsconfig.json` (edit): include `workers`.
- `.github/workflows/ci.yml` (edit): one deploy step for the MCP worker (A6).
- `README.md` (edit): MCP section: URL, local dev `npx wrangler dev -c workers/mcp/wrangler.toml`, operator deploy steps.
- `tests/mcp/tools.test.ts` (create): acceptance file named by the ticket.
- `tests/mcp/transport.test.ts` (create): acceptance file named by the ticket.
- `tests/mcp/env.d.ts` (create, only if the mcp project needs its own `Cloudflare.Env` typing).
- `tests/routes/events-desc.tcs-12.test.ts` (create): the desc feed option, through `src/index.ts`.
- `tests/routes/events-desc-plan.tcs-12.test.ts` (create): EXPLAIN QUERY PLAN for desc.
- `tests/routes/discovery.tcs-12.test.ts` (create): `endpoints.mcp` and the llms.txt MCP section.

Test file names: the ticket body names `tests/mcp/tools.test.ts` and `tests/mcp/transport.test.ts` exactly, so those two keep the ticket's names. All other new tests use the `.tcs-12.` suffix.

## Tests that must change
None.

## Changed symbols
- format `EventsFilters`: new field `order: "asc" | "desc"`. callers: left alone: `tests/routes/events-plan.tcs-3.test.ts` builds filters through `parseEventsFilters`, which fills the default.
- function `parseEventsFilters`: accepts `order=asc|desc`, default `asc`, 400 on anything else.
- function `buildEventsQuery`: `ORDER BY cursor DESC` when `order=desc`; asc SQL unchanged byte for byte.
- function `eventsEtag`: hashes `order` only when `desc`; asc tags unchanged.
- route `GET /v1/events`: new `order` option; `next_cursor` for desc is the highest cursor on the page.
- format `/.well-known/tocsin.json`: new `endpoints.mcp`. Top-level `mcp` unchanged.
- format `/llms.txt`: new `order=desc` filter line and `## MCP` section.
- route `POST /mcp` (new worker `tocsin-mcp`): MCP streamable HTTP.
- function `TocsinApi` (new), `latest`/`check`/`get`/`watchlistEvents` tool handlers (new).

## Tasks

### T1. Feed option `order=desc`
Edit `src/feed/query.ts`, `src/feed/etag.ts`, `src/routes/events.ts` as listed. Asc output, SQL and ETag stay identical.
VALIDATE: `npx vitest run tests/routes/events-desc.tcs-12.test.ts tests/routes/events-desc-plan.tcs-12.test.ts tests/routes/events.tcs-3.test.ts tests/routes/events-plan.tcs-3.test.ts` exits 0.
SATISFIES: "Tools: `tocsin_latest(...)`" — latest must return the newest advisories, which the feed cannot serve today (A1).

### T2. HTTP seam `workers/mcp/src/api.ts`
`TocsinApi` with `events(params)`, `checkRuntimes(runtimes)`, `checkLockfile(name, text)`, `get(id)`, `getByCve(cve)`, `watchlistEvents(id, bearer)`. URLs built with `new URL(path, base)` and `encodeURIComponent` on path ids. Non-2xx returns `{ ok:false, status, body }` (body parsed as JSON when possible, else text). Network error returns `{ ok:false, status:0, body:{ error: err.message } }`.
VALIDATE: `npx vitest run --project mcp tests/mcp/tools.test.ts` (fake fetch records the exact URLs, methods and headers; asserts `Authorization` is sent only by `watchlistEvents`).
SATISFIES: "It calls the public API over HTTP (no shared DB binding) so the open-source MCP server works against any Tocsin host via `TOCSIN_BASE_URL`."

### T3. Tool handlers `workers/mcp/src/tools.ts`
- `latest({ecosystem?, min_severity?, exploited_only?, limit?})` → `GET /v1/events?order=desc&limit=<n>[&ecosystem=…][&min_severity=…][&exploited=true]`. `data = { events, next_cursor, has_more }`. `human`: `"<n> advisories, newest first. Newest: <id> <component> <severity.label>[, exploited]."` or `"No advisories match these filters."`.
- `check({lockfile_name?, lockfile_text?, runtimes?})` → A7. `data` = the API's check result. `human`: `"<k> of <checked> dependencies affected. Worst: <component> <version>: <action>"` or `"No known advisory affects the <checked> checked dependencies."`, plus `" <s> skipped."` when skipped is non-empty (skipped is never a clean result, D13).
- `get({id_or_cve})` → `/^CVE-\d{4}-\d{4,}$/i` → `/v1/events/cve/{CVE upper}`, else `/v1/events/{id}`. `human`: `"<id> (<cve list>) <component> <severity.label>: <action>"`. 404 → `isError`, human `"No advisory found for <input>."`.
- `watchlistEvents({watchlist_id})` → A4. No bearer → `isError`, human `"This tool needs an API key. Send Authorization: Bearer tcs_... on the MCP connection."`, 0 HTTP calls.
- Every non-2xx → `isError: true`, `human` = `"Tocsin API answered <status>: <body.error>"`, `data` = the body. Never mapped to an empty success (D9).
- Every `human` has no `\n` (replace with space), deterministic from data (iron rule 6, no LLM).
VALIDATE: `npx vitest run --project mcp tests/mcp/tools.test.ts` exits 0.
SATISFIES: "Each tool result includes a `human` string (one line) and the `data` object." and the three `tests/mcp/tools.test.ts` acceptance lines.

### T4. Worker `workers/mcp/src/index.ts`, `env.ts`, `wrangler.toml`
`TocsinMcp` (McpAgent) with `server = new McpServer({ name: "tocsin", version: <package.json version> })`; `init()` registers the 4 tools with zod input schemas; handlers build `TocsinApi(env.TOCSIN_BASE_URL ?? "https://tocsin.sh")` and call tools.ts. Fetch handler: `ctx.props = { bearer }` from `Authorization: Bearer <token>` (trimmed; anything else → null), then `TocsinMcp.serve("/mcp").fetch(req, env, ctx)` for `/mcp`.
VALIDATE: `npx vitest run --project mcp tests/mcp/transport.test.ts` exits 0, and `npx wrangler deploy --dry-run -c workers/mcp/wrangler.toml` exits 0.
SATISFIES: "A second worker `workers/mcp/` using the Cloudflare `agents` SDK `McpAgent` with streamable HTTP transport at `https://mcp.tocsin.sh/mcp`" and "`wrangler.toml` route `mcp.tocsin.sh/*`".

### T5. Bearer reaches the watch-list tool
The tool handler reads `this.props.bearer`. Transport test sends `initialize`, then `tools/call tocsin_watchlist_events` with `Authorization: Bearer tcs_test_x`, against `TOCSIN_BASE_URL` pointed at a fake (miniflare `outboundService` or `fetchMock` from `cloudflare:test`), and asserts the fake saw `Authorization: Bearer tcs_test_x` on `/v1/watchlists/wl_1/events`.
VALIDATE: `npx vitest run --project mcp tests/mcp/transport.test.ts -t bearer` exits 0.
SATISFIES: "`tocsin_watchlist_events({watchlist_id})` (needs the key passed as a bearer header through the MCP connection)".

### T6. Discovery + llms.txt
`endpoints.mcp = "https://mcp.tocsin.sh/mcp"`. llms.txt: under Filters add `- order=desc  newest first; next_cursor is the newest cursor`; new `## MCP` section: the URL, Claude Code `claude mcp add --transport http tocsin https://mcp.tocsin.sh/mcp`, Cursor `~/.cursor/mcp.json` `{"mcpServers":{"tocsin":{"url":"https://mcp.tocsin.sh/mcp"}}}`, Claude Desktop `{"mcpServers":{"tocsin":{"command":"npx","args":["-y","mcp-remote","https://mcp.tocsin.sh/mcp"]}}}`, the four tool names, and the bearer header note for watch lists. Literal values only from this plan; no invented URLs (D26).
VALIDATE: `npx vitest run tests/routes/discovery.tcs-12.test.ts tests/routes/discovery.tcs-3.test.ts` exits 0.
SATISFIES: "Add the MCP URL to `/.well-known/tocsin.json` and `llms.txt` with a copy-paste config block for Claude Code, Cursor and Claude Desktop."

### T7. Test + build wiring
`vitest.config.ts` projects, `tsconfig.json` include `workers`, root `package.json` deps, CI deploy step, README section.
VALIDATE: `npm run typecheck` exits 0 and `npm test` exits 0 (both projects run; output lists `api` and `mcp` projects).
SATISFIES: Verification contract in the ticket: "`npm test`, `npm run typecheck`".

## Edge cases
- `order=DESC`, `order=` → 400 (exact `asc`/`desc` only), same as `exploited`.
- desc with empty result → `next_cursor = since`, `has_more=false`.
- desc page: has_more uses the same limit+1 fetch.
- `tocsin_get("cve-2026-111497")` lower case → upper-cased CVE route. An id with `/` is path-encoded.
- `tocsin_check` with `lockfile_text` but no `lockfile_name` → `isError`, no call (the API needs the file name). Unsupported name → the API's 400 with `supported_filenames` is surfaced.
- `tocsin_check` 413/429 → `isError` with status; 429 human includes `Retry-After` value when present.
- Empty `Authorization`, `Basic …`, `Bearer ` with no token → bearer null.
- The MCP worker must not forward the bearer to any route but watch-list events (key leak to logs/other hosts).
- `TOCSIN_BASE_URL` with a trailing slash or path → `new URL("/v1/…", base)` gives one canonical URL.

## Iron laws
- Sortable headers / list-over-cards / drill-down / 375px / native dialogs: n/a. No UI in this ticket (llms.txt is plain text).
- DB-driven config: no new limits. `limit` default 10 and max 100 in the MCP tool mirror the API's own cap (`MAX_LIMIT` in src/feed/query.ts, a code constant today); the API stays the authority and rejects larger values. Base URL is a wrangler var, not a constant.
- RLS / migrations: none. No new table, no schema change. D1 untouched by the MCP worker.
- Indexes: the only new query shape is `ORDER BY cursor DESC` on `advisories`. It uses the existing `idx_advisories_cursor` / `idx_advisories_ecosystem_cursor` / `idx_advisories_exploited_cursor` / `idx_advisories_severity_cursor` in reverse. Proven by `tests/routes/events-desc-plan.tcs-12.test.ts` (EXPLAIN on 2,000 seeded rows, reuse `tests/routes/seed.tcs-3.ts`).
- Retention: no growing table. The `McpAgent` Durable Object SQLite holds MCP session state only; the agents SDK owns its lifetime. [NOTE for review, not a table of ours.]
- No per-row correlated subquery: none added.
- De-AI / no LLM: `human` strings are templates over advisory fields. No LLM call.
- Model ids: none.
- Dedup before spend: no metered call. The Tocsin API is our own unmetered API.
- Secrets: none in the repo. The bearer is never logged; the worker logs only `{lane:"mcp", tool, status}`.
- Scalable tests (BH-7563): the only "vendor" is our own Tocsin API. Seam = `workers/mcp/src/api.ts` (`TocsinApi`, injectable `fetch`). Fake = a fetch stub in tools.test.ts and `fetchMock`/outbound stub in transport.test.ts; 0 real network calls. Contract test: none needed (own API, covered by the api project suites). Each test builds its own fake; no shared state, no order dependence.
- Performance: no screen. Feed desc read = 1 statement, same as asc. Each MCP tool = 1 HTTP call (check with lockfile+runtimes = 2, run in parallel with `Promise.all`).

## Build discipline rules that bite
- D2: transport test goes through the real worker entry (`workers/mcp/src/index.ts` via the mcp project's `SELF`/`exports`), not only the pure handlers.
- D9/D13: non-2xx never becomes an empty success; "No known advisory affects…" renders only on a 2xx with `affected.length === 0`.
- D11: zod rejects out-of-range `limit` and unknown `min_severity`; no clamping.
- D26: config blocks use only `https://mcp.tocsin.sh/mcp` and package names in this plan.
- D1: mutate `latest` to drop `order=desc`, `get` to skip the CVE branch, `watchlistEvents` to drop the header; a test must go red each time.
- D8: operator steps (DNS for mcp.tocsin.sh, first deploy) go in the PR body.

## Failure modes
- Decision rule: `get` routes CVE vs id. Cases: `CVE-2026-111497` → cve route; `cve-2026-111497` → cve route; `CVE-2026-1` (3 digits) → id route; `GHSA-xxxx-yyyy-zzzz` → id route; `OSV-2026-1` → id route; ` CVE-2026-111497 ` (spaces) → trimmed, cve route. Bearer rule: `Bearer tcs_x` → `tcs_x`; `bearer tcs_x` → `tcs_x`; `Bearer ` → null; `Basic abc` → null; missing → null. source: assumed. Test: tools.test.ts and transport.test.ts table cases.
- Exit paths: each tool returns success or `isError`; no state is written; the DO keeps only session state. Test: tools.test.ts asserts `isError` on 400/404/429/500/network error.
- Writer/reader round-trip: tool result JSON `{human,data}` is written by `toCallToolResult` and read by MCP clients via `structuredContent` and `content[0].text`. Test: transport.test.ts parses `content[0].text` and compares with `structuredContent`.
- Alert or freeze blast radius: n/a — no alert or freeze added.
- Defaults in prod: `TOCSIN_BASE_URL` default `https://tocsin.sh` (the hosted API); `order` default `asc` (existing behavior); `limit` default 10 (a chat-size answer). Test: tools.test.ts asserts the default URL has `limit=10&order=desc`.
- Status evidence: n/a — no status or report line added.

## System invariants
- (a) Cross-run state: none of ours. MCP session state lives in the `McpAgent` Durable Object (agents SDK). Watch-list cursors live in the API (#8), never in the MCP worker.
- (b) External side effects: the only side effect is `tocsin_watchlist_events`, which advances the watch-list cursor in the API on a 2xx (API-owned, #8). The MCP worker records nothing. Success = API 2xx passed through. Failure = `isError` with status. Not configured (no bearer) = `isError`, no call. A tool never reports success without a 2xx.
- (c) Negative list for the CVE matcher (gates which route is called, not irreversible): `CVE-2026-1`, `xCVE-2026-111497`, `CVE-2026-111497/../keys`, `GHSA-…` must NOT take the CVE route. Bearer must NOT be forwarded on `latest`, `check`, `get`.
- (d) Neighbors: `/v1/events` per-IP rate limit (`src/middleware/ratelimit.ts`) now sees every MCP user as the MCP worker's egress IP. [NOTE in PR body: hosted MCP traffic shares the worker's IP bucket; a follow-up can forward `CF-Connecting-IP` once the limiter trusts it.] `/v1/check` rate limit: same. Cron lanes, queues, D1: untouched by the MCP worker. #8 (watch lists) and #10 (site) and #13 (CLI) touch `src/app.ts`/discovery; this plan does not touch `src/app.ts`.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| Second worker `workers/mcp/`, `McpAgent`, streamable HTTP at `/mcp` | T4 | tests/mcp/transport.test.ts `initialize` names `tocsin` |
| Calls public API over HTTP, no DB binding, `TOCSIN_BASE_URL` | T2, T4 | tools.test.ts base-URL case (custom base host appears in every fetched URL); wrangler.toml has no `d1_databases` (transport test env has no `DB`) |
| `tocsin_latest` returns events + one-line human | T1, T3 | tools.test.ts latest case; events-desc.tcs-12.test.ts newest-first |
| `tocsin_check` runtimes `{node:"24.22.0"}` → one affected | T3 | tools.test.ts check case |
| `tocsin_get("CVE-2026-111497")` resolves by CVE | T3 | tools.test.ts get case (fake answers only on `/v1/events/cve/CVE-2026-111497`) |
| `tocsin_watchlist_events` with bearer via MCP connection | T3, T5 | transport.test.ts bearer case; tools.test.ts no-bearer case (0 calls) |
| Each result has `human` (one line) + `data` | T3 | tools.test.ts asserts `!human.includes("\n")` and `data` on all 4 tools |
| wrangler.toml route `mcp.tocsin.sh/*` | T4 | `wrangler deploy --dry-run -c workers/mcp/wrangler.toml`; grep in transport test not used (D3) |
| MCP URL in `/.well-known/tocsin.json` | T6 | discovery.tcs-12.test.ts `endpoints.mcp` + schema-valid |
| llms.txt config block for Claude Code, Cursor, Claude Desktop | T6 | discovery.tcs-12.test.ts asserts the three blocks |
| Out of scope: no OAuth for MCP, no per-tool billing (negative) | T4 | transport.test.ts: `initialize` succeeds with no auth header (no OAuth gate); no billing code added |
| `npm test`, `npm run typecheck` green | T7 | CI |

## Acceptance tests
- `tests/mcp/tools.test.ts` (mcp project; fake `fetch` injected into `TocsinApi`):
  - latest: fake answers `/v1/events?order=desc&limit=10` with 3 events; result `data.events` length 3 in API order; `human` is one line and contains "3 advisories" and the first event id.
  - latest filters: `{ecosystem:"node", min_severity:"high", exploited_only:true, limit:5}` → URL has `ecosystem=node&min_severity=high&exploited=true&limit=5&order=desc`.
  - check: `{runtimes:{node:"24.22.0"}}` → one POST `application/json` body `{"runtimes":{"node":"24.22.0"}}`; fake returns one affected item; `data.affected.length === 1`; human starts "1 of 1 dependencies affected".
  - check lockfile: `{lockfile_name:"package-lock.json", lockfile_text:"…"}` → multipart with field `package-lock.json`.
  - get: `"CVE-2026-111497"` → GET `/v1/events/cve/CVE-2026-111497`; `data.id` equals the fake's id; lower-case input takes the same route; `"GHSA-…"` takes `/v1/events/{id}`.
  - watchlist: no bearer → `isError`, 0 fetch calls; with bearer → header sent, only on that call.
  - errors: 404, 429, 500, network throw → `isError: true`, human names the status; never "No known advisory".
  - base URL: `new TocsinApi("https://self.example/")` → every fetched URL starts with `https://self.example/v1/`.
- `tests/mcp/transport.test.ts` (mcp project, through `workers/mcp/src/index.ts`):
  - `POST /mcp` JSON-RPC `initialize` (Accept `application/json, text/event-stream`) → 200; parse JSON or the SSE `data:` line; `result.serverInfo.name === "tocsin"`.
  - `tools/list` after initialize (with `mcp-session-id`) lists exactly the 4 tool names.
  - bearer: `tools/call tocsin_watchlist_events` with `Authorization: Bearer tcs_test_x` → outbound fake saw that header.
- `tests/routes/events-desc.tcs-12.test.ts` (api project, via `src/index.ts`): seed 5 rows; `?order=desc&limit=2` → cursors [5,4], `has_more=true`, `next_cursor=5`; `?order=desc&since=3` → [5,4]; `?order=bad` → 400; asc response and ETag for `?since=0` unchanged vs no `order` param; desc and asc ETags differ.
- `tests/routes/events-desc-plan.tcs-12.test.ts`: EXPLAIN on 2,000 seeded rows for `order=desc`, `order=desc&ecosystem=node`, `order=desc&exploited=true`, `order=desc&min_severity=critical`: uses the matching index, no `TEMP B-TREE`, no bare `SCAN advisories`.
- `tests/routes/discovery.tcs-12.test.ts`: `endpoints.mcp === "https://mcp.tocsin.sh/mcp"`, top-level `mcp` unchanged, body valid against well-known schema; llms.txt contains `## MCP`, `claude mcp add --transport http tocsin https://mcp.tocsin.sh/mcp`, a Cursor `mcpServers` block, a Claude Desktop `mcp-remote` block, and `order=desc`.

Regression risk: `tests/routes/events.tcs-3.test.ts`, `tests/routes/events-plan.tcs-3.test.ts`, `tests/routes/discovery.tcs-3.test.ts`, `tests/routes/ratelimit.tcs-3.test.ts` (feed route changes); every existing suite (vitest config restructured into projects).

## Verify (run, not edited)
- `npm run typecheck`
- `npm test`
- `npm run gen:schema -- --check` (well-known schema is not edited; must stay clean)
- `npx wrangler deploy --dry-run -c workers/mcp/wrangler.toml`
- `npx wrangler deploy --dry-run` (main worker unchanged in config)

## QA screens
- No browser screens. HTTP QA after deploy:
  - `curl -s https://tocsin.sh/.well-known/tocsin.json | jq .endpoints.mcp` → `https://mcp.tocsin.sh/mcp`.
  - `curl -s https://tocsin.sh/llms.txt | grep -A3 '## MCP'`.
  - `curl -s "https://tocsin.sh/v1/events?order=desc&limit=3"` → newest first.
  - `npx @modelcontextprotocol/inspector` against `https://mcp.tocsin.sh/mcp`: initialize, list tools, call `tocsin_latest`, `tocsin_get`.
  - `claude mcp add --transport http tocsin https://mcp.tocsin.sh/mcp`, then ask for the latest node advisory.

## Sibling claims (not touched)
/root/harness/state/claims/tocsin/ is empty at plan time. Open tickets #8, #10, #13 will touch `src/app.ts` and discovery; this plan does not edit `src/app.ts`.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section
mcp.tocsin.sh <- D8 operator step: DNS record and first deploy of workers/mcp
```

## Design collision check (BH-5791)

Checked 9 listed and 0 derived symbols against main 105274e5687f..105274e5687f and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 12
LINES: 480
DIFF_KB: 70

KIND: feature
SIZE: M
