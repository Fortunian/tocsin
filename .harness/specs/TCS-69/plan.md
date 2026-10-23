# TCS-69 plan: node-runtime post ledger (empty / pending / failed), source stays ok

Ticket: Fortunian/tocsin#69. Blocked-by #32 is CLOSED. The thread has 0 comments, so the issue body is the spec.
Already on main? No. `git log origin/main --since=2026-10-23T04:50:32Z` is empty. No `node_runtime_posts` or `LEDGER_TABLES["node-runtime"]` on main or in open PRs #67, #68, #70.
CodeGraph: NOT AVAILABLE on this box. I found callers with grep (cited below).

## Spec changes from comments
none

## Scope

The node-runtime ingester (`src/ingest/node-runtime.ts`) stops using the KV cursor (`cursor:node-runtime`) and the KV parser key (`cursor:node-runtime:parser`). A new D1 ledger table `node_runtime_posts` holds one row per post URL. The ledger decides which posts a run reads.

Per post outcome:

| Post read result | Row state | next_check_at | Run report |
|---|---|---|---|
| CVEs emitted (today's "ok" path, with or without "not emitted" errors) | `ok` | NULL | as today (errors for not-emitted CVEs stay errors) |
| No CVE heading, no pre-announcement marker, post older than `retry_incomplete_days` | `empty` (terminal) | NULL | one warning, no error |
| Same, post newer than `retry_incomplete_days` | `failed`, attempts+1 | now + `pending_recheck_minutes`; NULL at `max_attempts` | error (as today, "no CVE headings"); at the cap a warning |
| Pre-announcement (no CVE heading, marker present) | `pending` | now + `pending_recheck_minutes` (post newer than `retry_incomplete_days`) or now + `pending_old_recheck_minutes` (older) | no error, summary line |
| Incomplete, recent (fixed version missing) | `failed`, attempts+1 | now (read again next run, as today) | error (as today); the run stops (as today) |
| Incomplete, older than `retry_incomplete_days` | `failed` terminal | NULL | error once (as today) |
| Off-origin link (NodeLinkError), or old post 404/410 | `failed` terminal | NULL | error once (as today) |
| Recent HTTP error / D1 error | no row written | n/a | throws out of the run (as today) |

Which posts a run reads (all inside the `backfill_days` window, oldest `published` first, at most `max_posts`):
1. a feed post with no ledger row (new, or out of order);
2. a feed post whose row has a different `published` (re-published) or a different `parser_rev` (parser changed);
3. a row in `pending` or `failed` with `next_check_at <= now` (the DUE READ; the row's URL and stored `published` are used even if the post left the feed);
4. the newest row in state `ok` (Node edits a release post in place: today's "post at the cursor is read again").

Pre-announcements no longer stop the run. An `empty` row and an `ok` row (except rule 4) are never read again.
`/v1/status` and `/status` show the node-runtime ledger counts through `LEDGER_TABLES`.

## Files to touch

- `migrations/0020_node_runtime_posts.sql` (NEW). 0018 and 0019 are used by open PRs #67, #68, #70.
- `src/ingest/node-runtime-posts.ts` (NEW): the ledger SQL and read/write helpers (pattern of `python-runtime-records.ts`).
- `src/ingest/node-runtime.ts`: `run()` walks the ledger; `NODE_DEFAULTS` gets 3 knobs; remove `NODE_CURSOR_KEY`, `NODE_PARSER_KEY`.
- `src/ingest/ledgers.ts`: add `"node-runtime": "node_runtime_posts"`.
- `docs/RETENTION.md`: new `## node_runtime_posts` section; mark the two node cursor KV keys as no longer written.
- `docs/API.md`: the `/v1/status` ledger text names node-runtime too (only if it names python-runtime alone; check during build).
- `tests/fixtures/node-runtime/2019-09-12-no-updates.html` (NEW, recorded `<main>` slice of https://nodejs.org/en/blog/vulnerability/september-2019-openssl-no-updates; this box answered HTTP 200 for it at plan time).
- `tests/fixtures/node-runtime/README.tcs-69.md` (NEW, provenance: URL, recorded-at, sha256 of recording and slice, slice rule).
- `tests/ingest/node-ledger-seed.tcs-69.ts` (NEW test helper): `markNodePostsRead(beforeIso)` writes `ok` rows (parser_rev = NODE_PARSER_REV) for every Security Release post of the recorded feed published before `beforeIso`; `nodePostState(url)`; `clearNodeLedger()`.
- `tests/ingest/node-runtime-ledger-repro.tcs-69.test.ts` (NEW, the repro; imports only modules that exist on main).
- `tests/ingest/node-runtime-ledger.tcs-69.test.ts` (NEW, acceptance).
- `tests/launch/launch-node-ledger.tcs-69.test.ts` (NEW, launch project).
- Existing tests listed under "Tests that must change" below.

## Tests that must change

- `tests/ingest/node-runtime.tcs-6.test.ts`: the KV cursor is gone. `CURSORS.put(NODE_CURSOR_KEY, X)` becomes `markNodePostsRead(X)`; cursor asserts become row-state asserts (`ok` where it was PUB, not `ok` where it was START). N6 "a cursor after the post skips it" becomes "an `ok` row of a post that is not the newest `ok` row is not read". N4b "with no cursor, the backfill window picks the post" keeps its window premise with an empty ledger.
- `tests/ingest/node-runtime.tcs-30.test.ts`: cursor and parser-key premises. The pre-announcement run now writes a `pending` row, its summary text changes, and the release post is read at NOW + 61 min (after `pending_recheck_minutes`), not +10 min. The two "parser revision" cases become: a row with `parser_rev` "2" is read again once.
- `tests/ingest/node-runtime-repro.tcs-30.test.ts`: beforeEach sets the cursor and parser key; becomes `markNodePostsRead("2026-10-01T00:00:00Z")`.
- `tests/ingest/node-history.tcs-32.test.ts`: beforeEach clears the ledger instead of the cursor keys; the "parser revision 2" case becomes a `parser_rev` row case; cursor asserts in the incomplete/404 cases become row-state asserts (`failed`, next_check_at NULL). The 3-run counts (20, 20, 10, then 1) stay the same.
- `tests/cron/runtime-ingest.tcs-6.test.ts`: beforeEach cursor and parser key become `markNodePostsRead(START)`; C1's node cursor assert becomes `nodePostState(OCT) === "ok"`.
- `tests/worker/migrations.tcs-1.test.ts`: the exact migration-name list gains `0020_node_runtime_posts.sql`.
- `tests/routes/status-ledger.tcs-50.test.ts`: `NO_LEDGER` lists `node-runtime`; node-runtime now has a ledger.

No assertion is loosened. Each changed case keeps its claim and swaps the cursor premise for the ledger premise.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at plan time. Open PRs #67, #68, #70 also edit `tests/worker/migrations.tcs-1.test.ts` (an exact list every migration PR edits; unavoidable, rebase conflict only). #68 and #70 edit `docs/RETENTION.md` and `docs/API.md` (different sections). #67 edits `tests/routes/status-ledger.tcs-50.test.ts`.

## Tasks

### T1. Migration 0020
```sql
-- TCS-69: the node-runtime post ledger. Additive only. Retention: docs/RETENTION.md.
CREATE TABLE IF NOT EXISTS node_runtime_posts (
  url TEXT PRIMARY KEY,
  published TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok','empty','pending','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  parser_rev TEXT NOT NULL,
  next_check_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_runtime_posts_state_next ON node_runtime_posts (state, next_check_at);
UPDATE sources SET config_json = json_set(config_json, '$.pending_recheck_minutes', 60, '$.pending_old_recheck_minutes', 10080, '$.max_attempts', 10)
WHERE id = 'node-runtime' AND json_extract(config_json, '$.pending_recheck_minutes') IS NULL;
```
VALIDATE: `npm run migrate:local` exits 0, then `npx vitest run --project api tests/worker/migrations.tcs-1.test.ts tests/ingest/node-runtime-ledger.tcs-69.test.ts -t "migration"` passes (table, index and the 3 seeded knobs exist; an edited `pending_recheck_minutes` is not overwritten).
SATISFIES: Scope 1 "a node_runtime_posts table with url primary key, state ok/empty/pending/failed, attempts, next_check_at, index on (state, next_check_at)".

### T2. Ledger module `src/ingest/node-runtime-posts.ts`
`POST_SQL.known`: `SELECT url, published, state, parser_rev FROM node_runtime_posts WHERE url IN (SELECT value FROM json_each(?))` (PK seeks).
`POST_SQL.due`: `SELECT url, published, state, attempts FROM node_runtime_posts WHERE state = ? AND next_check_at <= ? ORDER BY next_check_at LIMIT ?` (idx_node_runtime_posts_state_next).
`POST_SQL.retrying`: `SELECT 1 FROM node_runtime_posts WHERE state = 'failed' AND next_check_at IS NOT NULL LIMIT 1`.
`POST_SQL.write`: `INSERT … ON CONFLICT(url) DO UPDATE` (idempotent on url).
`readLedger(db, links, now, limit)` runs known + due(pending) + due(failed) in ONE `db.batch` (1 round trip, 3 statements). `last_error` cut to 500 chars.
VALIDATE: `npx vitest run --project api tests/ingest/node-runtime-ledger.tcs-69.test.ts -t "EXPLAIN"` passes: the plan of `POST_SQL.due` names `idx_node_runtime_posts_state_next` and has no `SCAN node_runtime_posts`; `POST_SQL.known` uses the primary key.
SATISFIES: Acceptance "EXPLAIN QUERY PLAN without ANALYZE for the due read".

### T3. `run()` walks the ledger
Replace lines 199-208 and 213-298 of `src/ingest/node-runtime.ts`: build the due list by rules 1-4 above, sort by `published` ascending, cap `max_posts`, read each, write one row per read with the outcome table above. Remove the KV cursor and parser-key reads and writes. Add `pending_recheck_minutes: 60`, `pending_old_recheck_minutes: 10080`, `max_attempts: 10` to `NODE_DEFAULTS`, each with a comment that names the `sources.config_json` row seeded by migration 0020. `normalizeNodePost` and `parseNodeSecurityPost` do not change.
Coverage (`markCoverage`) is set when: `coverage_since` is NULL, every in-window feed post has a row after this run, the window reaches the oldest feed post (as today), and `POST_SQL.retrying` finds no row.
VALIDATE: `npx vitest run --project api tests/ingest/node-runtime-ledger.tcs-69.test.ts tests/ingest/node-history.tcs-32.test.ts tests/ingest/node-runtime.tcs-6.test.ts tests/ingest/node-runtime.tcs-30.test.ts` passes.
SATISFIES: Scope 4 "The history walk (20 posts per run) continues from the ledger, not from a cursor, so an out-of-order or re-published post is handled."

### T4. Empty outcome is terminal, its note is a warning
In `run()`: a post that is not a pre-announcement and has `cves.length === 0 && unparsed.length === 0` and is older than `retry_incomplete_days` gets state `empty`. The run pushes one line to `result.warnings` (`<label>: no CVE headings, older than <n> days, not read again`) and pushes no error.
VALIDATE: `npx vitest run --project api tests/ingest/node-runtime-ledger-repro.tcs-69.test.ts tests/ingest/node-runtime-ledger.tcs-69.test.ts -t "no updates"` passes: row `empty`, `sources.last_warning` contains `september-2019-openssl-no-updates`, `last_error` NULL, and a second run makes 0 fetches of that URL.
SATISFIES: Scope 1 "never a record error" and Scope 2 "The one-time note when a post becomes terminal goes to warnings (sources.last_warning), not to errors."

### T5. Pre-announcement is pending, read on next_check_at
In `run()`: a pre-announcement writes `pending` with next_check_at from the knob that fits its age, adds no error, and the run goes on to the next post.
VALIDATE: `npx vitest run --project api tests/ingest/node-runtime-ledger.tcs-69.test.ts -t "pre-announcement"` passes: the post is fetched once at T, 0 times at T+59 min, once at T+61 min; the source row is ok.
SATISFIES: Scope 1 "A pre-announcement post stays pending and is re-read on its next_check_at (not every run), with no error."

### T6. Status ledger counts
Add `"node-runtime": "node_runtime_posts"` to `LEDGER_TABLES` in `src/ingest/ledgers.ts`.
VALIDATE: `npx vitest run --project api tests/ingest/node-runtime-ledger.tcs-69.test.ts -t "status"` passes: `GET /v1/status` (through `SELF.fetch`) gives node-runtime `ledger` = `{ok, empty, pending, failed_retrying, failed_terminal}` that matches the seeded rows; `npx vitest run --project api tests/routes/status-ledger.tcs-50.test.ts` passes.
SATISFIES: Scope 3 "/v1/status shows the ledger counts for node-runtime like python-runtime."

### T7. Launch check against a seeded local worker
`tests/launch/launch-node-ledger.tcs-69.test.ts`: start `startLocalWorker()` (unchanged helper). Insert an `empty` row for `september-2019-openssl-no-updates` and a `pending` row (next_check_at 1 day ahead) for one older feed post, both with their feed `published` and the current parser_rev. Run `worker.scheduled` again and wait for `last_run_at` of node-runtime to move. Run `scripts/launch-check.sh`. Assert `ok status`, exit 0, `unknownUrls` = [] (a re-read of either row would hit the 599 fake and fail the source), and `/v1/status` node-runtime ledger has `empty: 1, pending: 1`.
VALIDATE: `npx vitest run --project launch tests/launch/launch-node-ledger.tcs-69.test.ts` passes.
SATISFIES: Acceptance "scripts/launch-check.sh status check passes against a seeded local worker in that state (launch project)."

### T8. Fixture and docs
Record the 2019 post `<main>` slice with the same rule as the other node fixtures; provenance in `README.tcs-69.md`. Add the `node_runtime_posts` section to `docs/RETENTION.md`. Update the `cursor:node-runtime` / `cursor:node-runtime:parser` lines: no longer written since TCS-69; the old values stay in KV and are not read.
VALIDATE: `sha256sum tests/fixtures/node-runtime/2019-09-12-no-updates.html` matches the README line; `grep -c "node_runtime_posts" docs/RETENTION.md` ≥ 1.
SATISFIES: Scope 1 "retention line" and acceptance "the recorded 2019 'no updates' post".

### T9. Update the cursor-premise tests
Edit the tests listed in "Tests that must change", with the helper `tests/ingest/node-ledger-seed.tcs-69.ts`.
VALIDATE: `npm test` exits 0 and `npm run typecheck` exits 0.
SATISFIES: Scope 4 (the walk has no cursor, so the tests that set one must use the ledger).

## Verify (run, not edited)
- `npm test`, `npm run typecheck`, `npm run migrate:local`.
- `tests/launch/launch-check.tcs-14.test.ts` and `tests/launch/launch-coverage.tcs-32.test.ts` (regression: the local worker seed must still mark node-runtime ok; the cursor line in `local-worker.tcs-14.ts` becomes inert and is left alone).
- `tests/cron/warnings.tcs-50.test.ts`, `tests/cron/run.tcs-2.test.ts` (registry and warnings channel).

## Edge cases
- A post that leaves the feed with a due `pending`/`failed` row: the due read still returns it; it is fetched by its stored URL (origin check still applies) with its stored `published`.
- A re-published post (same URL, new pubDate): rule 2 reads it once; the row's `published` is updated.
- Feed with 0 Security Release posts in the window: no ledger read, return as today.
- Due list empty but the newest `ok` row exists: 1 read (today's behavior).
- `max_posts` cap: due posts past the cap wait for the next run (the walk resumes from the rows, no cursor).
- Off-origin newest link: its row is `failed` terminal, so rule 4 (newest `ok`) never picks it, and it is not reported again.
- Knob out of range (`pending_recheck_minutes < 1`, `max_attempts < 1`): `readRuntimeConfig` path throws a config error before any fetch (follow `PY` `readConfig`).

## ASSUMPTIONS
- "Historical post" means older than the existing knob `retry_incomplete_days` (365). Other reading: every post with no CVE heading and no marker is `empty`. I chose the age gate because a new post with no CVE heading is more likely a parser gap that a person must see.
- Scope 2 ("terminal note goes to warnings") is applied to the new `empty` and the new `max_attempts` terminal. The old-incomplete, old-404 and off-origin cases keep reporting an error once, as today (tcs-32 tests pin that). Other reading: those notes move to warnings too, which changes those tests.
- A pre-announcement older than `retry_incomplete_days` stays `pending` but is read weekly (`pending_old_recheck_minutes` 10080), so old pre-announcements in the feed do not cost 24 reads a day forever. Other reading: one recheck interval for all ages.
- The newest `ok` post is read on every run, as the cursor did, because Node edits a release post in place. Other reading: `ok` is fully terminal, which would change the run counts in tcs-6, tcs-30 and tcs-32.
- A recent incomplete post still stops the run and is read again next run (as today). Other reading: the walk goes on past it.
- The ledger stores `parser_rev`, and a row with another revision is read once. This replaces the KV parser key, so a parser fix still re-reads old posts.
- On deploy the ledger is empty, so prod reads the whole window again (48 posts, 3 runs of 20, nodejs.org is not metered; every upsert is `unchanged`). No cursor import.
- Retention follows `python_runtime_records`: kept forever, no delete job. The feed bounds the table (77 items, about 12 new security posts a year).

## Changed symbols
- function `run` (src/ingest/node-runtime.ts, the `nodeRuntime` ingester): KV cursor walk becomes ledger walk.
- function `readLedger`, `writePost` (new, src/ingest/node-runtime-posts.ts).
- format `node_runtime_posts` table (new, migration 0020).
- format `sources.config_json` row `node-runtime`: 3 new knobs.
- function `NODE_DEFAULTS` (const): 3 new keys.
- function `NODE_CURSOR_KEY`, `NODE_PARSER_KEY` (exports): removed. callers: tests only, changed in T9; `tests/launch/local-worker.tcs-14.ts` uses the literal key string; left alone: the put is inert.
- function `LEDGER_TABLES` (const): node-runtime entry.
- route `GET /v1/status`: node-runtime gains a `ledger` object. `GET /status` HTML gains the node ledger sub-row (same renderer).

## Design collisions
- `GET /v1/status` (PR #70 bd89acb3c823): combine — PR #70 only adds the `/v1/keys/confirm` and `/v1/keys/rotate` rows above the unchanged `/v1/status` row in the docs/API.md route table; this plan adds the node-runtime `ledger` object to `loadStatus` and, if needed, the ledger text, so the build keeps both docs edits. PR #70 takes migration 0019 and appends `0019_key_confirm.sql` to the list in tests/worker/migrations.tcs-1.test.ts; this plan's 0020 appends after it.
- `run` (PR #68 dca953f2a735): combine — PR #68 changes `run` in src/ingest/kev.ts (the KEV ingester sets `exploited_at`), a different function from the node-runtime `run` this plan rewrites; the two edits touch different files and do not interact. PR #68 takes migration 0018, so this plan's 0020 stays free.
- `GET /v1/status` (PR #68 dca953f2a735): combine — PR #68 edits only the webhook delivery paragraph of docs/API.md and does not touch the `/v1/status` route, `loadStatus` or its batch; the ledger counts this plan adds go in unchanged.

## Iron laws applied
- Indexes: `idx_node_runtime_posts_state_next` serves the due read and `retrying`; PK serves `known`, `write`; the grouped status count is covered by the same index. EXPLAIN test in T2.
- No per-row correlated subquery: `known` is one `json_each` PK read.
- Retention: section in docs/RETENTION.md (bounded table, no delete job, same as python ledger).
- DB-driven knobs: 3 new knobs in `sources.config_json` (migration 0020 seed) with code fallbacks in `NODE_DEFAULTS` that name the row. No new literal limit.
- Additive-only schema (repo rule 1). RLS: n/a (D1, not Supabase).
- Idempotent ingest (repo rule 3): upserts unchanged; ledger write is `ON CONFLICT(url)`.
- Dedup before spend: nodejs.org is not metered. The ledger still prevents re-reads of terminal posts.
- No LLM, no model id, no UI table, no De-AI surface. Sortable headers, list-over-cards, drill-down: n/a (no UI change beyond the existing status sub-row renderer).
- Scalable tests: every test uses the existing nodejs.org seam fake (`tests/ingest/runtime-fake.tcs-6.ts`) or the local-worker outbound fake; a global `fetch` spy throws on a real call. Each test clears the ledger in beforeEach.
- Build discipline that bites: D1/D63 (mutate: make `empty` push an error, drop the `next_check_at` check, re-read `empty` rows; each must turn a test red), D2 (through `runIngesters` and `worker.scheduled`), D4 (recorded 2019 post and recorded pre-announcement, not hand-written HTML, for the ticket cases), D9/D13 (status "ok" must be false when a recent post fails), D12 (cap leaves rows due, no silent loss), D42/D62 (no weakened test; TEST-CHANGE lines), D51/D65 (new per-ticket test files and helper), D69 (knobs).

## Performance
No screen. The ingest run makes 1 D1 batch for the ledger read (3 statements), 1 write per post read, and 1 `retrying` read only when coverage is not set. `/v1/status` adds 1 grouped statement inside its existing single `db.batch` (no extra round trip).

## System invariants
(a) Cross-run state: D1 table `node_runtime_posts`, natural key `url` (PK). It replaces the KV cursor and parser key. No config-JSON state.
(b) Side effects: the only external effect is a nodejs.org GET (no write). The row is written AFTER the post's advisories are upserted; a throw before the write leaves no row, so the post is read again (never "ok without advisories"). A terminal row is written in the same step as its warning/error push; a run that throws after the write loses only the report line, never the state.
(c) Negative list for the `empty` classifier (must NOT become `empty`): the recorded 2026-10-14 pre-announcement (marker present → pending); a post with an unrated CVE heading (`unparsed` non-empty → error, today's case); a post with a CVE heading but no release lines; a recent (< 365 days) post with no CVE heading (→ failed, error); the recorded October and July release posts. Tests assert each.
(d) Neighbors: `runIngesters` (registry.ts) marks ok when `errors` is empty and writes `warnings` to `last_warning`; no change there. `markCoverage` (coverage.ts) keeps its write-once rule. `loadStatus` single batch gains one statement. The cron lane (`src/cron/run.ts`) is unchanged; one run per tick, so no two runs write a row at the same time (and the write is an upsert). The node-eol source does not read this table.

## Failure modes
- Decision rule: two rules. (1) The `empty` classifier. Empty side: the recorded 2019 `september-2019-openssl-no-updates` post (no CVE heading, no marker, 4 years old; source: recorded fixture); a synthetic post 366 days old with no CVE heading and no marker (edge; source: assumed). Not-empty side: the recorded 2026-10-14 pre-announcement (marker present → `pending`); a post with an unrated CVE heading (`unparsed` non-empty → error); a post with a CVE heading but no release lines; a post 10 days old with no CVE heading (→ `failed`); a post 364 days old with no CVE heading (edge → `failed`); the recorded October and July release posts (→ `ok`). (2) The read selection. Read side: a feed post with no row; a row with another `published`; a row with `parser_rev` "2"; a `pending` row with `next_check_at` = now (edge, `<=`); a `failed` row with `next_check_at` in the past; the newest `ok` row. Not-read side: an `empty` row; an `ok` row that is not the newest; a `pending` row at T+59 min; a `failed` row with `next_check_at` NULL (terminal or at `max_attempts`); a due row past the `max_posts` cap (read next run). Test: ledger.tcs-69 "negative list", "no updates", "pre-announcement", "recent no CVE", "out of order", "re-published", "parser_rev" (table-driven, each case asserted).
- Exit paths: (a) CVEs emitted: advisories upserted, then `ok` row; no counter. (b) Terminal `empty` / `failed`: row written in the same step as its one warning or error; `attempts` unchanged for `empty`. (c) Recent no-heading post: `failed`, `attempts`+1, `next_check_at` now+60 min, NULL at `max_attempts` (the counter stops, never loops). (d) Recent incomplete post: `failed` row with `next_check_at` = now, then the run stops (as today). (e) Recent HTTP or D1 error: no row, the run throws, the post is read again next run, `runIngesters` marks the source failed (as today). (f) `max_posts` cap: the rest stay due, no row lost. (g) Knob out of range: config error before any fetch, no row written. No metered budget (nodejs.org is not metered). Test: ledger.tcs-69 "recent no CVE" (attempts reach the cap, then terminal), node-history.tcs-32 incomplete/404 cases (row `failed`, next_check_at NULL) and its 3-run counts (cap leaves rows due).
- Writer/reader round-trip: new format `node_runtime_posts` row. Writers: `writePost` (`POST_SQL.write`, upsert on `url`) in `run()`; test helper `markNodePostsRead`. Readers: `readLedger` (`POST_SQL.known`, `POST_SQL.due`), `POST_SQL.retrying` (coverage), `loadStatus` grouped count via `LEDGER_TABLES` (`/v1/status`, `/status`). `published` is stored as the feed's normalized ISO string and compared by string equality with the same normalization; `next_check_at` and now are both `toISOString()` text, compared lexicographically; `parser_rev` is the text `NODE_PARSER_REV`. Second new format: 3 knobs in `sources.config_json`; writer migration 0020, reader `readRuntimeConfig`. Test: ledger.tcs-69 "re-published" (write then known-read sees no change on the next run), "parser_rev", "pre-announcement" (+59 min not read, +61 min read), "status", "migration".
- Alert or freeze blast radius: no new alert, page or freeze. The new terminal note is a line in `sources.last_warning` of the node-runtime row only. Worst case on the first tick after deploy: the ledger is empty, the run reads at most `max_posts` (20) posts, so at most 20 warning lines in one column of one row, and 0 on later runs for the same posts. Test: ledger.tcs-69 "no updates" (one warning, then 0 fetches and no new warning on the next 2 runs).
- Defaults in prod: `pending_recheck_minutes` 60 (one recheck per hourly cron tick; a release follows its pre-announcement within days), `pending_old_recheck_minutes` 10080 (weekly; a pre-announcement older than 365 days is not expected to change), `max_attempts` 10 (about 10 hours of rechecks for a recent no-heading post before it goes terminal with a warning). Migration 0020 seeds them in prod only when absent; the `NODE_DEFAULTS` fallbacks are the same values. The feature is on in prod: no flag, no shadow mode. Test: ledger.tcs-69 "migration" (3 knobs seeded, an edited knob kept), "pre-announcement old" (now + 10080 min).
- Status evidence: the source says ok (`last_error` NULL, `last_ok_at` moves) only when `runIngesters` sees an empty `errors` list; `empty` and `pending` push no error only after their row is written; a recent `failed` post keeps its error, so status is not ok. Coverage is marked only when every in-window feed post has a row and `POST_SQL.retrying` finds none. The `/v1/status` ledger counts come from a grouped SELECT on the table, not a stored counter. Test: ledger.tcs-69 "runIngesters", "recent no CVE" (error, source not ok), "status"; repro.tcs-69 R1; launch-node-ledger.tcs-69 (launch-check `ok status`).

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| Historical no-CVE, no-marker post is terminal `empty`, never a record error | T4 | ledger.tcs-69 "no updates", repro.tcs-69 |
| `empty` post never read again (count calls) | T3, T4 | ledger.tcs-69 "no updates" second run: 0 calls |
| Table with url PK, state, attempts, next_check_at, index, retention line | T1, T8 | ledger.tcs-69 "migration", RETENTION.md grep |
| Pre-announcement `pending`, re-read only after next_check_at, no error, source ok | T5 | ledger.tcs-69 "pre-announcement" |
| Terminal note goes to warnings, not errors | T4 | ledger.tcs-69: `last_warning` set, `last_error` NULL |
| NEGATIVE: stop recording "no CVE headings" as an error for historical posts | T4 | repro.tcs-69 asserts `last_error` NULL |
| NEGATIVE: stop re-reading terminal posts every run | T3 | ledger.tcs-69 call counts |
| Through runIngesters, only empty+pending → `last_error` NULL, `last_ok_at` moves | T3-T5 | ledger.tcs-69 "runIngesters" |
| `/v1/status` ledger counts for node-runtime | T6 | ledger.tcs-69 "status", status-ledger.tcs-50 |
| Walk continues from the ledger, 20 per run, out-of-order and re-published handled | T3 | ledger.tcs-69 "out of order", "re-published", node-history.tcs-32 3-run counts |
| EXPLAIN QUERY PLAN for the due read | T2 | ledger.tcs-69 "EXPLAIN" |
| launch-check status passes on a seeded local worker in that state | T7 | launch-node-ledger.tcs-69 |
| Out of scope: PHP | none | php tests unchanged |

## Acceptance tests
`tests/ingest/node-runtime-ledger-repro.tcs-69.test.ts` (imports only modules on main):
- R1: recorded feed, 2019 no-updates post routed to the recorded fixture, other due posts synthetic (as in node-history.tcs-32), clock 2026-10-23T01:00Z; run through `runIngesters` until the walk passes 2019. Assert `sources.last_error` IS NULL for node-runtime and `last_ok_at` = run time. Fails on main with `no CVE headings`.

`tests/ingest/node-runtime-ledger.tcs-69.test.ts`:
- "migration": table, index, 3 knobs; an edited knob is kept.
- "no updates": the 2019 post becomes `empty`, `attempts` 0, `next_check_at` NULL, `last_warning` names it, no error; the next 2 runs fetch it 0 times (`fake.count(url) === 1` total).
- "pre-announcement": the recorded pre-announcement at an older feed URL → `pending`, no error, source ok; fetched 0 times at +59 min, 1 time at +61 min; when routed to a release post at +61 min, the row becomes `ok` and advisories are stored.
- "pre-announcement old": a pre-announcement older than 365 days gets next_check_at = now + 10080 min.
- "recent no CVE": a post 10 days old with no CVE heading → `failed`, error, next_check_at = now+60 min; after `max_attempts` reads → terminal, one warning.
- "runIngesters": a run whose only outcomes are `empty` and `pending` → `last_error` NULL, `last_ok_at` moves.
- "out of order": a feed post with a pubDate older than every `ok` row and no row is read once.
- "re-published": an `ok` row whose feed pubDate changed is read once, `published` updated.
- "parser_rev": an `ok` row with parser_rev "2" is read once.
- "negative list": items of System invariants (c) do not become `empty`.
- "EXPLAIN": `EXPLAIN QUERY PLAN` of `POST_SQL.due` uses `idx_node_runtime_posts_state_next`, no full scan; `POST_SQL.known` uses the PK; seeded 500 rows.
- "status": `SELF.fetch("/v1/status")` node-runtime `ledger` matches seeded rows.

`tests/launch/launch-node-ledger.tcs-69.test.ts`: T7.

## Reproduction
REPRO: npx vitest run --project api tests/ingest/node-runtime-ledger-repro.tcs-69.test.ts
OBSERVED: a node-runtime run that reads `september-2019-openssl-no-updates` stores `last_error` "… 1 record error(s): https://nodejs.org/en/blog/vulnerability/september-2019-openssl-no-updates: no CVE headings", and the source is marked failed; a pre-announcement post stops the walk (`break`) and is read on every run.
EXPECTED: the post is a terminal `empty` row with one warning; `last_error` NULL; `last_ok_at` moves; a pre-announcement is `pending` until its next_check_at.
ROOT CAUSE: src/ingest/node-runtime.ts:141 (a post with no CVE headings is always pushed to `errors`), with src/ingest/node-runtime.ts:253-257 (a pre-announcement breaks the run and has no persisted state), and the KV cursor walk at src/ingest/node-runtime.ts:200-218 (no per-post state, so no terminal outcome can exist).
BLAST RADIUS: `nodeRuntime` in `defaultRegistry` (src/ingest/registry.ts:21) → `runIngesters` → `src/cron/run.ts` scheduled cron; `freshnessOf` / `loadHome` (src/site/data.ts) home freshness line; `loadStatus` → `GET /v1/status` and `GET /status`; `scripts/launch-check.sh` status check. Tests: node-runtime.tcs-6, node-runtime.tcs-30, node-runtime-repro.tcs-30, node-history.tcs-32, cron/runtime-ingest.tcs-6, launch-check.tcs-14, launch-coverage.tcs-32, routes/status-ledger.tcs-50, worker/migrations.tcs-1.

## QA screens
- `GET /v1/status`: node-runtime has `last_error: null` and a `ledger` object.
- `GET /status` (HTML): node-runtime row shows the ledger sub-row.
- `GET /` home: freshness line says all sources ok (local worker).
No new screen. No browser flow beyond reading these pages.

```pr-body-requires
TEST-CHANGE: <- Tests that must change (7 files)
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Design collision check (BH-5791)

Checked 8 listed and 0 derived symbols against main 41c4549a09d1..41c4549a09d1 and 3 open PRs.
- `GET /v1/status` (function, listed): PR #70 bd89acb3c823, (text match). Resolution: combine.
- `run` (function, listed): PR #68 dca953f2a735, body or signature changed. Resolution: combine.
- `GET /v1/status` (function, listed): PR #68 dca953f2a735, (text match). Resolution: combine.

## Size
FILES: 4
LINES: 260
DIFF_KB: 75

KIND: bug
SIZE: L
