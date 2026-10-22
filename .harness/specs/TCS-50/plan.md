# TCS-50 plan: status ledger counts and a warnings channel

Ticket: Fortunian/tocsin#50. Blocked-by #39 is CLOSED (merged as 7d04d9a and a627f29).
Thread: 0 comments. The issue body is the spec.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-22T21:47:54Z` shows only a627f29, 7d04d9a (TCS-39) and b015b70 (CI). `git log origin/main -Slast_warning` and `-Sledger` in `src/` find no status ledger or `last_warning` column.

CodeGraph: NOT AVAILABLE on this box. Callers below come from grep.

## Spec changes from comments
none

## Scope
1. `GET /v1/status`: each source with a ledger table gets a `ledger` object `{ ok, empty, pending, failed_retrying, failed_terminal }`. A source with no ledger has no `ledger` key. Each ledger table gets one grouped read (GROUP BY state). The read rides in the existing `db.batch`, so the route stays at one D1 round trip.
2. `/status` (HTML): a second row under each source that has a ledger shows the 5 counts as plain text. The terminal count is not a link.
3. `RunResult.warnings?: string[]`. `runIngesters` writes it to a new nullable `sources.last_warning` column (migration 0012) and does not mark the source failed. The python-runtime "failed terminally after N attempts" note moves from `errors` to `warnings`.

Out of scope (ticket): a per-record detail page, alerts.

## Files to touch
- `migrations/0012_source_last_warning.sql` (new): `ALTER TABLE sources ADD COLUMN last_warning TEXT;` Additive. Header comment states retention.
- `src/ingest/types.ts`: add `warnings?: string[]` to `RunResult`, with a comment.
- `src/ingest/registry.ts`: `MARK_OK` and `MARK_FAILED` set `last_warning = COALESCE(?, last_warning)`; bind the joined warnings (cut to the existing `MAX_ERROR_CHARS`) or NULL.
- `src/ingest/python-runtime.ts`: the run result starts with `warnings: []`; line 129 pushes the terminal note to `result.warnings`, not `result.errors`. Update the comments at lines 15-16 and 128.
- `src/ingest/ledgers.ts` (new): `LEDGER_TABLES: Record<string, string> = { "python-runtime": "python_runtime_records" }`, `ledgerSql(table)`, the `LedgerCounts` type and `toLedgerCounts(rows)`.
- `src/site/data.ts`: `STATUS_SOURCES_SQL` also selects `last_warning`. `loadStatus(db, opts?: { ledger?: boolean })`: with `ledger: true`, add one ledger statement per enabled source that has a ledger table to the same `db.batch`, and attach `ledger` to that source.
- `site/status.ts`: `StatusSource` gains `last_warning: string | null` and `ledger?: LedgerCounts`. `renderStatus` adds a sub-row under a source with a ledger or a warning.
- `src/routes/status.ts`: call `loadStatus(c.env.DB, { ledger: true })`.
- `src/routes/site.ts`: the `/status` page calls `loadStatus(c.env.DB, { ledger: true })`. Home and badge stay on `loadStatus(db)`, which makes no ledger read.
- `docs/RETENTION.md`: one line under `## sources` for `last_warning`.
- `tests/routes/status-ledger.tcs-50.test.ts` (new).
- `tests/cron/warnings.tcs-50.test.ts` (new).
- `tests/ingest/python-runtime.tcs-39.test.ts` (TEST-CHANGE, see below).

## Tests that must change
- `tests/ingest/python-runtime.tcs-39.test.ts`: the case "the tenth failed attempt makes the record terminal, reported once" (line 371) asserts `res.errors[0]` holds the terminal note. This ticket moves that note to `res.warnings`. The case changes to `res.errors` equal to `[]` and `res.warnings[0]` matching the same regex. Every other assertion in the file stays.

## Verify (run, not edited)
- `npm test`
- `npm run typecheck`
- `npm run migrate:local`
- `tests/routes/site.tcs-10.test.ts`, `tests/routes/site-plan.tcs-10.test.ts`, `tests/routes/site-freshness.tcs-35.test.ts`, `tests/cron/run.tcs-2.test.ts`, `tests/cron/runtime-ingest.tcs-6.test.ts` (regression risk, see below)

## Sibling claims (not touched)
- TCS-28 claims `docs/API.md` and `site/docs.generated.ts`. This plan does not edit them. The `/v1/status` doc line for `ledger` and `last_warning` is left for a later docs change (see ASSUMPTIONS).
- TCS-29 claims the php-runtime ingester files and `tests/cron/runtime-ingest.tcs-6.test.ts`. This plan does not edit them.

## Changed symbols
- format `RunResult`: new optional `warnings: string[]`. callers: left alone: other ingesters omit it, which keeps `last_warning` unchanged.
- function `runIngesters`: writes `last_warning` from `result.warnings`; a run with warnings and no errors stays `ok`.
- function `loadStatus`: new optional `{ ledger }` argument; selects `last_warning`. callers: left alone: `readFreshness` (home) and the badge route keep the no-ledger call, so they make no extra read.
- format `StatusSource`: new `last_warning` and optional `ledger`.
- function `renderStatus`: renders the ledger and warning sub-row.
- route `GET /v1/status`: response gains `last_warning` per source and `ledger` per source with a ledger.
- route `GET /status`: page gains the sub-row.
- function `handleRecord` (python-runtime): terminal note goes to `warnings`.

## Design

### Ledger read (T2)
SQL per ledger table, built from the code map (never from a request value):
```
SELECT state, COUNT(*) AS n, SUM(next_check_at IS NULL) AS no_next FROM python_runtime_records GROUP BY state
```
- `idx_python_runtime_records_state_next (state, next_check_at)` covers it. Expected plan: `SCAN python_runtime_records USING COVERING INDEX idx_python_runtime_records_state_next`, no `TEMP B-TREE`. At most 4 groups (the CHECK constraint), so the result is bounded.
- Mapping: `ok`, `empty`, `pending` = `n` of that state. `failed_terminal` = `no_next` of `failed`. `failed_retrying` = `n - no_next` of `failed`. A state with no rows is 0. Here 0 is a measured zero, because the grouped read ran and found no rows (D11).
- Batch order: `[sources, cursor, ...ledger statements]`. The ledger statements are chosen from `LEDGER_TABLES` only, before the batch. A ledger table whose source is not enabled is still read, and the result is dropped. This keeps the batch to one round trip. Today that is 1 table.

### Reads and statement count (PERFORMANCE BY DEFAULT)
- `/v1/status` and `/status`: 1 D1 round trip (`db.batch`), 3 statements (sources, max cursor, 1 ledger). Before: 2 statements. All 3 run in one batch, so they do not wait on each other.
- Indexes: sources is a fixed 7-row table (existing test says it needs no index); cursor uses `idx_advisories_cursor`; the ledger read uses `idx_python_runtime_records_state_next`.
- Home (`/`) and `/badge/status.svg`: unchanged, 2 statements, no ledger read.
- Loading skeleton: n/a. Both routes are server-rendered Worker responses with no client-side loading state (no Next.js, no `loading.tsx` in this stack).
- Each new runtime ledger (#41) adds one line to `LEDGER_TABLES` and one statement to the batch.

### Warnings write (T3)
- `MARK_OK = "UPDATE sources SET last_run_at = ?, last_ok_at = ?, last_error = NULL, last_warning = COALESCE(?, last_warning) WHERE id = ?"`.
- `MARK_FAILED = "UPDATE sources SET last_run_at = ?, last_error = ?, last_warning = COALESCE(?, last_warning) WHERE id = ?"`.
- The bound value is `warnings.join("; ").slice(0, MAX_ERROR_CHARS)` when `warnings` has 1 or more items, else NULL. It is still one statement per source, as today.
- `outcome.status` is decided by `errors` only. A run with warnings and no errors is `ok`, moves `last_ok_at`, and sets `last_error` NULL.
- `freshnessOf` reads only `last_error` and `last_ok_at`, so a warning never changes the home freshness line or the badge.

### Status HTML (T4)
- Under a source with `ledger` or a non-null `last_warning`: `<tr class="sub"><td></td><td colspan="2">…</td></tr>`.
- Ledger text: `ledger: ok N · empty N · pending N · failed, retrying N · failed, terminal N`. All plain text, no link.
- Warning text: `last warning: <escaped text>`. Every value goes through `escapeHtml`.
- The header row stays `source | last ok | last error`, so the tcs-10 header test is not affected.
- 375px: the table already sits in `<div class="table">` with its own scroll. The sub-row adds no width beyond the existing error column.

## Design collisions
- `RunResult`: combine — 106d954 (TCS-6, on main as e344048) only builds `RunResult` values in node-runtime and php-runtime with the existing four fields and does not change the type. This plan adds an optional `warnings?`, so those two ingesters compile unchanged, omit it, and keep `last_warning` unchanged through the bound NULL.
- `GET /v1/status`: combine — e5b40d6 (TCS-14, open PR #31) adds `scripts/launch-check.sh`, which reads only `.sources[].id` and `.sources[].last_ok_at` and does not change the route. This plan only adds the `last_warning` and `ledger` keys, and a warnings-only run stays `ok` and moves `last_ok_at`, so the launch `status` check and its L1-L7 tests keep their result.

## Tasks

### T1. Migration 0012: `sources.last_warning`
Write `migrations/0012_source_last_warning.sql` with one `ALTER TABLE sources ADD COLUMN last_warning TEXT;` and a header comment (additive, retention: one value per source row, overwritten by the next run that has a warning). Add the line to `docs/RETENTION.md` under `## sources`.
VALIDATE: `npm run migrate:local` exits 0, and `npx wrangler d1 execute DB --local --command "SELECT last_warning FROM sources LIMIT 1"` returns a row with `last_warning` NULL.
SATISFIES: Scope 3, "a new nullable `sources.last_warning` column (additive migration)".

### T2. Ledger counts in `GET /v1/status`
Add `src/ingest/ledgers.ts`. Extend `loadStatus` with `{ ledger: true }` and the batch statements. Select `last_warning` in `STATUS_SOURCES_SQL`. Switch `src/routes/status.ts` to the ledger call.
VALIDATE: `npm test -- tests/routes/status-ledger.tcs-50.test.ts` passes: the seeded counts, the no-`ledger`-key case and the EXPLAIN case.
SATISFIES: Scope 1, "`GET /v1/status` gains an optional `ledger` object per source … from one grouped read per ledger table (bounded: GROUP BY state)", and AT "seeded ledger rows yield the right counts; a source with no ledger has no `ledger` key; the grouped read uses the `(state, next_check_at)` index".

### T3. `RunResult.warnings` and `last_warning`; move the python-runtime terminal note
Add `warnings?` to `RunResult`. Change `MARK_OK` and `MARK_FAILED` in `registry.ts`. In `python-runtime.ts`, start the result with `warnings: []` and push the terminal note to it. Change the tcs-39 case as listed in "Tests that must change".
VALIDATE: `npm test -- tests/cron/warnings.tcs-50.test.ts tests/ingest/python-runtime.tcs-39.test.ts` passes.
SATISFIES: Scope 3, "a `warnings` field on `RunResult` … writes to … `sources.last_warning` … without marking the source failed; the python-runtime one-time terminal note moves there", and AT "a run with warnings and no errors keeps `last_ok_at` moving and `last_error` NULL, and writes `last_warning`".

### T4. Ledger counts on `/status` (HTML)
Add `last_warning` and `ledger?` to `StatusSource`. Render the sub-row in `renderStatus`. Switch the `/status` route in `src/routes/site.ts` to `loadStatus(c.env.DB, { ledger: true })`.
VALIDATE: `npm test -- tests/routes/status-ledger.tcs-50.test.ts` passes the HTML case: `GET /status` with seeded rows contains `pending 2` and `failed, terminal 1` in the python-runtime sub-row, and contains no `<a` in that sub-row.
SATISFIES: Scope 2, "`/status` (HTML) shows the counts under the source row, with the terminal count linking to nothing yet".

## Acceptance tests

`tests/routes/status-ledger.tcs-50.test.ts` (vitest, `@cloudflare/vitest-pool-workers`, through `SELF.fetch` / the app, the production entry point, D2). Each case seeds its own rows with ids unique to the case (`PSF-2050-<case>-<n>`) and deletes them in `afterEach`.
1. Seed python_runtime_records: 3 ok, 1 empty, 2 pending, 2 failed with `next_check_at` set, 1 failed with `next_check_at` NULL. `GET /v1/status` → the `python-runtime` source has `ledger` equal to `{ ok: 3, empty: 1, pending: 2, failed_retrying: 2, failed_terminal: 1 }`. Asserts only `ledger`, not the whole body (D56).
2. Same request: `osv`, `nvd`, `kev`, `epss`, `node-runtime`, `php-runtime` have no `ledger` key (`expect(s).not.toHaveProperty("ledger")`).
3. Empty ledger table: `python-runtime.ledger` equals all zeros (the read ran; 0 is measured).
4. Every source in `/v1/status` has a `last_warning` property.
5. EXPLAIN QUERY PLAN on `ledgerSql("python_runtime_records")` after seeding 2,000 rows across the 4 states: the plan contains `idx_python_runtime_records_state_next`, does not match `/SCAN python_runtime_records(?! USING)/`, and contains no `TEMP B-TREE`. No ANALYZE.
6. `GET /status` HTML with the case-1 seed: the python-runtime sub-row contains `pending 2`, `failed, retrying 2`, `failed, terminal 1`; the sub-row contains no `<a`; the `osv` row has no sub-row.
7. The home loader makes no ledger read: `loadStatus(env.DB)` (no option) returns sources with no `ledger` key.

`tests/cron/warnings.tcs-50.test.ts` (through `runIngesters`, with stub ingesters in a test registry and only the stubbed source ids enabled for the case):
1. An ingester returns `{ errors: [], warnings: ["fixture: warn one"] }` → outcome `ok`; the row has `last_ok_at` = the pinned now, `last_error` NULL, `last_warning` = `fixture: warn one`.
2. Start from `last_error = 'fixture: old'`: a warnings-only run sets `last_error` NULL (it stays `ok`).
3. A later run with no warnings keeps `last_warning` (COALESCE) and moves `last_ok_at`.
4. A run with errors and warnings → `failed`, `last_error` set, `last_warning` written, `last_ok_at` unchanged.
5. A 2,000-char warning is stored cut to 1,000 chars (the existing `MAX_ERROR_CHARS`).
6. Python-runtime end to end: a record at 9 failed attempts plus the 404 fake (same fixture as tcs-39) through `runIngesters` → python-runtime outcome `ok`, `last_error` NULL, `last_warning` matches `/^PSF-2026-43: failed terminally after 10 attempts/`.

Mutation checks the build runs (D1): (a) make `runIngesters` count warnings as errors → warnings cases 1, 2 and 6 go red; (b) drop `SUM(next_check_at IS NULL)` and report all failed as retrying → status case 1 goes red; (c) remove the `{ ledger: true }` in `src/routes/status.ts` → status case 1 goes red.

Regression risk:
- `tests/routes/site.tcs-10.test.ts`: asserts `/v1/status` source properties and the `/status` header. The header is unchanged and the case asserts properties, not the whole object.
- `tests/routes/site-plan.tcs-10.test.ts`: asserts `STATUS_SOURCES_SQL` contains `WHERE enabled = 1`. Still true.
- `tests/routes/site-freshness.tcs-35.test.ts`: home and badge use `loadStatus(db)`. Its failure case renames `sources`; the batch still fails as a whole, the same as today.
- `tests/cron/run.tcs-2.test.ts`, `tests/cron/runtime-ingest.tcs-6.test.ts`: they assert `last_error` and `last_ok_at` after runs. With no `warnings`, the bound NULL keeps `last_warning` NULL and the other columns behave as before.
- `tests/ingest/python-runtime.tcs-39.test.ts`: changed on purpose (above).

## QA screens
- `https://tocsin.sh/status`: the python-runtime row has a sub-row with 5 ledger counts; other rows have none (unless they have a warning); no horizontal body scroll at 375px.
- `https://tocsin.sh/v1/status`: JSON; `python-runtime` has `ledger`, every source has `last_warning`.
- `https://tocsin.sh/` and `https://tocsin.sh/badge/status.svg`: unchanged freshness line and badge.

## Iron laws, applied
- Additive schema: one `ADD COLUMN`, no drop or rename (repo rule 1, D20). D1 is not Supabase, so no RLS.
- Indexes: no new table and no new query on a new table. The ledger read on the existing table uses the existing `(state, next_check_at)` index, proven with EXPLAIN on 2,000 seeded rows (status case 5). No correlated subquery.
- Retention: no new growing table. `last_warning` is one value on a fixed 7-row table, overwritten in place. The line goes into `docs/RETENTION.md`.
- Knobs (D69): no new limit. The warning cut reuses the existing `MAX_ERROR_CHARS` (1000) in `registry.ts`, the same cap `last_error` has today. `LEDGER_TABLES` maps a source id to its schema table; it is schema wiring, not a business parameter, and a table name from the DB would be an SQL injection path.
- Dedup before spend: no metered call is added or changed.
- Feed reads are cheap (repo rule 8): the grouped read returns at most 4 rows.
- Sortable headers: the `/status` table is an existing, server-rendered 7-row table with no JS and no sort today. This plan does not add sort (see ASSUMPTIONS). List over cards: already a table. Drill-down: the ticket says the terminal count links to nothing yet. No native dialogs. De-AI: no LLM text.
- Scalable tests: no vendor call. The python case uses the existing local fake (`createPyFake`) through the existing fetch spy. Each case seeds its own ids.

## Build-discipline rules that bite
- D1/D63: the mutation checks above.
- D2: status cases go through the app routes; warnings cases go through `runIngesters`.
- D11: a ledger 0 is a measured zero from a grouped read that ran. No `?? 0` on an unread table: a source with no ledger table has no `ledger` key.
- D13: the HTML counts render only from a ledger read in the same batch.
- D56: assert `ledger`, `last_warning` and the specific columns, never the whole payload.
- D62/D65: the tcs-39 change is a premise change with a TEST-CHANGE line, not a weakened test. Every other assertion in that file stays.
- D67: the PR delivers every scope and acceptance item, so `Closes #50` is right unless an item ends NOT RUN.

## ASSUMPTIONS
- `last_warning` lifetime: the ticket does not say when a warning clears. I assume a run with no warnings keeps the last warning (`COALESCE`), so a one-time terminal note stays visible past the next cron tick. Other reading: clear it on each run with no warnings, the same as `last_error`; that loses the one-time note within one cron interval.
- `last_warning` on a failed run: I assume a run with errors and warnings writes both. Other reading: write warnings only on ok runs.
- Ledger map: I assume a code map `LEDGER_TABLES` (source id → table). Other reading: a `ledger_table` key in `sources.config_json`; I did not choose it because it would put a table name from data into SQL.
- `/status` also shows `last_warning` in the sub-row. The ticket asks only for the counts in the HTML. Other reading: show the warning only in JSON. I chose to show it because an operator otherwise has no page that shows the new channel.
- Only the "failed terminally after N attempts" note moves to `warnings`. The other python-runtime errors (an `empty` record with a normalizer error, an unreadable pending state, a truncated listing) stay in `errors`. Other reading: move every one-time terminal note.
- Ledger read on home and badge: I assume they do not need ledger counts, so they make no ledger read and stay at 2 statements. Other reading: one loader for all four screens.
- `docs/API.md` (the `/v1/status` doc): sibling TCS-28 is editing it now, so this PR does not touch it. A follow-up docs edit adds `ledger` and `last_warning` to the `/v1/status` example after TCS-28 merges. This is a [NOTE]-level docs gap.
- Sort on `/status`: not added. It is a 7-row operational page with no client script, and the new sub-rows would break a row sort.

## System invariants
(a) Cross-run state: `sources.last_warning` (one column on the fixed `sources` table, natural key `sources.id`). The ledger counts are a read, not stored state.
(b) Side effects: the only write is the existing per-source status UPDATE. It runs after the ingester returns. On ok: `last_ok_at`, `last_error` NULL, `last_warning` from warnings or kept. On failed: `last_error`, `last_warning` from warnings or kept. On a thrown ingester: no `result`, so warnings are NULL and `last_warning` is kept. A failed status write is logged, as today, and does not stop the next source.
(c) Negative list, cases that must NOT mark a source failed or change `last_error`: warnings present and errors empty (cases 1, 2); warnings `[]` (python-runtime's normal run, and 6 other ingesters with no `warnings` key: existing cron tests). Cases that must NOT write `last_warning`: `warnings` undefined; `warnings` `[]`.
(d) Neighbors: `freshnessOf` (home, badge) reads only `last_error` and `last_ok_at`, so warnings never change them. The cron lane runs sources in sequence, as today, with no new lock. The site KV cache (`site:latest:v2`) holds freshness only, so it carries no ledger and needs no new invalidation. #41 (Deno and Bun) adds its table to `LEDGER_TABLES`.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| `/v1/status` gains `ledger` per source with the 5 counts | T2 | status-ledger case 1 |
| A source with no ledger has no `ledger` key | T2 | status-ledger case 2 |
| One grouped read per ledger table, bounded GROUP BY state | T2 | status-ledger case 5 (plan) and case 1 |
| The read uses the `(state, next_check_at)` index, EXPLAIN, no ANALYZE | T2 | status-ledger case 5 |
| `/status` HTML shows the counts under the source row | T4 | status-ledger case 6 |
| The terminal count links to nothing (negative) | T4 | status-ledger case 6 (no `<a` in sub-row) |
| `RunResult.warnings` (optional) | T3 | warnings cases 1-5 |
| `runIngesters` writes `last_warning`, nullable additive column | T1, T3 | warnings case 1; migrate:local |
| Warnings do not mark the source failed; `last_ok_at` moves, `last_error` NULL (negative) | T3 | warnings cases 1, 2 |
| The python-runtime one-time terminal note moves to warnings (and leaves errors, negative) | T3 | warnings case 6; tcs-39 changed case (`errors` equal `[]`) |
| Source status stays ok for python-runtime | T3 | warnings case 6; tcs-39 line 389 case |
| Out of scope: detail page, alerts | none | none |

```pr-body-requires
TEST-CHANGE: tests/ingest/python-runtime.tcs-39.test.ts <- Tests that must change
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Design collision check (BH-5791)

Checked 8 listed and 0 derived symbols against main a627f293b6a2..a627f293b6a2 and 1 open PRs.
- `RunResult` (function, listed): PR #31 106d954670e2, (text match). Resolution: combine.
- `GET /v1/status` (function, listed): PR #31 e5b40d62455c, (text match). Resolution: combine.

## Size
FILES: 9
LINES: 120
DIFF_KB: 18

KIND: feature
SIZE: M
