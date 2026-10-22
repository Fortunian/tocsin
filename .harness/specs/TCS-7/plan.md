# TCS-7 plan: Enrichment: NVD severity, CISA KEV exploited flag, EPSS score

Issue: Fortunian/tocsin#7. Blocked-by #2 (TCS-2): CLOSED, merged as 4c2f645.
Branch: `ticket/tcs-7`, resumed from 2 checkpoint commits (25d4fc2, 08d0e1e) on merge-base 105274e.
origin/main is now b598636, 3 commits past the fork (TCS-12 #22, TCS-13 #23, TCS-10 #24).

## Spec changes from comments
none (the issue has 0 comments at 17:4xZ; `updatedAt` = createdAt 2026-10-22T00:26:48Z; the body is the spec).

## Already on main?
No. `git log origin/main --since=2026-10-22T00:26:48Z -- src/ingest src/schema` lists only 4c2f645 (TCS-2). `git log origin/main -Snvd` finds no NVD ingester. `defaultRegistry` on main is `{ osv }`. No PR for TCS-7 exists (`gh pr list --search TCS-7`).

## State of the branch (why this plan is short)
The previous build (tocsin-TCS-7-202610221350) wrote a full plan, and its execute stage committed the whole scope as 2 checkpoints, then ended EXECUTE_EMPTY (no commit of its own, no PR). That plan is the design of record; this plan does not change it. Measured in this session on `ticket/tcs-7` @ 08d0e1e:
- `npx vitest run` (TCS-7 files + cron): 6 files, 62 tests, rc 0.
- `npx vitest run` (whole suite): 20 files, 393 tests, rc 0.
- `npm run typecheck`: rc 0.
Code read in this session: `src/ingest/nvd.ts`, `kev.ts`, `epss.ts`, `config.ts`, `cve-page.ts`, and the diffs of `registry.ts`, `upsert.ts`, `types.ts`, `cvss.ts`, `src/schema/severity.ts`, `src/env.ts`. They match the 13:50 plan design (KV dedup mark after the D1 write; 403/429/5xx never marks; KEV `exploited = 0` watermark; EPSS writes with no cursor change; `labelFromScore` moved with a re-export).

What is left:
1. `main` gained `migrations/0006_site_settings.sql` (TCS-10). The branch also has a `0006_`. Two files with one number apply in name order today, but the number must be unique: renumber ours to `0007`.
2. `git merge-tree` of HEAD and origin/main: CONFLICT in `docs/RETENTION.md` and `tests/worker/migrations.tcs-1.test.ts` (both sides add lines).
3. `main` changed `vitest.config.ts` to 3 projects (api, mcp, cli), changed `package.json` `typecheck` to 3 tsc runs, and CI now runs `npm run gen:docs -- --check`. The merged tree must pass all of these.
4. One open measurement: the EPSS ingester reads the full CSV (about 300k rows) into a Map in the scheduled Worker. The suite never runs it at that volume.

Context: CodeGraph NOT AVAILABLE (prompt top line). Caller evidence from `grep -rn` and git diff.

## Scope
- Merge origin/main into `ticket/tcs-7` (a merge commit, not a rebase: the checkpoints are pushed).
- Renumber `migrations/0006_nvd_pending_index.sql` to `migrations/0007_nvd_pending_index.sql` (content unchanged) and fix the 2 references.
- Resolve the 2 conflicts by keeping both sides.
- Add one volume test for EPSS and record its time.
- Full verification on the merged tree, plus mutation checks (D1).
No design change. No new ingester logic.

Out of scope (ticket): GitHub Advisory Database as a separate source.

## Files to touch
Already on the branch from the checkpoints (part of this PR; listed so the claim is complete):
- `src/schema/severity.ts`
- `src/ingest/cvss.ts`
- `src/ingest/nvd.ts`
- `src/ingest/kev.ts`
- `src/ingest/epss.ts`
- `src/ingest/config.ts`
- `src/ingest/cve-page.ts`
- `src/ingest/registry.ts`
- `src/ingest/upsert.ts`
- `src/ingest/types.ts`
- `src/env.ts`
- `docs/RETENTION.md`
- `tests/cron/run.tcs-2.test.ts`
- `tests/worker/migrations.tcs-1.test.ts`
- `tests/raw-modules.d.ts`
- `tests/schema/severity.tcs-7.test.ts`
- `tests/ingest/nvd.tcs-7.test.ts`
- `tests/ingest/kev.tcs-7.test.ts`
- `tests/ingest/epss.tcs-7.test.ts`
- `tests/ingest/upsert-severity.tcs-7.test.ts`
- `tests/ingest/enrich-fake.tcs-7.ts`
- `tests/fixtures/nvd/SOURCES.md`, `tests/fixtures/nvd/cve-score-9.2.json`, `tests/fixtures/nvd/cve-no-metrics.json`, `tests/fixtures/nvd/no-results.json`
- `tests/fixtures/kev/SOURCES.md`, `tests/fixtures/kev/feed.json`
- `tests/fixtures/epss/SOURCES.md`, `tests/fixtures/epss/scores.csv`

Edited or created in this build:
- `migrations/0007_nvd_pending_index.sql` (new name; `git mv` from `migrations/0006_nvd_pending_index.sql`, which is deleted)
- `src/ingest/nvd.ts` (comment line 27: `migrations/0006` -> `migrations/0007`)
- `tests/worker/migrations.tcs-1.test.ts` (conflict resolution, see Tests that must change)
- `docs/RETENTION.md` (conflict resolution: keep main's `site.*` rows text and `site:latest:v1` section, and our `nvd:queried:`, `cursor:nvd`, `epss:state` sections)
- `tests/ingest/epss.tcs-7.test.ts` (one new volume case)

## Tests that must change
- `tests/worker/migrations.tcs-1.test.ts`: this ticket adds migration `0007_nvd_pending_index.sql` and index `idx_advisories_nvd_pending`. The "applies" case lists `0001..0007` (main's `0006_site_settings.sql`, then ours), and `INDEXES` includes `idx_advisories_nvd_pending`.
- `tests/cron/run.tcs-2.test.ts`: case 3b pinned `defaultRegistry` to exactly `["osv"]`; this ticket registers nvd, kev, epss. Already changed on the branch: sorted keys equal `["epss","kev","nvd","osv"]`, each `.id` equals its key.

## Verify (run, not edited)
- `npm ci` (main changed `package-lock.json`)
- `npm test` (projects api, mcp, cli)
- `npm run typecheck` (root, workers/mcp, packages/cli)
- `npm run gen:schema -- --check`
- `npm run gen:docs -- --check`
- Regression risk, inside `npm test`: `tests/unit/cvss.tcs-2.test.ts` (labelFromScore re-export), `tests/ingest/upsert.tcs-2.test.ts` and `tests/ingest/osv.tcs-2.test.ts` (merge() severity guard), `tests/worker/migrations.tcs-1.test.ts`, `tests/routes/events*.tcs-3.test.ts` (doc_json now carries nvd/kev source entries), `tests/routes/check*.tcs-9.test.ts` (reads `sources[0]`, which stays the creator), `tests/routes/site*.tcs-10.test.ts` (reads advisories for the Latest table).

## Tasks

T1. Merge origin/main into `ticket/tcs-7`, resolve the 2 conflicts by keeping both sides, run `npm ci`.
VALIDATE: git merge-base --is-ancestor origin/main HEAD && ! git grep -n '^<<<<<<<\|^>>>>>>>' -- docs tests src migrations
SATISFIES: the ticket's "Verification contract: npm test, npm run typecheck" (the PR must build on current main to merge).

T2. Renumber the partial-index migration to 0007; fix the nvd.ts comment and the migrations test.
VALIDATE: ls migrations | grep -c '^0006_' | grep -qx 1 && test -f migrations/0007_nvd_pending_index.sql && npx vitest run tests/worker/migrations.tcs-1.test.ts tests/ingest/nvd.tcs-7.test.ts
SATISFIES: repo iron rule 2 ("Every query on a new table has an EXPLAIN QUERY PLAN proof") for the NVD candidate query that delivers "for advisories with a CVE but no severity score"; the index must apply once and in order in prod (`wrangler d1 migrations apply`).

T3. EPSS volume case in `tests/ingest/epss.tcs-7.test.ts`: generate a gzipped CSV of 300,000 rows in the test (the fake serves it), seed 50 matching advisories with unique test CVE ids, run `epss.run`, assert the 50 rows carry the CSV value and the cursor is unchanged, and log the wall time with `console.info` (no time assertion, the box is not the Worker).
VALIDATE: npx vitest run tests/ingest/epss.tcs-7.test.ts -t "300,000"
SATISFIES: "downloads the daily EPSS CSV once per run and writes epss for matching advisories" at the real file size (about 300k rows), not only the 7-row fixture.

T4. Mutation checks (D1), each reverted after it is seen red: (a) remove the `kv.put(nvdQueriedKey…)` line in nvd.ts -> the nvd no-metrics second-run case fails; (b) remove `AND exploited = 0` from `KEV_SQL.match` -> the kev second-run "0 writes" case fails; (c) add `cursor = <nextCursor>` to the EPSS UPDATE -> the epss cursor case fails; (d) change `>= 9.0` to `> 9.0` in severity.ts -> the 9.0 boundary fails. Record the 4 results in the PR body.
VALIDATE: git diff --quiet -- src && echo clean after the 4 mutations are reverted; the PR body has 4 lines "MUTATION <a..d>: red"
SATISFIES: AT "a second run makes zero HTTP calls", "a non-matching run changes nothing", "does not change the cursor", "boundary values 9.0, 7.0, 4.0, 0.1, 0".

T5. Full verification on the merged tree.
VALIDATE: npm test && npm run typecheck && npm run gen:schema -- --check && npm run gen:docs -- --check
SATISFIES: the ticket's "Verification contract: npm test, npm run typecheck".

## Acceptance tests
Already on the branch and green at 08d0e1e (62 tests). Per-ticket names map the ticket's names: `tests/ingest/nvd.test.ts` -> `tests/ingest/nvd.tcs-7.test.ts`, and so on.
- `tests/ingest/nvd.tcs-7.test.ts`: a scoreless advisory gets `severity_score` 9.2 and `severity_label` critical (column and doc_json); the second run makes 0 fetch calls; a no-metrics answer marks `nvd:queried:<cve>` and the next run makes 0 calls; a KV-marked CVE, a scored advisory and an advisory with no CVE make 0 calls; 2 advisories with 1 CVE make 1 call; the per-run cap and the scan cursor; `apiKey` header only when `NVD_API_KEY` is set; 503 marks nothing and stops; 404 counts as answered; EXPLAIN on 2,000 seeded rows uses `idx_advisories_nvd_pending`; `worker.scheduled` reaches the nvd ingester.
- `tests/ingest/kev.tcs-7.test.ts`: 1 matching CVE sets `exploited = 1` and bumps the cursor; a second run writes nothing; a no-match feed changes no row; near misses (CVE prefix, lowercase id, null `cve_primary`) do not match; HTTP 500 and a body without `vulnerabilities` throw with no write; the cap defers to the next run; EXPLAIN uses `idx_advisories_cve_primary`.
- `tests/ingest/epss.tcs-7.test.ts`: the fixture CSV sets `epss` in 0..1, column and doc_json; the cursor does not change; the same score_date is not re-applied; an absent CVE keeps its old epss; a bad row is skipped; a missing `score_date` throws; paging resumes from `epss:state`; EPSS EXPLAIN uses `idx_advisories_cve_primary`. NEW (T3): 300,000-row gzipped CSV, 50 matches written, cursor unchanged, time logged.
- `tests/schema/severity.tcs-7.test.ts`: 9.0 critical, 7.0 high, 4.0 medium, 0.1 low, 0 unknown, plus near misses 8.9, 6.9, 3.9, 10.
- `tests/ingest/upsert-severity.tcs-7.test.ts`: an OSV re-ingest with no score keeps the NVD score; a creator score replaces it.
- `tests/cron/run.tcs-2.test.ts` case 3b: registry keys.
- `tests/worker/migrations.tcs-1.test.ts`: applies 0001..0007 and creates `idx_advisories_nvd_pending`.
Every test file spies on `globalThis.fetch` and asserts 0 real calls (scalable tests rule 6). Each test seeds unique ids and test CVE ids (rule 5).

## QA screens
No UI. After deploy, API checks: `GET https://tocsin.sh/v1/events?since=0&exploited=true` returns KEV-flagged advisories with a `kev` source entry; an event for a CVE with an NVD score shows `severity.score` and an `nvd` source entry. `[NOTE] not verified here`: prod deploy and the prod `NVD_API_KEY` secret.

## Iron laws applied
- UI laws (sortable headers, list over cards, drill-down, 375px, native dialogs): n/a, no UI.
- DB-driven config: every knob is in `sources.config_json` of its own row (`nvd`, `kev`, `epss`) with a documented code fallback (`src/ingest/config.ts` readers; a bad value throws).
- RLS: n/a (Cloudflare D1, not Supabase).
- Indexes: no new table. One partial index `idx_advisories_nvd_pending` (migration 0007) for the NVD scan; KEV and EPSS use the existing `idx_advisories_cve_primary`. Each query has an EXPLAIN test on seeded rows.
- No per-row correlated subquery added. `NEXT_CURSOR` is the existing single MAX() seek per write.
- Retention: no new table. KV `nvd:queried:<cve>` expires by TTL (`requery_hours`); `cursor:nvd` and `epss:state` are single keys overwritten in place. Documented in `docs/RETENTION.md`.
- De-AI: n/a, no generated text. Repo rule 10: severity and exploited carry a source entry with a link (NVD detail page, KEV feed URL).
- Dedup before spend: NVD is free and rate-limited (50 or 5 per 30 s). The D1 fact `severity_score IS NOT NULL` and the KV mark are checked BEFORE each call. A 200 with no score and a 404 are answered and terminal for 24 h. The key is the CVE id, not a URL.
- No LLM, no `claude-*` string. No metered spend.
- Migration: additive (`CREATE INDEX IF NOT EXISTS`), applied by CI deploy (`wrangler d1 migrations apply DB --remote`).

## Build discipline rules that bite
- D1: T4 mutation checks.
- D2/D27: the `worker.scheduled` nvd case proves the cron reaches the new ingesters (already on the branch).
- D6/D30: record the true exit codes of T5; never pipe them.
- D20: migration 0007 is one `CREATE INDEX IF NOT EXISTS`, no destructive statement.
- D21: per-run caps (`max_requests_per_run`, `max_updates_per_run`, `max_pages`) exist; T3 measures the one unbounded read (the CSV parse).
- D25: no change to `osv.ts`; the merge commit adds nothing beyond main and the conflict resolutions.
- D8: `NVD_API_KEY` as a wrangler secret goes in the PR body.

## Changed symbols
- function `labelFromScore`: moves to `src/schema/severity.ts`; `src/ingest/cvss.ts` re-exports it. Behavior unchanged. callers: left alone: `src/ingest/osv.ts` and `tests/unit/cvss.tcs-2.test.ts` import it from cvss.ts.
- function `merge` (src/ingest/upsert.ts, private): keeps a stored score when the incoming doc has none.
- function `appendSource`, `checked` (src/ingest/upsert.ts): new export / now exported.
- function `defaultRegistry` (const, src/ingest/registry.ts): adds `nvd`, `kev`, `epss`.
- format `Env` (src/env.ts): adds optional `NVD_API_KEY`.
- format `RunResult` (src/ingest/types.ts): adds optional `deferred`, `incomplete`.
- function `nvd`, `kev`, `epss` (new Ingesters); `posIntConfig`, `urlConfig`, `cvePageSql`, `readCvePage` (new helpers).
- format `sources.config_json` for rows `nvd`, `kev`, `epss`: new optional keys.
- format KV keys `nvd:queried:<cve>`, `cursor:nvd`, `epss:state` (new).
- format migration file `0007_nvd_pending_index.sql` (new number).
- format ambient module `*?raw` (tests/raw-modules.d.ts): new test-only declaration.

## Design collisions
Checked against main 86ad46b (TCS-13 #23), main b598636 (TCS-10 #24) and open PR #25 (TCS-6, head 106d954). Main changed none of this plan's symbols in a way that conflicts; 3 hits are name or text matches only. PR #25 changes 5 of the same symbols, all additively.
- `merge`: combine — 86ad46b adds a different private `merge(parts: CheckResult[])` in `packages/cli/src/check.ts` (CLI result merge); this plan's `merge` is the private one in `src/ingest/upsert.ts`. Two module-private functions in different packages: no shared code, no change needed.
- `Env`: combine — b598636 only imports `Env` (`src/routes/site.ts`, `src/routes/status.ts`, `src/site/data.ts`) and does not change it; PR #25 adds optional `GITHUB_TOKEN`, this plan adds optional `NVD_API_KEY`. The union keeps both fields; the second PR to merge resolves the one-hunk conflict in `src/env.ts` by keeping both lines.
- `nvd`: combine — b598636 only names `nvd` as a seeded `sources` row in `tests/routes/site.tcs-10.test.ts` (`/status` HTML and `/v1/status` sorted ids `["epss","kev","node-runtime","nvd","osv","php-runtime"]`); it reads `id, kind, last_run_at, last_ok_at, last_error` and never runs the ingester. This plan's nvd ingester writes `last_ok_at`/`last_error` through the existing registry path, so the status page shows its real state; T5 runs `tests/routes/site*.tcs-10.test.ts` on the merged tree.
- `defaultRegistry`: combine — PR #25 sets `{ osv, "node-runtime": nodeRuntime, "php-runtime": phpRuntime }`, this plan sets `{ osv, nvd, kev, epss }`. The second to merge takes the union `{ osv, nvd, kev, epss, "node-runtime": nodeRuntime, "php-runtime": phpRuntime }`, and case 3b in `tests/cron/run.tcs-2.test.ts` asserts the sorted union `["epss","kev","node-runtime","nvd","osv","php-runtime"]` (PR #25's version pins insertion order; the sorted form plus the `ingester.id === key` loop that both versions use replaces it).
- `RunResult`: combine — PR #25 uses `RunResult` as it is on main (`{ fetched, upserted, unchanged, errors }`) and adds no field; its `incomplete` flags are on its own `PhpNormalizeResult` and normalize result, not on `RunResult`. This plan's new optional `deferred` and `incomplete` fields do not break its object literals.
- `sources.config_json`: combine — each PR reads only its own rows: PR #25 reads rows `node-runtime`, `php-runtime` through `readRuntimeConfig` in `src/ingest/runtime-text.ts`; this plan reads rows `nvd`, `kev`, `epss` through `posIntConfig`/`urlConfig` in `src/ingest/config.ts`. No key or row overlaps. Both readers stay; folding them into one helper is a later cleanup, not this ticket.
- `*?raw`: combine — PR #25 adds `tests/raw-modules.tcs-6.d.ts` with the same ambient `declare module "*?raw"` (`default: string`) as this plan's `tests/raw-modules.d.ts`. Two identical ambient declarations of one module merge without a TypeScript error, so both files can coexist. If #25 merges first, T1 may delete `tests/raw-modules.d.ts` and use #25's file; if this PR merges first, #25 may drop its copy on its rebase. `npm run typecheck` in T5 proves the merged tree.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty at plan time (17:4xZ). No live sibling build.

## ASSUMPTIONS
- Resume, not rebuild: the 13:50 plan (builds/tocsin-TCS-7-202610221350/plan.md) and its checkpoint code are the design of record. Other reading: start over from main. Rejected because the code is complete and green (393 tests).
- Migration number: ours moves to 0007 because main took 0006 first. Other reading: keep two `0006_` files (they would apply in name order). Rejected: a duplicate number confuses the migration ledger.
- Test file names: the ticket names `tests/ingest/nvd.test.ts` etc.; the harness requires per-ticket names, so they are `*.tcs-7.test.ts` in the same folders.
- NVD writes bump the cursor. The ticket says KEV bumps and EPSS does not, and is silent on NVD. Without a bump a `min_severity=high` subscriber never sees an advisory move from unknown to critical. Other reading: no bump.
- NVD score preference: CVSS v3.1, then v3.0, then v4.0; NVD "Primary" entry first; v2 ignored.
- Score 0 maps to `unknown` (the advisory schema has no "none").
- "Batched" NVD means at most `max_requests_per_run` sequential calls per 10-minute cron run (NVD 2.0 has no multi-CVE lookup): 50 with a key, 5 without. Other reading: in-run pacing with sleeps.
- KEV and EPSS match on `cve_primary` (indexed) only. An advisory whose listed CVE is its second CVE is not flagged. A full match needs a CVE-to-advisory table, a schema change the ticket does not ask for.
- EPSS skips the DB pass when the CSV `score_date` is already fully applied; the file is still downloaded once per run, but only its first line is read.
- EPSS URL default is `epss.empiricalsecurity.com` (the documented cyentia host 301s there).
- NVD and KEV append a source entry (rule 10 link); EPSS adds none (no cursor change, a probability, not a published claim).
- Contract suite (scalable tests rule 4): the repo has no real-vendor contract suite (none for OSV either). This PR ships the 3 seams and the fake, not the nightly suite. Other reading: add a contract workflow here.
- `NVD_API_KEY` is listed in `.env.example`; prod needs `wrangler secret put NVD_API_KEY`. Without it the ingester makes 5 calls per run.
- EPSS CPU: the scheduled Worker has no `[limits] cpu_ms` in wrangler.toml. T3 measures the 300k-row parse on this box; the prod CPU time is `[NOTE] not verified here`. If T3 takes more than 10 s locally, the PR body says so as the headline.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section
TEST-CHANGE: <- Tests that must change (tests/worker/migrations.tcs-1.test.ts, tests/cron/run.tcs-2.test.ts)
NVD_API_KEY <- env var: wrangler secret put NVD_API_KEY in prod (CLAUDE.md "New env var -> every environment")
MUTATION <- T4
300,000 <- T3 (EPSS volume time)
```

## System invariants
(a) Cross-run state. NVD dedup: the D1 fact `severity_score IS NOT NULL` (durable) plus KV `nvd:queried:<cve>` with TTL `requery_hours` (only for "answered with no score"). NVD scan position: KV `cursor:nvd` (a hint; losing it restarts the scan at "", no wrong data). EPSS progress: KV `epss:state` `{score_date, after}` (losing it costs one extra pass). KEV: no state; `exploited = 0` in the WHERE is the watermark.
(b) Side effects. NVD: score -> D1 write, then KV mark; no score or 404 -> KV mark only; 403/429/5xx/network -> error recorded, no mark, loop stops, registry writes `sources.last_error`. D1 before KV, so "marked but not stored" cannot happen. KEV/EPSS HTTP or format failure -> throw, nothing written. `NVD_API_KEY` unset -> 5 calls per run, no header.
(c) Matcher negatives (KEV flags are client-visible and bump the cursor): CVE prefix collision (`CVE-2021-4422` vs `CVE-2021-44228`), lowercase ids, null `cve_primary`, an already exploited row, a feed without `vulnerabilities`, an HTTP error page. All in kev.tcs-7.
(d) Neighbors. One cron (`*/10 * * * *`) runs enabled sources in `ORDER BY id` (epss, kev, nvd, osv), one at a time, in one invocation. EPSS runs first, so a CPU overrun there would stop the later sources in that run: T3 measures it. Writes are guarded (`AND severity_score IS NULL`, `AND exploited = 0`). `merge()` keeps `exploited`, `epss` and a stored score across OSV re-ingests. Feed ETag ignores EPSS writes (no cursor change), as the ticket says. `/v1/check` reads `sources[0]`, which stays the creator. The TCS-10 site Latest table reads advisories; it gains nothing and loses nothing.

## Requirements coverage
| Requirement (ticket line) | Task | Test |
|---|---|---|
| NVD: advisories with a CVE but no score are queried by CVE id | T2, T5 | nvd: scoreless gets 9.2/critical; no-CVE advisory 0 calls; EXPLAIN on partial index |
| NVD: batched, 50 per 30 s with `NVD_API_KEY` | T5 | nvd: cap test; 5 without key; `apiKey` header only with key |
| NVD writes `severity.score` and label | T4, T5 | nvd: column + doc_json; severity boundaries |
| Dedup: skip CVE that already has a score | T4, T5 | nvd: scored advisory 0 calls; second run 0 calls |
| Dedup: skip CVE queried in last 24 h (KV `nvd:queried:<cve>`) | T4, T5 | nvd: no-metrics marks KV, next run 0 calls; pre-marked 0 calls |
| KEV: download feed once per run | T5 | kev: fake call count 1 per run |
| KEV: `exploited=true` on every matching advisory | T5 | kev: match flagged; cap test |
| KEV: newly exploited gets a new cursor | T5 | kev: cursor bumped |
| KEV: non-matching run changes nothing | T4, T5 | kev: no-match fixture unchanged; second run 0 writes |
| EPSS: download daily CSV once per run, write `epss` | T3, T5 | epss: value in 0..1; 300k-row volume case |
| NEGATIVE: EPSS change alone does not bump cursor | T3, T4 | epss: cursor unchanged on write and on value change |
| Severity mapping in `src/schema/severity.ts` with 4 bands | T4, T5 | severity: 9.0, 7.0, 4.0, 0.1, 0 + near misses |
| NEGATIVE: GitHub Advisory Database not a separate source | none (not built) | case 3b pins registry keys to epss, kev, nvd, osv |
| Verification contract `npm test`, `npm run typecheck` | T1, T5 | full suite on the merged tree |
| Ingesters run from the cron | T5 | case 3b + `worker.scheduled` nvd case |

## Design collision check (BH-5791)

Checked 11 listed and 0 derived symbols against main 105274e5687f..b598636dd4d6 and 1 open PRs.
- `merge` (function, listed): main 86ad46bc9ba2, body or signature changed. Resolution: combine.
- `Env` (function, listed): main b598636dd4d6, (text match). Resolution: combine.
- `nvd` (function, listed): main b598636dd4d6, (text match). Resolution: combine.
- `defaultRegistry` (function, listed): PR #25 106d954670e2, (text match). Resolution: combine.
- `RunResult` (function, listed): PR #25 106d954670e2, (text match). Resolution: combine.
- `sources.config_json` (function, listed): PR #25 106d954670e2, (text match). Resolution: combine.
- `*?raw` (function, listed): PR #25 106d954670e2, (text match). Resolution: combine.

## Size
FILES: 12
LINES: 570
DIFF_KB: 85

KIND: feature
SIZE: M
