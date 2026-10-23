# TCS-37 plan: watch a lockfile (upload once, get a webhook when a new advisory matches)

Ticket: Fortunian/tocsin#37. Blocked-by #8 (merged: b1beed8, 41c4549) and #11 (merged: f1b4f68, follow-ups b6daee0). Both blockers are on main, so the stack-wait comment (6357543079) no longer applies.

ALREADY ON MAIN? Checked `git log origin/main --since=2026-10-22T21:16:00Z` (5 commits: TCS-82, 85, 87, 38, 11) and searched for `watchlist_dependencies`, `max_watch_dependencies` and `/lockfile`. None of them exists on main. Nothing is done yet. No open PR covers TCS-37.

CODEGRAPH: not available on this box. The file set comes from grep and reads of the callers named below.
VERIFICATION MAP: absent in this repo. Routes were found by reading `src/app.ts` and `src/routes/`.

## Spec changes from comments

- 6357543079, board-harness-board: a stack-wait hold until #11 merges. #11 merged as f1b4f68. No scope change; the hold is void.

No other comment exists. The issue body is the spec.

## Scope

1. `POST /v1/watchlists/:id/lockfile` (API key). It takes the same bodies as `POST /v1/check` (multipart lockfiles, or JSON `dependencies` / `runtimes` / `os_packages`). It replaces the stored dependency set of the list in one transaction and answers the `/v1/check` result at once (one check).
2. Table `watchlist_dependencies`, indexed on `(ecosystem, name)` and on `watchlist_id`. Its rows are deleted with the watch list (the DELETE route and the monthly key retention).
3. Webhook delivery for lists with a dependency set: a new cron pass matches each new or changed advisory (by cursor) against the stored dependencies with the `/v1/check` matcher. It inserts one `deliveries` row per `(watchlist_id, advisory_id)` (the existing primary key, so exactly once) and sends the queue message. The webhook body is the advisory plus an `affected` array.
4. Plan limit `plans.max_watch_dependencies` (free: 2,000). Over the limit answers 413 with the limit in the body.
5. CLI: `npx tocsin watch --upload` uploads the lockfiles in cwd to the key's default watch list. `npx tocsin watch` also prints `watching N dependencies, last delivery at …`.

Out of scope (ticket): a UI; a GitHub App.

## Changed symbols

- route `POST /v1/watchlists/:id/lockfile`: new.
- route `GET /v1/watchlists/:id`: the answer adds `dependencies` (count) and `dependencies_uploaded_at`. callers: left alone: existing tests use toMatchObject, additive fields.
- route `DELETE /v1/watchlists/:id`: the batch also deletes the list's `watchlist_dependencies` rows.
- function `GET_WATCHLIST_SQL` (src/routes/watchlists.ts): selects `dependency_count`, `dependencies_at`.
- function `WEBHOOK_LISTS_SQL` (src/queue/enqueue.ts): adds `AND dependency_count = 0`, so the filter enqueue skips dependency lists. callers: left alone: `tests/routes/deliveries.tcs-11.test.ts:177` runs EXPLAIN on it and still sees idx_watchlists_delivery.
- function `LOAD_SQL` (src/queue/run.ts): also selects `d.affected_json`. callers: left alone: `tests/queue/dlq-invariant.tcs-82.test.ts` compares by identity with the imported constant.
- function `guardAndSend` / payload build (src/queue/run.ts): the POST body is `doc_json` unchanged when `affected_json` is NULL, else the advisory object plus `affected`.
- function `AUTH_SQL` / `PlanLimits` (src/middleware/auth.ts): reads `p.max_watch_dependencies` into `limits.max_watch_dependencies: number | null`. Auth does NOT fail closed on NULL (test plan rows insert 4 columns); the upload route fails closed instead.
- function `KEY_RETENTION_*` / `runKeyRetention` (src/cron/retention.ts): the batch first deletes the `watchlist_dependencies` rows of the lists it deletes.
- function `runCron` (src/cron/run.ts): calls `enqueueDependencyMatches` after `enqueueDeliveries`, in its own try/catch.
- function `affectedItem` (src/check/run.ts): new export, extracted from the loop in `runCheck` (builds one `AffectedItem` from a dependency, an advisory and a match result). `runCheck` calls it; output unchanged.
- function `readCheckBody` (src/routes/check.ts): new export that wraps the existing `fromMultipart` / `fromJson` dispatch (content type, 415, 400 BadRequest). `check.post` calls it; behavior unchanged.
- function `enqueueDependencyMatches` (src/queue/dependency-match.ts): new.
- function `filterAccepts` (src/watchlists/dependencies.ts): new, the JS form of `watchlistWhere`.
- verb `tocsin watch` (packages/cli): new flag `--upload`; a status line at start when `TOCSIN_API_KEY` is set.
- format webhook body: dependency lists get an `affected` array (additive). Other lists: byte-identical.
- format table `watchlist_dependencies`, table `match_cursors`, columns `watchlists.dependency_count|dependencies_cursor|dependencies_at`, `deliveries.affected_json`, `plans.max_watch_dependencies`: new (migration 0028).

## Design collisions

- `runCron` (src/cron/run.ts): combine. Open PR #86 (TCS-83) adds a send-counters retention lane to `runCron`. This plan adds one try/catch call on the ingest path. The two edits are separate lines; a rebase keeps both.
- docs/RETENTION.md: combine. PR #86 adds a `send_counters` section; this plan adds `watchlist_dependencies` and `match_cursors` sections and two settings names. Separate sections.

## Files to touch

Product code:
1. `migrations/0028_watchlist_dependencies.sql` (new)
2. `src/routes/watchlists.ts`
3. `src/routes/check.ts`
4. `src/check/run.ts`
5. `src/middleware/auth.ts`
6. `src/watchlists/dependencies.ts` (new: SQL constants, row builder, `filterAccepts`)
7. `src/queue/dependency-match.ts` (new)
8. `src/queue/enqueue.ts`
9. `src/queue/run.ts`
10. `src/cron/run.ts`
11. `src/cron/retention.ts`
12. `packages/cli/src/api.ts`
13. `packages/cli/src/watch-list.ts` (new: default list lookup, upload, status line)
14. `packages/cli/src/feed.ts`
15. `packages/cli/src/cli.ts`

Tests (new, per ticket):
16. `tests/watch/lockfile.tcs-37.test.ts`
17. `tests/watch/lockfile-plan.tcs-37.test.ts`
18. `tests/watch/dependency-match.tcs-37.test.ts`
19. `tests/watch/helpers.tcs-37.ts`
20. `tests/cli/watch-upload.tcs-37.test.ts`

Docs:
21. `docs/API.md`
22. `docs/RETENTION.md`
23. `packages/cli/README.md`

## Tests that must change

None. (Checked: `tests/routes/watchlists-plan.tcs-8.test.ts:95` selects 4 named plan columns; `tests/queue/health.tcs-11.test.ts` uses toMatchObject on GET /:id; `tests/routes/deliveries.tcs-11.test.ts:177` EXPLAINs `WEBHOOK_LISTS_SQL` and the index stays the same.)

## Verify (run, not edited)

- `npm test`, `npm run typecheck`, `npm run migrate:local`
- `npm --prefix packages/cli run build`
- Regression-risk suites: `tests/routes/check.tcs-9.test.ts`, `tests/routes/check-plan.tcs-9.test.ts`, `tests/routes/check-plan.tcs-38.test.ts` (readCheckBody extraction, affectedItem extraction); `tests/queue/*.tcs-11.test.ts`, `tests/queue/*.tcs-82.test.ts` (LOAD_SQL, payload, WEBHOOK_LISTS_SQL); `tests/routes/watchlists*.tcs-8.test.ts`, `tests/routes/watchlists-ip-limit.tcs-66.test.ts`, `tests/routes/deliveries.tcs-11.test.ts` (route edits, auth); `tests/cron/retention.tcs-8.test.ts`, `tests/cron/run.tcs-2.test.ts` (retention batch, cron wiring); `tests/cli/*.tcs-13.test.ts` (watch verb); `tests/worker/migrations.tcs-1.test.ts`.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at plan time. No live sibling build.

## Design

### Migration 0028 (additive only)

```sql
CREATE TABLE IF NOT EXISTS watchlist_dependencies (
  watchlist_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,      -- lookup ecosystem: baseEcosystem(dep.ecosystem) (Debian:12 -> Debian)
  name TEXT NOT NULL,           -- lookup name: lookupName() (PEP 503 for PyPI/python), as /v1/check groups
  dep_ecosystem TEXT NOT NULL,  -- as parsed (Debian:12), the matcher input
  dep_name TEXT NOT NULL,
  version TEXT NOT NULL
);
-- Replace, count and delete by list: WHERE watchlist_id = ?. Also the natural key (no duplicate row).
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_dependencies_watchlist ON watchlist_dependencies (watchlist_id, dep_ecosystem, dep_name, version);
-- Match read: WHERE (ecosystem, name) IN (json_each(?)).
CREATE INDEX IF NOT EXISTS idx_watchlist_dependencies_ecosystem_name ON watchlist_dependencies (ecosystem, name);

-- One row per match lane: the advisory cursor the dependency match pass has done.
CREATE TABLE IF NOT EXISTS match_cursors (lane TEXT PRIMARY KEY, cursor INTEGER NOT NULL, updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO match_cursors (lane, cursor, updated_at)
  SELECT 'dependencies', COALESCE(MAX(cursor), 0), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM advisories;

ALTER TABLE watchlists ADD COLUMN dependency_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlists ADD COLUMN dependencies_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlists ADD COLUMN dependencies_at TEXT;
ALTER TABLE deliveries ADD COLUMN affected_json TEXT;
ALTER TABLE plans ADD COLUMN max_watch_dependencies INTEGER;
UPDATE plans SET max_watch_dependencies = 2000 WHERE id = 'free' AND max_watch_dependencies IS NULL;

INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.dependency_scan_rows', '2000');
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.dependency_insert_chunk', '500');
```

No DROP, no rename. D1 is not Supabase, so the RLS rule does not apply. `match_cursors` holds one row per lane and does not grow.

### Upload route (src/routes/watchlists.ts)

Order of work, each step before any write:
1. Middleware as today: `requireApiKey`, `keyRateLimit`. Body cap: `check.max_body_bytes` (the same bodies as `/v1/check`; fallback `FALLBACK_MAX_BODY_BYTES` imported from routes/check.ts).
2. Ownership read: `SELECT 1 FROM watchlists WHERE id = ? AND key_id = ?`. Missing: 404. Another key's list: 404 (wrong-tenant test).
3. `readCheckBody(c)`: 415 / 400 exactly as `/v1/check`.
4. Keep only dependencies with `supportsEcosystem()`; the rest go to `skipped` as `/v1/check` does. Zero supported dependencies: 400 `{"error": "no dependencies to watch"}` and no write (D11: empty input never replaces a set).
5. `limits.max_watch_dependencies === null`: log one error line, answer 500 (fail closed, as auth does for a missing plan row). Count over the limit: 413 `{"error": "dependency limit reached", "max_watch_dependencies": N, "dependencies": count}`.
6. `runCheck(db, deps, skipped)`: one D1 batch. Its `feed_cursor` becomes `dependencies_cursor`.
7. One `DB.batch` (one transaction), every statement guarded by `id = ? AND key_id = ?`:
   - `DELETE FROM watchlist_dependencies WHERE watchlist_id IN (SELECT id FROM watchlists WHERE id = ?1 AND key_id = ?2)`
   - `INSERT INTO watchlist_dependencies (...) SELECT ?1, json_extract(value,'$[0]'), ... FROM json_each(?3) WHERE EXISTS (SELECT 1 FROM watchlists WHERE id = ?1 AND key_id = ?2)`, chunked at `webhooks.dependency_insert_chunk` rows per statement (D1 allows 100 bound parameters; one JSON parameter per chunk).
   - `UPDATE watchlists SET dependency_count = ?, dependencies_cursor = ?, dependencies_at = ? WHERE id = ? AND key_id = ?`
   - `UPDATE match_cursors SET cursor = MIN(cursor, ?feed_cursor) WHERE lane = 'dependencies'` (the rewind, see System invariants (a)).
   If the UPDATE changes 0 rows (the list was deleted after step 2): 404.
8. Answer 200: the `/v1/check` result plus `watchlist_id`, `dependencies` (stored count).

Reads: ownership read and the body cap setting are independent; the cap runs in middleware before the handler as `capBody` does today, so they stay sequential (the same shape as POST /v1/watchlists). Expected D1 round trips: auth (2 statements in parallel), body cap setting 1, ownership 1, runCheck batch 1, write batch 1. Total 5 round trips. Indexes: PK on watchlists; idx_watchlist_dependencies_watchlist for the DELETE; runCheck indexes as in TCS-9.

### Dependency match pass (src/queue/dependency-match.ts)

`enqueueDependencyMatches(env, now)`, called by `runCron` after `enqueueDeliveries` and before `sweepDeliveries`, in its own try/catch.
1. Parallel: knobs `webhooks.dependency_scan_rows`, `webhooks.max_event_age_days`, and `SELECT cursor FROM match_cursors WHERE lane = 'dependencies'` (missing row: log an error, use 0; the per-list lower bound keeps that correct, only slower).
2. Window: `SELECT id, cursor, ecosystem, component FROM advisories WHERE cursor > ?g0 ORDER BY cursor LIMIT ?scan` (idx_advisories_cursor; no doc_json). Empty: return.
3. Keys per advisory: `[ecosystem, lookupName(ecosystem, component)]`, plus `["go","go"]` when `isGoToolchainAdvisory`. Distinct keys, chunks of `CHUNK_SIZE` (200), one batch:
   `SELECT d.watchlist_id, d.ecosystem, d.name, d.dep_ecosystem, d.dep_name, d.version, w.filter_json, w.dependencies_cursor, w.dependencies_at FROM watchlist_dependencies d JOIN watchlists w ON w.id = d.watchlist_id WHERE (d.ecosystem, d.name) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?)) AND w.delivery = 'webhook'`
   Served by idx_watchlist_dependencies_ecosystem_name (EXPLAIN test at 10,000 rows), then the watchlists PK.
4. Keep (list, advisory) pairs with `advisory.cursor > w.dependencies_cursor`. Fetch doc_json only for advisories in a kept pair: `SELECT id, doc_json FROM advisories WHERE id IN (SELECT value FROM json_each(?))` (PK).
5. Per pair: for each stored dependency of that list under the advisory's key, `matchAdvisory(dep, a)` (and `goRuntimeView(a)` for a `go` runtime dependency), `affectedItem(...)` on a hit. Then `filterAccepts(filter, a)` on the stored row (min_severity, exploited_only, ecosystems, components; AND semantics, same as SQL). No affected item or filter rejects: no row. Aged (published_at and exploited_at both before `dependencies_at - max_event_age_days`, same COALESCE rule as enqueue): status `skipped`, no message. Else `pending`.
6. One batch: `INSERT OR IGNORE INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at, affected_json) SELECT ... FROM json_each(?) RETURNING watchlist_id, advisory_id, status` (chunked), then `UPDATE match_cursors SET cursor = ?g1, updated_at = ? WHERE lane = 'dependencies' AND cursor = ?g0` (compare-and-set; g1 = last cursor of the window).
7. After the commit: `DELIVERIES.sendBatch` in chunks of `QUEUE_SEND_BATCH_MAX` for the new `pending` rows only. A failed send leaves the row pending; `sweepDeliveries` resends it (unchanged).
8. One log line `{"lane":"depmatch", advisories, pairs, inserted, skipped, sent, send_errors, cas_lost}`.

Paused lists: rows are inserted `pending`; the claim, the sweep and enqueue already skip paused lists, so the rows wait and go out after a resume (same as filter lists).

### Webhook body (src/queue/run.ts)

`LOAD_SQL` adds `d.affected_json`. Payload = `t.affected_json === null ? t.doc_json : JSON.stringify({ ...JSON.parse(t.doc_json), affected: JSON.parse(t.affected_json) })`. The signature covers the bytes sent, as today.

### Filter enqueue (src/queue/enqueue.ts)

`WEBHOOK_LISTS_SQL` adds `AND dependency_count = 0`. Without it, a dependency list with an empty filter gets every advisory. The poll feed `GET /:id/events` is not changed.

### CLI (packages/cli)

- `api.ts`: `listWatchlists()`, `createWatchlist(name)`, `getWatchlist(id)`, `uploadLockfiles(id, files)` (multipart, field name = file name, as `checkLockfiles`).
- `watch-list.ts`: `findDefaultList(api)` = the key's list named exactly `default`; `runUpload(io)` creates it (poll delivery) when absent, reads `findLockfiles(io.cwd)`, uploads, prints `uploaded N dependencies to watch list default (<id>), M affected now` and the status line, exits 0. No `TOCSIN_API_KEY`: exit 2. No lockfile: exit 2. API failure: one stderr line, exit 3. `statusLine(api)` prints `watching N dependencies, last delivery at <ISO or never>` from `GET /v1/watchlists/<id>`; no default list: `watching 0 dependencies`.
- `feed.ts` `runWatch`: `--upload` calls `runUpload` and returns. Without it and with `TOCSIN_API_KEY`, prints the status line on stderr once at start, then polls as today. A failed status read prints one stderr line and polling continues.
- `cli.ts`: `watch` options add `upload: { type: "boolean" }`; USAGE adds the flag.

## Tasks

T1. Migration 0028 (tables, indexes, columns, plan limit, settings rows).
VALIDATE: `npm run migrate:local` exits 0, and `npx vitest run tests/watch/lockfile-plan.tcs-37.test.ts` passes (it reads `SELECT max_watch_dependencies FROM plans WHERE id='free'` = 2000 and the 2 settings rows).
SATISFIES: "table `watchlist_dependencies`, indexed on `(ecosystem, name)` and on `watchlist_id`"; "Limits are rows: `plans.max_watch_dependencies` (free: 2,000)".

T2. `readCheckBody` export in routes/check.ts and `affectedItem` export in check/run.ts (pure extraction, no behavior change).
VALIDATE: `npx vitest run tests/routes/check.tcs-9.test.ts tests/routes/check-plan.tcs-9.test.ts tests/routes/check-plan.tcs-38.test.ts` passes unchanged.
SATISFIES: "accepts the same bodies as `/v1/check`"; "the same matcher as `/v1/check`".

T3. Auth reads `max_watch_dependencies`; upload route `POST /v1/watchlists/:id/lockfile` with ownership, empty-set 400, 413 limit, one check, atomic replace, match-cursor rewind.
VALIDATE: `npx vitest run tests/watch/lockfile.tcs-37.test.ts -t "upload"` passes: 3 dependencies store 3 rows and the answer has 1 affected; a re-upload replaces the set; 2,001 dependencies on a plan of 2,000 answer 413 with `max_watch_dependencies: 2000` and store 0 rows; another key's list answers 404 and stores 0 rows.
SATISFIES: "stores the dependency set on the watch list ... and returns the current affected list at once (one check)"; "over the limit returns 413 with the limit in the body".

T4. DELETE route and monthly key retention delete `watchlist_dependencies` rows with the list; GET /:id answers `dependencies` and `dependencies_uploaded_at`.
VALIDATE: `npx vitest run tests/watch/lockfile.tcs-37.test.ts -t "retention"` passes: after DELETE /v1/watchlists/:id, `SELECT COUNT(*) FROM watchlist_dependencies WHERE watchlist_id = ?` = 0; after `runKeyRetention` on a stale key, the same count = 0.
SATISFIES: "retention: deleted with the watch list".

T5. `enqueueDependencyMatches` pass, `filterAccepts`, cron wiring, `WEBHOOK_LISTS_SQL` exclusion.
VALIDATE: `npx vitest run tests/watch/dependency-match.tcs-37.test.ts tests/watch/lockfile.tcs-37.test.ts -t "delivery"` passes: a new matching advisory gives exactly 1 deliveries row and 1 queue message; a second cron run gives 0; a re-upload without the dependency then a new advisory for it gives 0; an advisory on the same package outside the version range gives 0.
SATISFIES: "when a new or changed advisory matches a stored dependency and version ... the webhook fires ... exactly once per `(watchlist_id, advisory_id)`"; "A re-upload replaces the set and never re-sends past deliveries".

T6. Webhook body carries `affected` for dependency lists (run.ts payload).
VALIDATE: `npx vitest run tests/watch/dependency-match.tcs-37.test.ts -t "payload"` passes: the fake fetch body parses to the advisory `id` plus `affected[0].dependency` = the stored dependency and `affected[0].fixed_in`; a filter list's body is byte-equal to its `doc_json`.
SATISFIES: "the webhook fires with the affected item".

T7. CLI `watch --upload` and the `watch` status line.
VALIDATE: `npm --prefix packages/cli run build && npx vitest run --project cli tests/cli/watch-upload.tcs-37.test.ts` passes.
SATISFIES: "`npx tocsin watch --upload` reads the lockfiles in cwd and uploads them to the key's default watch list; `npx tocsin watch` then also prints \"watching N dependencies, last delivery at …\"".

T8. EXPLAIN proofs for every query on the new table and the new pass.
VALIDATE: `npx vitest run tests/watch/lockfile-plan.tcs-37.test.ts` passes: the match read uses `idx_watchlist_dependencies_ecosystem_name` with 10,000 seeded rows and has no `SCAN watchlist_dependencies`; the replace DELETE and the count use `idx_watchlist_dependencies_watchlist`; the window read uses `idx_advisories_cursor`; the doc fetch is a PK seek.
SATISFIES: "`EXPLAIN QUERY PLAN` for the match read uses the `(ecosystem, name)` index at 10,000 seeded rows"; CLAUDE.md rule 2.

T9. Docs: API.md (route, body, 413, webhook `affected`, CLI), RETENTION.md (two tables, new columns, two settings rows), packages/cli/README.md (`watch --upload`, status line).
VALIDATE: `grep -n "/lockfile" docs/API.md && grep -n "watchlist_dependencies" docs/RETENTION.md && grep -n "\-\-upload" packages/cli/README.md` each prints a line, and `npx vitest run --project docs` passes.
SATISFIES: CLAUDE.md "Every table ships with ... a retention rule" (documented); "CLI: `npx tocsin watch --upload` ..." (user-facing docs for the verb).

## Failure modes

This plan changes no path under `bin/`, `worker/` or `workers/`, so the section is not required. Two short lines for the reviewer:

- Decision rule (dependency match): see System invariants (c). Test: `tests/watch/dependency-match.tcs-37.test.ts`.
- Exit paths: n/a — no harness script.

## System invariants

(a) Cross-run state.
- Exactly-once: `deliveries` primary key `(watchlist_id, advisory_id)` with `INSERT OR IGNORE ... RETURNING`; only returned rows get a queue message. Two overlapping cron runs insert once and send once.
- Watermark: table `match_cursors`, natural key `lane`. Not KV: KV has no compare-and-set and is eventually consistent. The pass moves it with a compare-and-set (`AND cursor = ?g0`) in the same transaction as its inserts. The upload rewinds it with `MIN(cursor, feed_cursor)` in the upload transaction. This closes the race where a pass reads old dependencies, the upload commits, and the pass then moves past advisories newer than the upload's check: the rewind (or the failed CAS) makes the next pass read them again, and the PK stops any repeat.
- Per-list lower bound `watchlists.dependencies_cursor` = the upload check's `feed_cursor`: advisories at or below it were in the upload answer and are never sent. A lost or zero watermark is slow, never wrong.
- Not pruned against a capped query: the window cap only limits how far G moves per run; nothing is deleted.

(b) Side effects.
- Queue send: rows commit first, then `sendBatch`. Send failure: row stays `pending`, `send_errors` +1, sweep resends after `webhooks.sweep_grace_seconds`. `delivered` is written only by the consumer after a 2xx (unchanged). "Stamped done without delivery" stays impossible.
- Upload: the replace is one transaction; a failure writes nothing and answers 500. The check runs before the write; a check failure writes nothing.
- No metered vendor call in this ticket (no NVD, LLM or mail). Dedup-before-spend does not apply.

(c) Adversarial negatives for the matcher that gates a client-visible webhook. Each must produce NO deliveries row (tests in dependency-match.tcs-37):
1. Same package, version outside every affected range (lodash 4.17.21 vs `<4.17.20`).
2. Same name, other ecosystem (npm `requests` vs PyPI `requests` advisory).
3. Advisory at or below the list's `dependencies_cursor` (already in the upload answer).
4. Dependency removed by a re-upload, then a new advisory for it.
5. A poll list (delivery `poll`) with the same dependency.
6. A list whose filter has `min_severity: high` and a `medium` advisory.
7. A changed advisory (new cursor) whose pair already has a `delivered` row.
8. PyPI case: stored `django` matches an advisory on `Django` (positive); `django-foo` does not match `Django` (negative).
9. A filter-mode webhook list with an empty filter is unchanged by this ticket (still gets the filter enqueue); a dependency-mode list with an empty filter gets only matched advisories, not all.

(d) Neighbor interactions.
- `enqueueDeliveries`: dependency lists are excluded by `dependency_count = 0`, so the two lanes never write rows for the same list. A list that had filter deliveries before its first upload keeps them; the PK stops a repeat.
- `sweepDeliveries`, consumer claim, pause, DLQ: unchanged; they read `deliveries` rows whatever lane wrote them.
- Deliveries retention (daily): unchanged; `affected_json` rides on the row.
- Key retention (monthly): deletes dependency rows first in its batch (the subquery reads `watchlists`).
- Cron cadence: the pass runs on every ingest cron (`*/10`). Bounded by `webhooks.dependency_scan_rows` advisories per run; a backfill flood drains over runs.
- `GET /:id/events` (poll) moves `watchlists.cursor`; the pass never reads or writes that column.
- Open PR #86 edits `runCron`: separate line, see Design collisions.

## Requirements coverage

| Requirement (ticket) | Task | Test |
|---|---|---|
| `POST /v1/watchlists/<id>/lockfile` with API key | T3 | lockfile.tcs-37 "upload": no key 401; other key 404 (0 rows) |
| Same bodies as `/v1/check` (lockfile text or parsed deps) | T2, T3 | lockfile.tcs-37: multipart `package-lock.json` and JSON `dependencies` both store rows |
| Store on `watchlist_dependencies` | T1, T3 | lockfile.tcs-37: 3 deps -> 3 rows |
| Index on `(ecosystem, name)` and `watchlist_id` | T1, T8 | lockfile-plan.tcs-37 EXPLAIN |
| Retention: deleted with the watch list | T4 | lockfile.tcs-37 "retention" (route and monthly job) |
| Returns the current affected list at once (one check) | T3 | lockfile.tcs-37: answer `affected.length` = 1 |
| Webhook fires on new or changed matching advisory, same matcher | T5 | lockfile.tcs-37 "delivery"; dependency-match.tcs-37 changed-advisory case |
| With the affected item | T6 | dependency-match.tcs-37 "payload" |
| Exactly once per `(watchlist_id, advisory_id)` | T5 | re-run of the cron -> 0 new rows, 0 messages |
| NEGATIVE: re-upload never re-sends past deliveries | T5 | re-upload same set, cron -> 0 rows, 0 messages |
| NEGATIVE: removed dependency gets no delivery | T5 | re-upload without it, new advisory -> 0 rows |
| CLI `watch --upload` uploads cwd lockfiles to the default list | T7 | watch-upload.tcs-37 |
| CLI `watch` prints "watching N dependencies, last delivery at …" | T7 | watch-upload.tcs-37 |
| `plans.max_watch_dependencies` row, free 2,000 | T1 | lockfile-plan.tcs-37 row read |
| Over the limit 413 with the limit in the body | T3 | lockfile.tcs-37: 413, `max_watch_dependencies` in body, 0 rows |
| EXPLAIN for the match read at 10,000 rows | T8 | lockfile-plan.tcs-37 |
| NEGATIVE (out of scope): no UI, no GitHub App | none | no file under `site/` or `action/` in the diff |

## Acceptance tests

Framework: Vitest with `@cloudflare/vitest-pool-workers` (project `api`), and plain Node (project `cli`). Each test seeds its own rows with `uid()` ids and unique cursors (pattern of `tests/queue/helpers.tcs-11.ts`). The queue is `FakeQueue`; webhook POSTs and DoH go through the consumer's `deps.fetch` fake. 0 network calls.

`tests/watch/lockfile.tcs-37.test.ts` (through `SELF.fetch` / the real worker routes, D2):
- upload: a JSON body with 3 npm dependencies, one inside the range of a seeded advisory -> 200, `affected.length === 1`, `dependencies === 3`, 3 rows in `watchlist_dependencies` for the list.
- upload: the same 3 as a multipart `package-lock.json` -> 3 rows.
- upload: no `Authorization` -> 401; another key's list -> 404 and 0 rows; unknown list -> 404.
- upload: only unsupported-ecosystem deps -> 400 and the previous set is unchanged.
- upload: a plan row with `max_watch_dependencies = 2` and 3 deps -> 413, body `max_watch_dependencies: 2`, 0 rows.
- delivery: a webhook list uploads, then a new advisory in range is seeded above `dependencies_cursor`; `runCron` (ingest registry empty) -> exactly 1 `deliveries` row (status pending, `affected_json` set) and 1 message; a second `runCron` -> still 1 row, 0 new messages.
- delivery: re-upload with the dependency removed, then a new advisory for it, `runCron` -> 0 rows for that advisory.
- delivery: re-upload of the same set after a delivered row -> `runCron` sends 0.
- retention: DELETE route -> 0 dependency rows; `runKeyRetention` on a stale key -> 0 dependency rows.
- GET /:id answers `dependencies: 3` and `dependencies_uploaded_at`.

`tests/watch/dependency-match.tcs-37.test.ts`:
- The 9 negatives of System invariants (c), each asserting 0 rows (and the PyPI positive asserting 1).
- payload: `runQueue` with a recording fetch: body has advisory `id` and `affected[0]` with `dependency`, `fixed_in`, `action`; a filter list's body equals `doc_json` byte for byte.
- aged: an advisory published 400 days before `dependencies_at`, re-cursored -> `skipped` row, 0 messages.
- race: upload commits with `feed_cursor` below the stored `match_cursors.cursor` -> the row is rewound to `feed_cursor`; the next pass inserts the match. CAS: a pass whose `g0` no longer matches leaves `match_cursors` unchanged.
- `filterAccepts` parity: over 20 seeded advisories and 6 filters, the ids `filterAccepts` keeps equal the ids `watchlistWhere` SQL returns.
- `WEBHOOK_LISTS_SQL` returns a filter list and not a dependency list.

`tests/watch/lockfile-plan.tcs-37.test.ts`:
- Seeds 10,000 `watchlist_dependencies` rows (multi-row inserts) and runs `EXPLAIN QUERY PLAN` on the match read: `USING INDEX idx_watchlist_dependencies_ecosystem_name`, no `SCAN watchlist_dependencies`.
- The replace DELETE: `idx_watchlist_dependencies_watchlist`. The window read: `idx_advisories_cursor`. The doc fetch: PK. The `free` plan row = 2000. Both new settings rows exist.

`tests/cli/watch-upload.tcs-37.test.ts` (fake io of `helpers.tcs-13.ts`, temp dir with a `package-lock.json`):
- `watch --upload` with no default list: GET list, POST create `{name: "default"}`, POST `/v1/watchlists/<id>/lockfile` multipart with field `package-lock.json`; prints `watching 3 dependencies, last delivery at never`; exit 0.
- `watch --upload` without `TOCSIN_API_KEY` -> exit 2; with no lockfile -> exit 2; API 413 -> stderr names the limit, exit 3.
- `watch` with a key and `maxPolls: 1` -> stderr has `watching 3 dependencies, last delivery at 2026-10-01T00:00:00.000Z`, then the poll runs as before. Without a key: no status line, no watch-list call.

Mutation check (D1): remove the `dependency_count = 0` term, the `INSERT OR IGNORE`, the `dependencies_cursor` bound, or the `affected` merge; a named test above goes red for each.

## QA screens

No browser screen (ticket: "Out of scope: A UI"). API and CLI checks against `npm run dev`:
- `POST /v1/watchlists/<id>/lockfile` with a real `package-lock.json` -> 200 with `affected` and `dependencies`.
- `GET /v1/watchlists/<id>` -> `dependencies`, `dependencies_uploaded_at`.
- `TOCSIN_BASE_URL=http://localhost:8787 TOCSIN_API_KEY=... node packages/cli/bin/tocsin.js watch --upload` in a repo dir -> the status line.

## Entry points

- CLI `tocsin watch`: touched (`--upload`, status line). This is the existing entry point users reach the feature from; the CLI test drives it.
- Public API `/v1/watchlists/*`: touched (new sub-route of an existing resource; GET /:id shows the count).
- `/v1/check`: no change, because the upload reuses its body parser and matcher and leaves its answer unchanged.
- MCP server (`workers/mcp`): no change, because the ticket scopes the CLI only; an MCP tool for upload is a follow-up.
- Skill text (`skills/tocsin/SKILL.md`), `llms.txt`: no change, because the ticket does not ask for it; the CLI README and API.md carry the new verb.
- Site / UI: no change, because the ticket puts a UI out of scope.
- GitHub Action: no change, because "GitHub App that reads lockfiles from repos" is out of scope.

## ASSUMPTIONS

1. "The key's default watch list" does not exist today. Assumed: the key's list named exactly `default`; `watch --upload` creates it (delivery `poll`) when absent. The user sets webhook delivery with `PATCH`. Other reading: the oldest list of the key, or a server-side default flag; rejected because it could overwrite a list the user made for something else.
2. A list with a dependency set gets webhooks for dependency matches only; its stored filter still applies as an AND (min_severity, exploited_only, ecosystems, components). The filter enqueue skips it. Other reading: filter OR dependencies; rejected because an empty filter would then send every advisory.
3. The poll feed `GET /:id/events` is not dependency-matched. The ticket's item 2 names the webhook only. A poll list still gets the upload answer.
4. The webhook body for a dependency list is the advisory document plus an `affected` array (the `/v1/check` affected items for that list). Filter lists keep the byte-identical body.
5. Age rule anchor is the upload time (`dependencies_at`), with the same `webhooks.max_event_age_days` (30). Backfilled history re-cursored after an upload is `skipped`, as for filter lists.
6. An upload with zero supported dependencies is a 400 and never empties a set. Removing a set is out of scope (delete the list).
7. Rows already `pending` when a re-upload removes their dependency still send. The ticket says a re-upload never re-sends past deliveries; it does not ask to cancel queued ones.
8. The upload body cap is `check.max_body_bytes` (2 MB), not `watchlists.max_body_bytes` (1 MB), because the ticket says "the same bodies as `/v1/check`".
9. `watch --upload` exits after the upload (0 ok, 2 usage, 3 API failure); it does not start polling. The status line of `watch` goes to stderr, so stdout stays one line per event.
10. Unsupported-ecosystem dependencies are not stored and do not count against the limit; they come back in `skipped`.

## Design collision check (BH-5791)

Checked 17 listed and 0 derived symbols against main b6daee077db9..b6daee077db9 and 1 open PRs.
- `none`: no checked symbol changed after the base.

## Size

FILES: 15
LINES: 560
DIFF_KB: 75

KIND: feature
SIZE: L
