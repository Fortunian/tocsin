# TCS-91 plan: launch-check cov-count excludes skipped (withdrawn, MAL-) ids from the denominator

Ticket: Fortunian/tocsin#91. Blocked-by #38 is CLOSED. The thread has 0 comments; the body is the spec.
Already on main? No. `git log origin/main --since=2026-10-23T21:43:44Z -- scripts/launch-check.sh` is empty; main head is b6daee0.

## Spec changes from comments
none

## Scope

`cov-count` in `scripts/launch-check.sh` compares `imported` (imported + unchanged) from `/v1/status` coverage with every non-MAL- id in OSV `<eco>/modified_id.csv`. The importer (`scripts/backfill/osv-import.mjs:168-175`) skips MAL- ids AND withdrawn records and counts both in `backfill.skipped`. Withdrawn ids stay in the denominator, so Pub reads 12 of 14 on a correct import.

The fix:
1. `/v1/status` coverage rows carry `skipped` from the `backfill` row (number for an OSV ecosystem, null for a runtime). This keeps launch-check public and secret-free (see ASSUMPTIONS).
2. `cov-count` computes, per OSV ecosystem: `osv` = every id in the CSV (MAL- included, because MAL- are in `skipped`), `want = osv - skipped`, `have = imported`.
3. Rule: if `osv < COV_SMALL_IDS` (default 50), require `have >= want`. Else require `have * 100 >= want * COV_MIN_PCT` (90, unchanged).
4. Print both numbers per ecosystem: one info line `cov-count: <eco> <have> of <want> (<osv> OSV ids, <skipped> skipped, needs <all|90%>)`. The FAIL line keeps the existing `<eco> <have> of <want>` text.

No migration: `backfill.skipped` exists (migrations/0014_backfill.sql). No new table, no new statement.

## Files to touch
- `scripts/launch-check.sh` — cov-count formula, `COV_SMALL_IDS` knob (env, default 50, added to the preflight whole-number loop and the header env list), per-ecosystem info line, header comment for cov-count.
- `src/site/data.ts` — `STATUS_BACKFILL_SQL` selects `skipped`; the OSV coverage rows get `skipped` (0 when no backfill row, same as `imported`); runtime rows get `skipped: null`.
- `site/status.ts` — `CoverageRow` gets `skipped: number | null`. The HTML table is unchanged.
- `docs/BACKFILL.md` — line 88: `coverage[]` also has `skipped`; "After the backfill" section: one sentence on the cov-count formula and the small-ecosystem rule.
- `tests/routes/status-coverage.tcs-32.test.ts` — the `toEqual` row pins gain `skipped` (see Tests that must change).
- `tests/launch/launch-check.tcs-91.test.ts` — NEW, the acceptance tests.

## Verify (run, not edited)
- `npm test -- tests/launch/launch-coverage.tcs-32.test.ts` (regression: existing cov-count cases keep passing unchanged)
- `npm test -- tests/launch/launch-check.tcs-14.test.ts`
- `npm run typecheck`
- `npm test`

## Tests that must change
- `tests/routes/status-coverage.tcs-32.test.ts`: it pins the whole `/v1/status` coverage row with `toEqual`; this ticket adds the `skipped` field to that row. Only the 5 expected objects gain `skipped` (200012-row npm gets `skipped: 0`, runtime rows `skipped: null`); no assertion is removed or loosened.

## Tasks

### T1. `/v1/status` coverage rows carry `skipped`
Change `STATUS_BACKFILL_SQL` to `SELECT ecosystem, coverage_since, done_at, imported, unchanged, skipped FROM backfill`. Add `skipped` to the row type at `src/site/data.ts:159`. Map OSV rows to `{ ...c, imported, skipped: skippedBy.get(eco) ?? 0 }` and runtime rows to `skipped: null`. Add `skipped: number | null` to `CoverageRow` in `site/status.ts`. Update the 5 `toEqual` pins in `tests/routes/status-coverage.tcs-32.test.ts`.
VALIDATE: npm test -- tests/routes/status-coverage.tcs-32.test.ts tests/launch/launch-check.tcs-91.test.ts -t "status coverage skipped"
SATISFIES: "the `backfill` row via `GET /v1/internal/import?ecosystem=` or `/v1/status` coverage"

### T2. cov-count denominator excludes skipped ids
In the cov-count block, extract `ecosystem`, `imported`, `skipped` per row (`select(.imported != null)`). If `skipped` is not a number, add `"<eco> (no skipped count in /v1/status)"` to `short` (absent is not zero, D11). Count every non-empty id in column 2 of the CSV as `osv` (drop the `grep -v '^MAL-'`). `want = osv - skipped`. If `want` is below 0 (the CSV is older than the run), the comparison uses 0 and the info line prints the raw numbers.
VALIDATE: npm test -- tests/launch/launch-check.tcs-91.test.ts -t "Pub 12 of 12"
SATISFIES: "`cov-count` uses `(imported + unchanged) / (osv ids - backfill.skipped)` per ecosystem ... keeps the 90 percent threshold"

### T3. Small ecosystem rule, knob, and printed numbers
Add `COV_SMALL_IDS="${COV_SMALL_IDS:-50}"` with the other knobs and add it to the preflight whole-number loop. If `osv < COV_SMALL_IDS`, the ecosystem needs `have >= want`; else `have * 100 >= want * COV_MIN_PCT`. Print `cov-count: <eco> <have> of <want> (<osv> OSV ids, <skipped> skipped, needs all)` or `... needs <COV_MIN_PCT>%)` for every ecosystem, before the ok/FAIL line. FAIL text stays `under the threshold: <eco> <have> of <want>; ...` with the existing `<eco> <have> of <want>` substring. Update the header comment (cov-count lines and env list).
VALIDATE: npm test -- tests/launch/launch-check.tcs-91.test.ts
SATISFIES: "prints both numbers. For an ecosystem under 50 ids, require every non-skipped id instead of a percentage."

### T4. Docs
`docs/BACKFILL.md`: add `skipped` to the `/v1/status` coverage line, and one sentence on how cov-count counts (skipped ids out of the denominator; under `COV_SMALL_IDS` ids every non-skipped id).
VALIDATE: grep -n "skipped" docs/BACKFILL.md | grep -n "cov-count\|coverage"
SATISFIES: "prints both numbers" (operators read the formula behind the printed numbers)

## Edge cases
- MAL- ids: in the CSV and in `skipped`, so they cancel. The existing tcs-32 case (`npm 3 of 12`: 13 CSV ids, 1 MAL skipped) keeps its exact text.
- CSV newer than the run: new withdrawn/MAL ids are in `osv` but not in `skipped`. Large ecosystems absorb it in the 10% slack; a small one can FAIL until the backfill reruns. That is the honest result (the run did not see those ids).
- CSV older than the run (`have > want`, or `want <= 0`): passes.
- All ids skipped (`osv = skipped = 3`, `have = 0`): `0 of 0`, passes.
- Exactly `COV_SMALL_IDS` ids: percentage rule (rule is strictly "under").
- `skipped` missing (an older deploy of the worker): FAIL with a named reason, never read as 0.
- `COV_SMALL_IDS=abc`: preflight FAIL, exit 1.
- An ecosystem with no backfill row: `imported 0`, `skipped 0`, so it fails as before.

## Iron laws
- Sortable headers, list-over-cards, drill-down, 375px: no UI change (status HTML table unchanged).
- DB-driven config / hardcoded-knob: `COV_SMALL_IDS` is an env knob of an operator script with a documented default, the same mechanism as `COV_MIN_PCT` and `COV_DJANGO_MIN`. The script reads only public HTTP, so it has no DB access (see ASSUMPTIONS).
- Schema/RLS/indexes/retention: no migration, no new table. `STATUS_BACKFILL_SQL` gains one column; `backfill` has one row per enabled ecosystem (12 max), the read is unchanged in cost. Retention of `backfill` is documented in docs/RETENTION.md (no growth).
- Dedup-before-spend: no metered call. OSV CSV reads are public and free.
- De-AI: no LLM call site.
- Tenant: `/v1/status` is public and global; `skipped` is an aggregate count, no tenant data.

## Performance
`/v1/status` and `/status` loader: same batch, same statement count (STATUS_BACKFILL_SQL + OSV_CONFIG_SQL in the existing `db.batch`). Expected statements unchanged. No new index. No skeleton change (server-rendered, no loading state in this stack).

## Changed symbols
- route `GET /v1/status`: coverage rows gain `skipped` (additive).
- function `loadStatus`: OSV coverage rows carry `skipped`, runtime rows `skipped: null`. callers: left alone: `src/routes/site.ts` (/status HTML) and `src/site/data.ts` freshness ignore the new field.
- format `STATUS_BACKFILL_SQL`: selects `skipped`.
- format `CoverageRow` (site/status.ts): gains `skipped: number | null`.
- verb `launch-check cov-count`: new denominator, small-ecosystem rule, `COV_SMALL_IDS` knob, info line.

## Design collisions
- `launch-check` (scripts/launch-check.sh): combine — open PR #86 (TCS-83) adds the `KEYS_CHECK` knob, a `keys-signup` block after the coverage block and rewrites the header total line. This plan changes only the cov-count block, the two cov-count header lines, one env-list line and the preflight knob list. The two designs are independent; whichever merges second takes both header edits and both knob additions on rebase.

## Sibling claims (not touched)
- TCS-37 claims docs/API.md. This plan does not edit it, so the new `skipped` field is documented only in docs/BACKFILL.md. A follow-up line in API.md is a `[NOTE]` for after TCS-37 merges.

## ASSUMPTIONS
- Source of `skipped`: the ticket allows `GET /v1/internal/import/<eco>` or `/v1/status` coverage. I picked `/v1/status`, because `.github/workflows/launch-check.yml` says the check "reads prod and npm only and needs no secret", and the internal route needs `IMPORT_TOKEN`. Other reading: read the internal route with an `IMPORT_TOKEN` env and add the secret to the workflow; no API change, but the public gate would need a secret.
- "under 50 ids" counts the ids in OSV's CSV (`osv`), not the non-skipped ids. Other reading: compare `want` with 50. For Pub both give the same answer.
- The 50 is an env knob `COV_SMALL_IDS` with default 50, like `COV_MIN_PCT`, not a DB row: the script has no DB access and reads public HTTP only. Other reading: a settings row exposed through `/v1/status`; more change for the same effect.
- "prints both numbers": one info line per ecosystem with have, want, OSV id count and skipped, on pass and on fail. Other reading: print numbers only in the FAIL line.
- MAL- ids now stay in the CSV count, because the importer counts them in `skipped`. Other reading: keep `grep -v '^MAL-'` and subtract `skipped`; that subtracts MAL- twice and makes the gate too easy.

## Failure modes
- Decision rule: cov-count pass/fail per ecosystem, with `want = max(osv - skipped, 0)`; small rule `have >= want` when `osv < COV_SMALL_IDS`, else `have * 100 >= want * COV_MIN_PCT`. PASS side: Pub osv 14, skipped 2, have 12 (12 of 12, needs all); npm osv 60, skipped 0, have 54 (90%); osv exactly 50, have 45 (edge: the percent rule applies at 50, not "all"); osv 3, skipped 3, have 0 (0 of 0); CSV older than the run, have > want. FAIL side: Pub have 9 of 12; Pub have 11 of 12 (near miss: 92% passes the percent rule, but under 50 ids needs all); npm have 53 of 60 (near miss under 90%); `skipped` absent from the row (near miss: absent is not 0, an older worker deploy); `skipped` null on a runtime row is filtered out before the rule by `select(.imported != null)`. MAL- ids stay in `osv` and in `skipped`, so they cancel (the tcs-32 `npm 3 of 12` text holds). Source: the Pub 14/2 case from the ticket body; the other cases are `source: assumed` fixtures. Test: tests/launch/launch-check.tcs-91.test.ts cases 1-7, plus tests/launch/launch-coverage.tcs-32.test.ts unchanged.
- Exit paths: (a) all ecosystems pass: `ok cov-count`, the run continues, the FAIL counter stays the same; (b) one or more short: one `FAIL cov-count:` line, the script FAIL counter goes up by 1 and the final exit is 1; (c) `skipped` missing: the same FAIL path with a named reason, never a pass; (d) `COV_SMALL_IDS` not a whole number: `FAIL preflight`, exit 1 before any HTTP read. The script is read-only: no state, lock, cursor or budget is touched on any path, and no retry happens. Test: tests/launch/launch-check.tcs-91.test.ts cases 1, 2, 7 and 8 (exit code and FAIL line asserted).
- Writer/reader round-trip: new field `skipped` on `/v1/status` coverage rows. Writer: `loadStatus` in `src/site/data.ts` (from `backfill.skipped` via `STATUS_BACKFILL_SQL`; 0 with no backfill row; null for runtimes). Readers: `scripts/launch-check.sh` cov-count (jq, number required), `site/status.ts` `CoverageRow` (type only, HTML unchanged), `src/routes/status.ts` (JSON pass-through). The round-trip test runs the real backfill script into a local worker, reads `/v1/status`, and feeds it to launch-check. Test: tests/launch/launch-check.tcs-91.test.ts cases 1 and 9, plus the updated pins in tests/routes/status-coverage.tcs-32.test.ts.
- Alert or freeze blast radius: n/a — no new alert, page or freeze. The only output is one FAIL line per launch-check run (at most 1 per run, listing all short ecosystems in it), and the workflow run fails as it does today.
- Defaults in prod: `COV_SMALL_IDS` defaults to 50, the number the ticket names; `.github/workflows/launch-check.yml` does not set it, so prod uses 50. `COV_MIN_PCT` stays 90. cov-count still runs only when `COVERAGE_CHECK=1` (`COVERAGE_CHECK_ENABLED=1` in the workflow), unchanged. Test: tests/launch/launch-check.tcs-91.test.ts case 3 (default 50 applies with no env set) and case 8 (bad value refused).
- Status evidence: `ok cov-count` prints only when every OSV ecosystem row has a numeric `skipped` and meets its rule; the per-ecosystem info line `cov-count: <eco> <have> of <want> (<osv> OSV ids, <skipped> skipped, needs <all|N%>)` prints the numbers behind the verdict. An empty CSV or a missing `skipped` never prints ok. Test: tests/launch/launch-check.tcs-91.test.ts cases 1 and 7.

## System invariants
None beyond the iron laws. SIZE S: one read-only operator script and one additive field on a public read; no cross-run state, no side effect, no cron or lock.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| Denominator = OSV ids − backfill.skipped, per ecosystem | T1, T2 | launch-check.tcs-91: "Pub 12 of 12 passes" |
| Read the backfill row (skipped) from internal route or /v1/status | T1 | launch-check.tcs-91: "status coverage skipped"; status-coverage.tcs-32 pins |
| Keep the 90 percent threshold | T3 | launch-check.tcs-91: 60 ids, 54 have passes, 53 fails; 50 ids, 45 have passes |
| Print both numbers | T3 | launch-check.tcs-91: info line `cov-count: Pub 12 of 12 (14 OSV ids, 2 skipped, needs all)` |
| Under 50 ids: every non-skipped id required | T3 | launch-check.tcs-91: Pub 11 of 12 fails (92% would pass the percent rule) |
| AT: skipped 2 of 14 passes | T2 | launch-check.tcs-91 case 1 |
| AT: 3 missing non-skipped ids fails | T2, T3 | launch-check.tcs-91 case 2 |
| Negative: a correct import no longer fails on withdrawn ids | T2 | launch-check.tcs-91 case 1 (through the real backfill script) |

## Acceptance tests
File `tests/launch/launch-check.tcs-91.test.ts` (vitest, Node pool like `launch-coverage.tcs-32.test.ts`; reuses `startLocalWorker` from `local-worker.tcs-14.ts` and `buildZip`/`osvRecord`/`jsonEntry` from `tests/backfill/zip-fixture.tcs-32.ts`; local OSV fake server; each test starts its own worker, so no shared data). Each case asserts only cov-count lines.
1. "Pub 12 of 12": OSV fake serves Pub all.zip with 14 records, 2 of them `withdrawn`; the CSV lists all 14. Run `scripts/backfill/run.mjs --ecosystem Pub` (production path). Run launch-check with `COVERAGE_CHECK=1`. Assert `ok cov-count` and the line `cov-count: Pub 12 of 12 (14 OSV ids, 2 skipped, needs all)`. This case FAILS on main (`FAIL cov-count: ... Pub 12 of 14`).
2. 3 missing non-skipped ids: seed `backfill` row Pub `imported 9, skipped 2`, CSV 14 ids. Assert `FAIL cov-count: .*Pub 9 of 12`.
3. Small rule near miss: Pub `imported 11, skipped 2`, CSV 14. Assert `FAIL cov-count: .*Pub 11 of 12`.
4. Percent rule kept: npm CSV 60 ids, `imported 54, skipped 0` passes with `needs 90%`; `imported 53` FAILs `npm 53 of 60`.
5. Boundary: CSV exactly 50 ids, `imported 45, skipped 0` passes (percent rule, not "all").
6. All skipped: CSV 3 ids, `imported 0, skipped 3` passes (`0 of 0`).
7. `skipped` missing: a tiny fake `/v1/status` server whose coverage row has no `skipped`; assert `FAIL cov-count: .*no skipped count`.
8. `COV_SMALL_IDS=abc`: assert `FAIL preflight: COV_SMALL_IDS` and exit 1.
9. "status coverage skipped": `GET /v1/status` on the seeded worker returns the Pub row with `skipped: 2` and the node row with `skipped: null`.
Mutation check (D1): restore `grep -v '^MAL-'` or drop `- skipped` and confirm cases 1 and 3 go red.

Regression risk: `tests/launch/launch-coverage.tcs-32.test.ts` (cov-count text `npm 3 of 12` must stay), `tests/launch/launch-check.tcs-14.test.ts`, `tests/launch/launch-node-ledger.tcs-69.test.ts`, `tests/routes/status-coverage.tcs-32.test.ts`, any site/status render test.

## QA screens
- `https://tocsin.sh/v1/status`: coverage rows show `skipped` (number for OSV ecosystems, null for runtimes).
- `https://tocsin.sh/status`: the Coverage table renders as before (no new column).
No browser flow: launch-check is an operator script.

## Entry points
no user-facing entry point (operator script plus one additive field on the public status JSON).

KIND: bug

## Reproduction
REPRO: on main, a launch-check run with COVERAGE_CHECK=1 against a local worker whose Pub backfill read 14 OSV ids with 2 withdrawn: `npm test -- tests/launch/launch-check.tcs-91.test.ts -t "Pub 12 of 12"` (the new test file applied to the merge base) fails.
OBSERVED: `FAIL cov-count: under 90% of the OSV ids: Pub 12 of 14`, exit 1, on a correct import.
EXPECTED: `ok cov-count` with `cov-count: Pub 12 of 12 (14 OSV ids, 2 skipped, needs all)`.
ROOT CAUSE: scripts/launch-check.sh:219 (`want` counts every non-MAL- CSV id and ignores `backfill.skipped`, which also holds the withdrawn ids skipped at scripts/backfill/osv-import.mjs:173).
BLAST RADIUS: only `cov-count` in scripts/launch-check.sh, run by `.github/workflows/launch-check.yml` when `COVERAGE_CHECK_ENABLED=1`. The `/v1/status` change reaches `loadStatus` callers: `src/routes/status.ts` (JSON), `src/routes/site.ts` (/status HTML), `src/site/data.ts` freshness (reads no coverage). CodeGraph not available on this box; callers found by grep.

## Design collision check (BH-5791)

Checked 5 listed and 0 derived symbols against main b6daee077db9..b6daee077db9 and 1 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 4
LINES: 45
DIFF_KB: 14

SIZE: S
