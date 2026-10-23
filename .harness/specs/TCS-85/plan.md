# Plan: TCS-85 — OSV cron: batch the stored-key read per page

Ticket #85. Blocker #38 is merged on main (d5b6d96, PR #79). The stack-wait comment
(IC_kwDOVS0v0s8AAAABe-5YDA) held the ticket until #38 merged; that condition is now true.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-23T20:23:22Z -- src/ingest/osv.ts`
shows only d5b6d96 (TCS-38), which added the per-record `keepStoredKeys` call this ticket fixes
(`src/ingest/osv.ts:418`). No open PR touches `src/ingest/osv.ts`.

CodeGraph: NOT AVAILABLE on this box. Callers found with grep:
- `keepStoredKeys` (`src/ingest/osv.ts:325`): called by the cron `run` (`src/ingest/osv.ts:418`)
  and by the import route (`src/routes/internal-import.ts:207`, already one call per request).
- `run` (`src/ingest/osv.ts:381`): reached only through `osv.run`, used by the cron runner and by
  the OSV ingest tests (`tests/ingest/osv*.test.ts`).

## Scope

In the OSV cron `run`, call `keepStoredKeys` once per page, not once per record. Same results,
same counts, same `errors` order, same cursor rule. One `BARE_KEY_SQL` read per page.

Out of scope: parallel `getVuln` fetches, the upsert statement count, the import route
(already batched), `keepStoredKeys` itself.

## Spec changes from comments
none (the only comment, IC_kwDOVS0v0s8AAAABe-5YDA by board-harness-board, is a stack-wait hold
on #38; it changes no scope, and #38 is merged).

## ASSUMPTIONS
- "One read per page" means one `BARE_KEY_SQL` statement per page that has at least one record
  that normalizes. A page where every record fails `normalizeOsv` makes 0 reads, because
  `keepStoredKeys` returns early on an empty list. Other reading: always one read per page. That
  would add a wasted read and change nothing a user sees.
- A `getVuln` error (HTTP or D1) on record k of a page now throws before ANY upsert of that page.
  Today the records before k are upserted first. In both cases the page's cursor is not written
  and the next run re-reads the whole page (ingestion is idempotent on `(source, source_id)`), so
  the stored end state after a retry is the same. Other reading: keep partial page writes. That
  needs the read per record again, which is the defect.
- The order of `result.errors` stays the record order of the page (normalize errors and
  upsert errors interleaved as today), because phase 2 walks the collected records in order.

## Design

`src/ingest/osv.ts` `run`, inside the page loop:
1. Phase 1, per row in page order: `getVuln`, `result.fetched += 1`, `normalizeOsv`. Push
   `{ id: row.id, vuln_id: vuln.id, norm }` to a page list. (Use `vuln.id` as the record id passed
   to `keepStoredKeys`, the same value as today.)
2. One call: `await keepStoredKeys(ctx.env.DB, okRecords)` where `okRecords` is the list of
   `{ id: vuln.id, docs: norm.docs }` for the ok entries. `keepStoredKeys` mutates `docs` in
   place, so phase 2 sees the rewritten `source_id`s.
3. Phase 2, per collected entry in page order: if not ok, push `${row.id}: ${norm.reason}`; else
   upsert each doc with the same try/catch as today.
4. `kv.put(CURSOR_KEY, ...)` after the page, unchanged.

Comment line at the call site: "One BARE_KEY_SQL read per page (TCS-85)." Update the comment above
`keepStoredKeys` only if it says "per record" (it says "One read per call", which stays true).

### Task 1 — batch keepStoredKeys per page in the OSV cron
Files: `src/ingest/osv.ts` (function `run` only).
VALIDATE: `npm test -- tests/ingest/osv-page-batch.tcs-85.test.ts` passes, and `npm test -- tests/ingest` passes (osv.tcs-2, osv-stable-key.tcs-38, osv-release-scope.tcs-38, osv-multi-package.tcs-46, osv-ecosystem-suffix.tcs-71, osv-multi-range-action.tcs-75 unchanged and green)
SATISFIES: "Batch the stored-key read per page in the cron (one IN (...) read via json_each, as the import route does); same results, fewer D1 round trips."

### Task 2 — statement-count test
Files: `tests/ingest/osv-page-batch.tcs-85.test.ts` (new).
Use a counting D1 wrapper in the test file (same shape as `countingDb` in
`tests/routes/watchlists-ip-limit.tcs-66.test.ts`: `prepare` records the SQL then delegates;
`batch` delegates). Pass `env: { ...env, DB: counting.db }` in the `IngestContext`. Use
`createOsvFake` from `tests/ingest/osv-fake.ts` (0 network calls; a `fetch` spy asserts 0 real
calls in `afterAll`). Each test makes its own records with a unique id tag (`-tcs85<tag>`) and
own CVE ids, and sets `cursor:osv` in `beforeEach`.
VALIDATE: `npm test -- tests/ingest/osv-page-batch.tcs-85.test.ts` passes on the branch and the first case fails on main (100 reads, expected 1)
SATISFIES: "A statement-count test asserts one read per page at page_size 100."

## Reproduction
REPRO: `npx vitest run tests/ingest/osv-page-batch.tcs-85.test.ts -t "one BARE_KEY_SQL read per page at page_size 100"` (the new Task 2 test, run against the merge base code)
OBSERVED: the cron prepares `BARE_KEY_SQL` 100 times for one page of 100 records (one per record).
EXPECTED: the cron prepares `BARE_KEY_SQL` 1 time per page (100 records, page_size 100: 1; 250 records, page_size 100: 3).
ROOT CAUSE: src/ingest/osv.ts:418 (`await keepStoredKeys(ctx.env.DB, [{ id: vuln.id, docs: norm.docs }])` inside the per-row loop of `run`)
BLAST RADIUS: `osv.run` only (cron runner `src/cron/run.ts` via the ingester registry, and `tests/ingest/osv*.test.ts`). `keepStoredKeys` and `BARE_KEY_SQL` are unchanged, so `src/routes/internal-import.ts:207` is not affected.

The ticket body already names the cause with a file and line (code evidence, not a prod
symptom); no prod repro is possible or needed for a statement count.

## Changed symbols
- function `run` (in `src/ingest/osv.ts`, exported as `osv.run`): the page loop reads stored keys once per page; no signature change, same `RunResult`. callers: left alone: signature and result are unchanged.

## Files to touch
- `src/ingest/osv.ts`
- `tests/ingest/osv-page-batch.tcs-85.test.ts` (new)

## Verify (run, not edited)
- `npm test` (all suites)
- `npm run typecheck`
- `tests/ingest/osv.tcs-2.test.ts`, `tests/ingest/osv-stable-key.tcs-38.test.ts` and the other `tests/ingest/osv-*.test.ts` suites (regression risk: cursor rule on a thrown page, stable bare key, release scope, multi-package)
- `tests/backfill/import.tcs-32.test.ts`, `tests/backfill/import-docs-cap.tcs-38.test.ts` (import route shares `keepStoredKeys`; must stay green, untouched)

## Tests that must change
None

## Sibling claims (not touched)
TCS-82 claims files under src/cron, src/queue, src/routes/watchlists.ts, src/env.ts, src/index.ts and docs. This plan touches none of them.

## Iron laws applied
- Additive schema / RLS / new tables / retention: n/a, no schema change, no new table.
- Indexes + EXPLAIN: `BARE_KEY_SQL` is unchanged and already has an EXPLAIN QUERY PLAN proof on 1000 seeded rows (`tests/ingest/osv-stable-key.tcs-38.test.ts:170`, primary-key seeks). The bound array grows from 1 id to up to page_size ids; `json_each` drives the join, so the plan stays seek-per-id. The new test runs EXPLAIN QUERY PLAN with a 100-id array and asserts no `SCAN advisory_sources` / `SCAN advisories`.
- No per-row correlated subquery: this change removes a per-record round trip; it adds none.
- DB-driven knobs: no new limit. `page_size` is already a DB config field of the `osv` source row (fallback in `DEFAULTS`). D1 bound-parameter limit: the ids go in ONE JSON string parameter, so page_size has no per-parameter cap.
- Idempotent ingestion on `(source, source_id)`: unchanged; the new test re-runs the cron and asserts `upserted: 0`.
- Dedup before spend / metered calls: n/a (OSV is free; the fetch count is unchanged).
- UI rules (sortable headers, list over cards, drill-down, mobile): n/a, no UI.
- De-AI / model ids: n/a, no LLM.
- Scalable tests: the OSV seam fake (`tests/ingest/osv-fake.ts`) serves every read; 0 network calls, asserted by a fetch spy. Own ids per test, no order dependence.

## Performance
Loader: the OSV cron page loop (no screen, no loading.tsx). Reads per page: `getVuln` x N (HTTP,
sequential, unchanged), `BARE_KEY_SQL` x 1 (was x N), then the upserts (unchanged). Expected D1
statement count change per page of 100: -99 statements. Index: primary keys of
`advisory_sources (source, source_id)` and `advisories (id)`.

```pr-body-requires
BEFORE/AFTER <- ticket: "A statement-count test asserts one read per page at page_size 100" (BARE_KEY_SQL reads per 100-record page: before 100, after 1)
```

## System invariants
None beyond the iron laws. SIZE S: one function's loop is split into two phases with one batched
read between them. Neighbor interaction argument: within one page every record id is distinct
(the `latest` map dedups ids), and a record's upsert writes `advisory_sources` keys that are its own
bare id or `<id>#<scope>/<component>` (contains `#`), so no upsert of record A in a page can create
or move the `(osv, B)` row that record B's read looks up. The import route already reads once
before any upsert of its batch; the cron now has the same order.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| Batch the stored-key read per page in the cron (one IN read via json_each) | T1 | osv-page-batch.tcs-85: 1 read per page at page_size 100; 3 reads for 250 records |
| Same results | T1 | osv-page-batch.tcs-85: stored rows equal per-record behavior (bare id kept on stored package, stable-key case across a page); existing osv*.test.ts green |
| Fewer D1 round trips | T1 | osv-page-batch.tcs-85 statement count |
| A statement-count test asserts one read per page at page_size 100 | T2 | osv-page-batch.tcs-85 case 1 |
| (negative) no per-record BARE_KEY_SQL read remains | T1 | case 1 asserts count == 1, not <= N |

## Acceptance tests
File: `tests/ingest/osv-page-batch.tcs-85.test.ts` (vitest, `@cloudflare/vitest-pool-workers`).
1. "one BARE_KEY_SQL read per page at page_size 100": 100 npm records (unique ids, unique CVEs),
   `page_size: 100`. Assert the counting DB saw `BARE_KEY_SQL` exactly 1 time, `fetched: 100`,
   `errors: []`. Fails on main (100).
2. "250 records at page_size 100 make 3 reads": assert `BARE_KEY_SQL` count is 3 and the cursor
   equals the newest `modified`.
3. "a page with one bad record still makes one read and keeps error order": records A (ok),
   B (no `modified` or no enabled package → normalize error), C (ok), page_size 3. Assert 1 read,
   `errors` equals `["<B id>: <reason>"]`, A and C stored.
4. "stored bare key holds across a batched page": seed record X stored under its npm package
   (run once with default ecosystems), then run a page of X' (Maven listed first, Maven enabled)
   plus 2 other records. Assert X's bare id still maps to the npm advisory and the Maven doc has
   the suffixed key (same outcome as `osv-stable-key.tcs-38`), and 1 read for the page.
5. "re-run is idempotent": run case 1's records again; assert `upserted: 0`, `unchanged: 100`.
6. "EXPLAIN on a 100-id array uses primary-key seeks": EXPLAIN QUERY PLAN `BARE_KEY_SQL` bound to
   100 ids over seeded rows; assert no row matches `/SCAN (advisory_sources|advisories)\b/`.
- afterAll: fetch spy called 0 times.

Regression risk: `tests/ingest/osv.tcs-2.test.ts` (cursor rules b, b2, b3 on thrown errors; fetch
counts stay equal because phase 1 still fetches in order and stops at the throw),
`tests/ingest/osv-stable-key.tcs-38.test.ts`, `tests/ingest/osv-release-scope.tcs-38.test.ts`,
`tests/ingest/osv-multi-package.tcs-46.test.ts`, `tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts`.

## QA screens
None. Backend cron only; no route or screen changes. No user-facing entry point.

## Entry points
no user-facing entry point

## Design collision check (BH-5791)

Checked 1 listed and 0 derived symbols against main d5b6d96ed9bc..d5b6d96ed9bc and 1 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 1
LINES: 30
DIFF_KB: 9

KIND: bug
SIZE: S
