# TCS-8 plan: Watch lists and API keys (free tier limits)

Ticket: Fortunian/tocsin#8. Blocked-by #3 is CLOSED (Feed API merged as #17), so the ticket is buildable.
Already on main? No. `git log origin/main -S api_keys` and `-S watchlist` show only the plan commit (aa873de), the README and the MCP client (TCS-12). No route, table or middleware exists. Nothing on main does part of this work.
CodeGraph: NOT AVAILABLE on this box. I found callers and dependents with grep and by reading the code. Each risk below names the file that made it a risk.

## Spec changes from comments
- 6329993509, liorwn (2026-10-22T00:53Z): launch is free, no paid tier. `plans` gets ONE seed row `free (max_watchlists=25, webhooks=1, max_components=2000)`, no `pro` row. Tests use 25 and 2001. Limits stay DB rows. The issue body already carries this revision. Delivered by T1 (seed row) and T5/T6 (tests at 25/26 and 2001).

## Scope
1. Migration with 3 tables (`api_keys`, `plans`, `watchlists`), their indexes, the `free` plan row and the new settings rows.
2. `POST /v1/keys`: one key per email, plaintext answered once, sha256 stored, second call 409.
3. Bearer auth middleware `src/middleware/auth.ts`: loads key and plan in one statement.
4. `POST /v1/watchlists`, `GET /v1/watchlists`, `DELETE /v1/watchlists/:id`, limits from the `plans` row (403 with the limit in the body).
5. `GET /v1/watchlists/:id/events`: events from the stored cursor, cursor advances on a 200, `?peek=true` does not advance.
6. Monthly retention cron: a key unused for 365 days and its watch lists are deleted. Documented in `docs/RETENTION.md`.
Out of scope (ticket): webhook delivery (#11), any paid plan, dashboard UI. No UI ships, so the UI iron laws (sortable headers, list-over-cards, drill-down, 375px) do not apply.

## ASSUMPTIONS
- Migration number. The ticket says `migrations/0003_watchlists.sql`, but `0003_settings.sql` exists on main and open PR #62 (TCS-32) adds `0014_backfill.sql` and `0015_node_history.sql`. I use `migrations/0016_watchlists.sql`. A gap (if #62 does not merge) is harmless: D1 applies files in name order. Other reading: 0014, which collides with #62.
- Test file names. The ticket names `tests/routes/keys.test.ts`, `watchlists.test.ts`, `watchlists-plan.test.ts`. The harness rule is per-ticket files, so I use `tests/routes/keys.tcs-8.test.ts`, `tests/routes/watchlists.tcs-8.test.ts`, `tests/routes/watchlists-plan.tcs-8.test.ts`. Same assertions.
- Initial cursor. The ticket does not say where a new list starts. I start it at the newest feed cursor at create time (`COALESCE(MAX(advisories.cursor), 0)`), so the list answers "new events", as the MCP tool text (`workers/mcp/src/index.ts:69` "New events on one of your watch lists") and `tocsin watch` already promise. Other reading: start at 0 and page the whole matching history.
- Filter semantics. The filters combine with AND, the same as `/v1/events`. `components[]` matches `advisories.component` exactly (case-sensitive, like the feed). `runtimes{}` is an object `{ "<runtime>": "<version>" }`; its keys join the ecosystem set (a runtime name is an ecosystem, CLAUDE.md naming). The version is stored but not range-matched (range matching is `/v1/check`). Other reading: version-matched runtime events, which needs the TCS-5 matcher in the feed path.
- `max_components` counts unique, non-empty `components[]` entries only (not runtimes, not ecosystems).
- Delivery. The POST body in the ticket has no delivery field. Every list is stored as `delivery = 'poll'` with `webhook_url`/`webhook_secret` NULL. `plans.webhooks` is seeded but not enforced: that is #11. Other reading: accept `delivery: "webhook"` now, which would store a URL nothing delivers to.
- Key plan. A new key gets `plan = 'free'` from the column DEFAULT in the migration, so the plan choice is in the DB, not in code.
- `last_used_at` is set to `created_at` on insert and moved forward by auth at most once per `auth.last_used_resolution_seconds` (settings row, default 86400). This makes the retention query a plain indexed range (`last_used_at < ?`), and it saves one write per request.
- Retention audit. The ticket asks for a monthly delete. The iron law asks for a dry-run switch and one audit record per run. I write the audit record to KV `retention:api_keys:last` (overwritten each run, one JSON object) plus one log line, and add no audit table. Other reading: a new `retention_runs` table, which then needs its own retention rule.
- Retention dry-run default is `0` (delete). No key can be 365 days unused before 2027-10-23, so the first real delete is a year away and an operator can set `retention.api_keys_dry_run = 1` before then. Other reading: default 1, which never deletes until someone flips it and so does not deliver the ticket line.
- Monthly cron. I add a second cron trigger `17 3 1 * *` (03:17Z on day 1) to `wrangler.toml`, and `runCron` dispatches on `event.cron`. The `*/10` path is unchanged.
- `POST /v1/keys` is anonymous, so it gets the existing per-IP rate limit with its own scope `keys` and settings row `keys.anon_rate_per_minute` (default 5). The authenticated watch list routes get no rate limit in this ticket (they are bounded by the plan row and the page cap).
- CORS stays as is (GET/HEAD/OPTIONS). Clients of POST/DELETE are agents and curl, not browsers.
- Wrong key: a list that belongs to another key answers 404 (not 403), so ids do not leak.
- Missing plan row for a key: fail closed with 500 and one log line. Never fall back to a code constant.

## Changed symbols
- format `migrations/0016_watchlists.sql`: new tables `api_keys`, `plans`, `watchlists`; indexes; seed rows.
- route `POST /v1/keys`: new.
- route `POST /v1/watchlists`: new.
- route `GET /v1/watchlists`: new.
- route `DELETE /v1/watchlists/:id`: new.
- route `GET /v1/watchlists/:id/events`: new (the MCP worker already calls it: `workers/mcp/src/api.ts:54`).
- function `requireApiKey` (src/middleware/auth.ts): new middleware.
- function `sha256Hex` (src/middleware/auth.ts): new.
- function `severitiesAtLeast` (src/feed/query.ts): new export; `buildEventsQuery` uses it instead of its inline slice. callers: left alone: `buildEventsQuery` output is unchanged, pinned by tests/routes/events.tcs-3.test.ts.
- function `parseWatchlistBody` / `buildWatchlistEventsQuery` (src/watchlists/filter.ts, src/watchlists/query.ts): new.
- function `runCron` (src/cron/run.ts): dispatches on `event.cron`; the `*/10 * * * *` path is unchanged. callers: left alone: src/index.ts passes the controller as before.
- function `runKeyRetention` (src/cron/retention.ts): new.
- format `wrangler.toml [triggers] crons`: adds `17 3 1 * *`.
- format `docs/API.md` "Webhook signature" section: the "Not live yet. Watch lists, API keys ... not in the API today" sentence changes; new "API keys and watch lists" section.

## Design collisions
- `migrations/` numbering (`tests/worker/migrations.tcs-1.test.ts` exact list): combine — open PR #62 adds 0014 and 0015 and edits the same list. This ticket uses 0016. Whichever PR merges second rebases and lists all of 0014, 0015, 0016 in the test.
- `src/app.ts` route table: combine — #62 adds `/internal/import`; this ticket adds `/v1/keys` and `/v1/watchlists`. Different lines; a rebase keeps both.
- `docs/API.md` / `site/docs.generated.ts` / `docs/RETENTION.md`: combine — #62 adds coverage and backfill sections; this ticket edits the webhook paragraph and adds new sections. The second to merge re-runs `npm run gen:docs`.

## Files to touch
- `migrations/0016_watchlists.sql` (new)
- `src/middleware/auth.ts` (new)
- `src/routes/keys.ts` (new)
- `src/routes/watchlists.ts` (new)
- `src/watchlists/filter.ts` (new)
- `src/watchlists/query.ts` (new)
- `src/feed/query.ts` (export `severitiesAtLeast`)
- `src/middleware/ratelimit.ts` (add `keysRateLimit` export and its fallback)
- `src/app.ts` (register 2 routes)
- `src/cron/run.ts` (dispatch on cron)
- `src/cron/retention.ts` (new)
- `wrangler.toml` (monthly cron)
- `docs/API.md`, `site/docs.generated.ts` (regenerated by `npm run gen:docs`), `docs/RETENTION.md`
- tests (new): `tests/routes/keys.tcs-8.test.ts`, `tests/routes/watchlists.tcs-8.test.ts`, `tests/routes/watchlists-plan.tcs-8.test.ts`, `tests/routes/watchlists-tenant.tcs-8.test.ts`, `tests/cron/retention.tcs-8.test.ts`, `tests/routes/keys-helpers.tcs-8.ts`
- `tests/worker/migrations.tcs-1.test.ts` (see Tests that must change)

## Tests that must change
- `tests/worker/migrations.tcs-1.test.ts`: it pins the exact applied migration list `0001..0013`; this ticket adds `0016_watchlists.sql`, so the list (and the test name) gains that file. Nothing else in the file changes.

## Verify (run, not edited)
- `npm test`, `npm run typecheck`, `npm run gen:docs -- --check`, `npm run gen:schema -- --check`, `npm run gen:skills -- --check`, `npm run migrate:local`.

## Sibling claims (not touched)
- `/root/harness/state/claims/tocsin/` is empty at plan time: no live sibling build.

## Tasks

### T1. Migration 0016
`migrations/0016_watchlists.sql`, additive only, `CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`:
- `plans(id TEXT PRIMARY KEY, max_watchlists INTEGER NOT NULL, webhooks INTEGER NOT NULL, max_components INTEGER NOT NULL)`; seed `('free', 25, 1, 2000)`.
- `api_keys(id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', email TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL)`.
- `watchlists(id TEXT PRIMARY KEY, key_id TEXT NOT NULL, name TEXT NOT NULL, filter_json TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, delivery TEXT NOT NULL DEFAULT 'poll', webhook_url TEXT, webhook_secret TEXT, created_at TEXT NOT NULL)`.
- Indexes, one comment line each naming its query: `CREATE UNIQUE INDEX idx_api_keys_key_hash ON api_keys(key_hash)` (auth lookup), `CREATE UNIQUE INDEX idx_api_keys_email ON api_keys(email)` (one key per email, `ON CONFLICT(email)`), `CREATE INDEX idx_api_keys_last_used_at ON api_keys(last_used_at)` (retention range), `CREATE INDEX idx_watchlists_key_id ON watchlists(key_id)` (list, count, delete by key).
- Settings rows: `keys.anon_rate_per_minute=5`, `auth.last_used_resolution_seconds=86400`, `watchlists.max_body_bytes=1048576`, `retention.api_key_unused_days=365`, `retention.api_keys_batch=5000`, `retention.api_keys_dry_run=0`.
- D1 is not Supabase: no RLS. Access control is the auth middleware plus `key_id` in every watch list statement.
VALIDATE: `npm run migrate:local` exits 0, and `npm test -- tests/worker/migrations.tcs-1.test.ts tests/routes/watchlists-plan.tcs-8.test.ts` passes (list includes 0016; the 4 named indexes exist; the `free` row is `(25, 1, 2000)`).
SATISFIES: "migrations/0003_watchlists.sql: api_keys(...), plans(...) seeded with one row free (25, 1, 2000) ... watchlists(...). Indexes watchlists(key_id), api_keys(key_hash)."

### T2. `POST /v1/keys`
`src/routes/keys.ts`, mounted at `/v1/keys` with `keysRateLimit` (new `makeRateLimit` instance in `src/middleware/ratelimit.ts`, scope `keys`, setting `keys.anon_rate_per_minute`, fallback constant with a comment naming the row).
- Body `{email}`: JSON, else 400. Normalize `trim().toLowerCase()` once (D17). Reject a value that is not `x@y.z` shape: 400.
- Key: `tcs_` + 64 hex chars from `crypto.getRandomValues(32 bytes)`. Id: `key_` + `crypto.randomUUID()`.
- One statement: `INSERT INTO api_keys (id, key_hash, email, created_at, last_used_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`. `meta.changes === 0` → 409 `{error: "a key already exists for this email"}` with no key. Else 201 `{key, key_id, plan: "free", email}` (plan read back from the row via `RETURNING plan`), `Cache-Control: no-store`.
- Only `sha256Hex(key)` is stored. The plaintext key is never logged.
VALIDATE: `npm test -- tests/routes/keys.tcs-8.test.ts`.
SATISFIES: "POST /v1/keys with {email} issues a key once per email (idempotent: a second call for the same email returns 409 with no new key), returns the plaintext key once. Store sha256 only."

### T3. Auth middleware
`src/middleware/auth.ts`: `requireApiKey` reads `Authorization`, matches `^\s*bearer\s+(tcs_\S+)\s*$`i. No match → 401 `{error: "missing or invalid API key"}` with `WWW-Authenticate: Bearer`.
- One statement: `SELECT k.id, k.plan, k.last_used_at, p.id AS plan_id, p.max_watchlists, p.webhooks, p.max_components FROM api_keys k LEFT JOIN plans p ON p.id = k.plan WHERE k.key_hash = ?`. No row → 401. `plan_id` NULL → 500 `{error: "internal error"}` plus one log line (fail closed, no constant).
- `last_used_at` update: `UPDATE api_keys SET last_used_at = ? WHERE id = ? AND last_used_at < ?` only when the stored value is older than the resolution knob (read in parallel with the key lookup via `Promise.all`).
- Sets `c.set("apiKey", {id, plan, limits})` (typed Hono `Variables`), so routes read the plan once per request.
VALIDATE: `npm test -- tests/routes/watchlists-tenant.tcs-8.test.ts` (no header 401, wrong key 401, malformed header 401, valid key 200).
SATISFIES: "Auth middleware src/middleware/auth.ts: Authorization: Bearer tcs_.... Loads key and plan."

### T4. Watch list CRUD
`src/watchlists/filter.ts` `parseWatchlistBody(body)` → `{ok, name, filter}` or `{ok:false, error}`: `name` non-empty string; `ecosystems` string[]; `components` string[]; `runtimes` object of string→string; `min_severity` one of critical/high/medium/low; `exploited_only` boolean. All but `name` optional. Trim, drop empties, dedupe. Wrong types → 400.
`src/routes/watchlists.ts` (all routes behind `requireApiKey`):
- `POST /`: body size over `watchlists.max_body_bytes` → 413. Invalid → 400. `components.length > plan.max_components` → 403 `{error: "component limit reached", max_components}`. Then one guarded statement: `INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, created_at) SELECT ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor), 0) FROM advisories), 'poll', ? WHERE (SELECT COUNT(*) FROM watchlists WHERE key_id = ?) < ?` bound with `plan.max_watchlists`. `changes === 0` → 403 `{error: "watch list limit reached", max_watchlists}`. Atomic: two parallel creates cannot pass 25. 201 with `{id, name, filter, cursor, delivery, created_at}`.
- `GET /`: `SELECT id, name, filter_json, cursor, delivery, created_at FROM watchlists WHERE key_id = ? ORDER BY created_at, id` → `{watchlists: [...]}`. Bounded by `max_watchlists`. Never returns `webhook_secret`.
- `DELETE /:id`: `DELETE FROM watchlists WHERE id = ? AND key_id = ?`; 204, or 404 when 0 rows.
VALIDATE: `npm test -- tests/routes/watchlists.tcs-8.test.ts` (25 created, 26th 403 with `max_watchlists: 25`; 2001 components 403 with `max_components: 2000`; 2000 components 201; list and delete).
SATISFIES: "POST /v1/watchlists ... enforces plans.max_watchlists and max_components (403 with the limit in the body). GET /v1/watchlists, DELETE /v1/watchlists/:id." and "Limits are read from plans rows, never from constants."

### T5. Watch list events
`src/watchlists/query.ts` `buildWatchlistEventsQuery(filter, since, limit)`: `SELECT cursor, doc_json FROM advisories WHERE cursor > ?` plus, when non-empty, `ecosystem IN (SELECT value FROM json_each(?))` (ecosystems ∪ runtime keys), `component IN (SELECT value FROM json_each(?))`, `severity_label IN (...)` from `severitiesAtLeast` (≤ 4 params), `exploited = 1`; `ORDER BY cursor LIMIT limit + 1`. `json_each` binds the whole list as one JSON parameter, so 2,000 components stay under D1's 100-parameter cap.
`GET /:id/events` in `src/routes/watchlists.ts`:
- `?limit` 1..100, default 50 (reuse `DEFAULT_LIMIT`/`MAX_LIMIT` from `src/feed/query.ts`); non-integer → 400. `?peek` accepts `true`/`false`, else 400.
- Read `SELECT filter_json, cursor FROM watchlists WHERE id = ? AND key_id = ?` → 404 when absent. Run the events query.
- When the page is not empty and peek is not true: `UPDATE watchlists SET cursor = MAX(cursor, ?) WHERE id = ? AND key_id = ?` BEFORE the response is returned (write-then-send; the cursor never moves backward).
- 200 `{events, next_cursor, has_more}` (the same shape as `/v1/events`, which `workers/mcp/src/tools.ts:182` already parses), `Cache-Control: no-store`.
VALIDATE: `npm test -- tests/routes/watchlists.tcs-8.test.ts` (ecosystem=node list returns only node events and the stored cursor advances; `peek=true` leaves the stored cursor; a second poll returns no repeats).
SATISFIES: "GET /v1/watchlists/:id/events returns events matching the watch list filter from its stored cursor and advances the cursor on a successful response ... ?peek=true does not advance."

### T6. Retention cron
`src/cron/retention.ts` `runKeyRetention(env, now)`: read the 3 retention knobs in parallel (`getSettingInt`, fallbacks with a comment naming each row). Cutoff = `now - days`. Dry run: `SELECT COUNT(*) FROM api_keys WHERE last_used_at < ?`, delete nothing. Else one `env.DB.batch` (one transaction): `DELETE FROM watchlists WHERE key_id IN (SELECT id FROM api_keys WHERE last_used_at < ? ORDER BY last_used_at, id LIMIT ?)` then `DELETE FROM api_keys WHERE id IN (same subquery)`. `has_more = keys_deleted === batch`. Write `{ran_at, cutoff, dry_run, keys, watchlists, has_more}` to KV `retention:api_keys:last` and one log line. A failed batch logs the error and rethrows (no success record on failure, D9).
`src/cron/run.ts`: `export const RETENTION_CRON = "17 3 1 * *"`; `if (event.cron === RETENTION_CRON) return runKeyRetention(env, new Date())`; else the ingesters as today. `wrangler.toml` `crons = ["*/10 * * * *", "17 3 1 * *"]`.
VALIDATE: `npm test -- tests/cron/retention.tcs-8.test.ts tests/cron/run.tcs-2.test.ts`.
SATISFIES: "Retention: a key unused for 365 days and its watch lists are deleted by a monthly cron (docs/RETENTION.md)."

### T7. Docs
`docs/RETENTION.md`: sections for `api_keys` (monthly delete after `retention.api_key_unused_days`, dry-run row, batch row, audit KV key), `watchlists` (deleted with their key, and by `DELETE /v1/watchlists/:id`), `plans` (fixed rows, no delete job), KV `retention:api_keys:last` (one key, overwritten); update the settings row count and list. `docs/API.md`: new "API keys and watch lists" section (the 5 routes, the 401/403/404/409/413 answers, the free limits as read from the `plans` row); change the "Not live yet" sentence so it says only webhook delivery is not live. Run `npm run gen:docs` to refresh `site/docs.generated.ts`.
VALIDATE: `npm run gen:docs -- --check` exits 0, and `grep -n "api_keys" docs/RETENTION.md` shows the new section.
SATISFIES: "(docs/RETENTION.md)" in the retention line; D5/D13: the API doc must not say watch lists are not live.

## System invariants
(a) Cross-run state. Key identity: `api_keys` with unique `idx_api_keys_email` (one key per email) and unique `idx_api_keys_key_hash`. Watch list position: `watchlists.cursor`, one row per list, moved only by `MAX(cursor, ?)`. Plan limits: `plans` rows. Knobs: `settings` rows. Retention audit: KV `retention:api_keys:last` (an operator record, not a dedup store). Nothing dedups or claims through config JSON.
(b) Side effects. `POST /v1/keys`: the row is written before the key is returned; a lost response leaves a key the caller never saw, and a retry answers 409 (the ticket's rule; documented in API.md). Events: the cursor is written before the 200 is sent; if the client drops the response, those events are skipped for that list (the ticket's "advances on a successful response"; a caller that cannot accept this uses `peek=true` and then a second call). A failed cursor UPDATE answers 500 and returns no events, so "events sent, cursor not moved" can only re-send, never skip silently. Retention: delete batch is one transaction; the audit record is written only after it commits.
(c) Negative list for the destructive retention delete. Must NOT delete: a key used 364 days ago; a key created 400 days ago but used yesterday; a key used exactly at the cutoff instant (`<` not `<=`); any key when `retention.api_keys_dry_run = 1`; watch lists of a kept key when another key is deleted. Tests in `tests/cron/retention.tcs-8.test.ts` cover each. Negative list for the auth matcher: `Basic ...`, `Bearer` with no token, `Bearer abc` (no `tcs_`), a valid key with an extra character, a hash of a real key sent as the token: all 401.
(d) Neighbors. The `*/10` ingest cron: `runCron` dispatch only adds a branch for the new cron string; the existing branch is unchanged (tests/cron/run.tcs-2.test.ts stays green). Rate-limit KV: the `keys` scope has its own `rl:v1:keys:` prefix, so it uses no feed or check budget. Feed query: `severitiesAtLeast` export leaves `buildEventsQuery` output byte-identical (events tests pin it). MCP worker: already calls `GET /v1/watchlists/:id/events` and parses `{events}`; this ticket makes that call work, it changes no MCP code. Webhooks (#11) will read `delivery`, `webhook_url`, `webhook_secret` and `plans.webhooks`; this ticket creates them and leaves them unused.

## Performance
No screen. Per-request statements (D1): `POST /v1/keys` 2 (rate setting, insert) plus 2 KV ops; auth 1 read + 1 settings read in parallel, +1 conditional write at most once a day per key; `POST /v1/watchlists` auth + 1 settings read + 1 guarded insert; `GET /v1/watchlists` auth + 1; `DELETE` auth + 1; events auth + 1 list read + 1 events read + at most 1 update. The list read and events read are sequential by necessity (the events query needs the filter). Indexes: `idx_api_keys_key_hash`, `idx_api_keys_email`, `idx_watchlists_key_id`, `idx_api_keys_last_used_at`, and the existing advisories cursor/ecosystem/component/severity/exploited indexes. Page cap 100. No correlated per-row subquery: the retention and limit subqueries are uncorrelated or keyed on an index.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| api_keys/plans/watchlists tables | T1 | migrations.tcs-1 (list), watchlists-plan.tcs-8 (tables + indexes exist) |
| plans seeded with one row `free (25, 1, 2000)`, no `pro` row (comment 6329993509) | T1 | watchlists-plan.tcs-8: `SELECT * FROM plans` = exactly one row `free,25,1,2000` |
| Indexes watchlists(key_id), api_keys(key_hash) | T1 | watchlists-plan.tcs-8 EXPLAIN |
| Key issued once per email; second call 409, no new key | T2 | keys.tcs-8 |
| Plaintext returned once; sha256 only stored | T2 | keys.tcs-8 (row `key_hash` = sha256 of answered key; no column equals the key) |
| Bearer auth loads key and plan | T3 | watchlists-tenant.tcs-8 |
| max_watchlists enforced, 403 with limit | T4 | watchlists.tcs-8 (25 ok, 26th 403 `max_watchlists: 25`) |
| max_components enforced, 403 | T4 | watchlists.tcs-8 (2001 → 403 `max_components: 2000`) |
| Limits from plans rows, never constants | T4 | watchlists.tcs-8: UPDATE plans SET max_watchlists = 2 for a fresh key's plan copy (`INSERT plans 'tcs8test'`), key on that plan gets 403 at the 3rd |
| GET list, DELETE | T4 | watchlists.tcs-8 |
| Events from stored cursor, filter applied, cursor advances | T5 | watchlists.tcs-8 (ecosystem=node only node, cursor advanced) |
| peek=true does not advance | T5 | watchlists.tcs-8 |
| Monthly retention: 365-day unused key + its lists deleted | T6 | retention.tcs-8 |
| docs/RETENTION.md | T7 | gen:docs --check; review read |
| NEGATIVE: no paid plan / no `pro` row | T1 | watchlists-plan.tcs-8 (one plans row) |
| NEGATIVE: no webhook delivery in this ticket | T4 | watchlists.tcs-8: created list has `delivery = 'poll'`, `webhook_url` NULL |
| NEGATIVE: a wrong key reads/changes nothing (tenant) | T3/T4/T5 | watchlists-tenant.tcs-8 (0 rows, 404, other cursor unchanged) |

## Acceptance tests
All in the vitest `api` project (`@cloudflare/vitest-pool-workers`), through `exports.default.fetch` (the production entry, D2). Each test makes its own keys with unique emails (`<test>-<uuid>@example.test`) and seeds advisories with its own id prefix and cursor range (`tests/routes/seed.tcs-3.ts` `seed`/`idFor`). No shared data, no order dependence. No external vendor is called: these routes call none, so no seam or fake is needed (BH-7563 n/a).
- `tests/routes/keys-helpers.tcs-8.ts`: `newKey(email)`, `authed(method, path, key, body?)` helpers.
- `tests/routes/keys.tcs-8.test.ts`: 201 with `key` matching `^tcs_[0-9a-f]{64}$`; second POST same email (also with different case and spaces) 409 and body has no `key`; `api_keys` row count for that email is 1; stored `key_hash` equals sha256 hex of the key and no column of the row equals the key; invalid email 400; non-JSON 400.
- `tests/routes/watchlists.tcs-8.test.ts`: 25 creates 201, 26th 403 body `max_watchlists: 25`; 2001 unique components 403 body `max_components: 2000`; 2000 components 201; a plan row inserted by the test with `max_watchlists = 2` gives 403 at the 3rd create (limits read from rows); list `ecosystems:["node"]`, then seed node + npm + php advisories above the list's cursor → events only node, `next_cursor` = newest node cursor, stored `watchlists.cursor` equals it; second call returns `[]`; `peek=true` returns the events and stored cursor is unchanged; `components` filter with 2000 entries returns the matching one; `min_severity=high` excludes medium; `exploited_only` returns only exploited; `runtimes:{node:"24.0.0"}` matches node events; `limit=1` gives `has_more: true` and advances by one; GET list returns the created lists without `webhook_secret`; DELETE 204 then 404; created list has `delivery: "poll"`.
- `tests/routes/watchlists-tenant.tcs-8.test.ts`: no Authorization 401; `Basic x` 401; `Bearer abc` 401; key + one extra char 401; key B GET events / DELETE on key A's list → 404 and A's stored cursor and row are unchanged; key B GET list returns 0 of A's lists.
- `tests/routes/watchlists-plan.tcs-8.test.ts`: over 2,000 seeded keys and 2,000 watch lists, `EXPLAIN QUERY PLAN` for the auth lookup contains `USING INDEX idx_api_keys_key_hash`; list-by-key and the count subquery use `idx_watchlists_key_id`; retention select uses `idx_api_keys_last_used_at`; the watch list events query (ecosystem and components variants, 2,000 advisories) shows no bare `SCAN advisories`; `plans` has exactly one row `free,25,1,2000`.
- `tests/cron/retention.tcs-8.test.ts`: key used 366 days ago and its 2 lists deleted; key used 364 days ago kept; key created 400 days ago but used yesterday kept; key exactly at cutoff kept; another key's lists kept; `retention.api_keys_dry_run=1` deletes nothing and the KV audit has `dry_run: true` and the matched count; batch knob `1` deletes one key and the audit says `has_more: true`; `runCron` with `17 3 1 * *` runs retention and calls no ingester; `runCron` with `*/10 * * * *` deletes no key.
Regression risk: `tests/routes/events.tcs-3.test.ts`, `events-plan.tcs-3.test.ts`, `events-desc*.tcs-12.test.ts` (feed/query.ts edit); `tests/cron/run.tcs-2.test.ts` (runCron dispatch); `tests/routes/ratelimit.tcs-3.test.ts` (ratelimit.ts edit); `tests/worker/migrations.tcs-1.test.ts`; `tests/routes/site.tcs-10.test.ts` (docs render); `tests/mcp/tools.test.ts` (no change expected).
Mutation check (D1): remove the `WHERE COUNT < ?` guard → the 26th-list test fails; drop the cursor UPDATE → the advance test fails; ignore `peek` → the peek test fails; delete `key_id = ?` from the events read → the tenant test fails; change `<` to `<=` in retention → the at-cutoff test fails.

## QA screens
None. This ticket has no UI. A smoke pass with curl against `npm run dev`: `POST /v1/keys` → `POST /v1/watchlists` → `GET /v1/watchlists/:id/events?peek=true` → `GET /v1/watchlists/:id/events` → `DELETE /v1/watchlists/:id`.

## Design collision check (BH-5791)

Checked 14 listed and 0 derived symbols against main a300577231d7..a300577231d7 and 1 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 12
LINES: 560
DIFF_KB: 70

KIND: feature
SIZE: M
