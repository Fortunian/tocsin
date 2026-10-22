# Plan: TCS-46 — OSV records with several affected packages: one advisory per package

Ticket: Fortunian/tocsin#46. Blocked-by #2 (hard): #2 is CLOSED. The thread has 0 comments, so the issue body is the spec.

ALREADY ON MAIN? (BH-5802): `git log origin/main --since=2026-10-22T21:26:26Z -- src/ingest/osv.ts` is empty. origin/main head is a627f29. `normalizeOsv` on main still picks one entry with `affectedList.find(...)` (src/ingest/osv.ts:200). Nothing of this ticket is on main.

CodeGraph: NOT AVAILABLE on this box. The file set comes from grep over `src/` and `tests/` (evidence below).

## Spec changes from comments

none

## Scope

1. `normalizeOsv` (src/ingest/osv.ts) produces one `AdvisoryInput` per distinct enabled `(ecosystem, name)` in `affected[]`, in first-appearance order. Each doc has its own `component`, `affected` ranges, `fixed_versions`, `action` and `summary` fallback. Entries with the same `(ecosystem, name)` are grouped, as today.
2. Source key per doc: the first doc keeps `source_id = <OSV id>`. Each later doc uses `source_id = <OSV id>#<ecosystem>/<name>`. The doc's `sources[0].source_id` equals that key, so `merge()` in upsert.ts treats the ingester as the creator. `sources[0].url` stays `https://osv.dev/vulnerability/<OSV id>` (a real link, repo rule 10).
3. `run()` upserts every doc of a record. `fetched` still counts records. `upserted` / `unchanged` count docs. A per-doc `InvalidAdvisoryError` goes to `errors` as `<source_id>: <message>` and the other docs of the record still store.
4. No change to upsert.ts, the feed, the check route or the CVE page. Each new row has its own `cursor` (one feed event), its own `advisory_cves` rows (the `/cve/:cve` page lists it) and its own `(component, ecosystem)` (the `/v1/check` candidates match it). The tests prove each of these paths.

Grep evidence for the blast radius (callers of the changed symbol):
- `normalizeOsv`: src/ingest/osv.ts:303 (`run`), tests/ingest/osv.tcs-2.test.ts:37,134, tests/check/go-runtime.tcs-40.test.ts:100. Both tests read `r.doc`. The result keeps `doc` (= the first doc), so they compile and pass unchanged.
- `findByCve` (src/ingest/upsert.ts:32) excludes rows that already have any `osv` source. So the second package of a CVE never merges into the first package's row. It inserts a fresh row. No upsert change is needed. A test pins this.
- Enrichers read every row of a CVE: NVD and EPSS through `cvePageSql` `group` (src/ingest/cve-page.ts:17), KEV through `cve_primary IN (...)` (src/ingest/kev.ts:23). The extra rows get enriched with no change.
- Backfill #32 is OPEN and not built. No OSV backfill code exists (`grep -rn backfill src` finds only `backfill_days`). When #32 is built it calls `normalizeOsv` and gets `docs`, the same path.

## Files to touch

- src/ingest/osv.ts (modify)
- tests/ingest/osv-multi-package.tcs-46.test.ts (create)
- tests/check/go-runtime-multi.tcs-46.test.ts (create)
- tests/fixtures/osv/multi-package.tcs-46.json (create)

## Verify (run, not edited)

- tests/ingest/osv.tcs-2.test.ts
- tests/check/go-runtime.tcs-40.test.ts
- tests/routes/check.tcs-9.test.ts, tests/routes/events.tcs-3.test.ts, tests/routes/advisory-page.tcs-34.test.ts
- `npm test`, `npm run typecheck`

## Tests that must change

None

## Changed symbols

- function `normalizeOsv`: the ok result gains `docs: { source_id: string; doc: AdvisoryInput }[]` (one per enabled package). `doc` stays and equals `docs[0].doc`. callers: left alone: tests/ingest/osv.tcs-2.test.ts and tests/check/go-runtime.tcs-40.test.ts read `doc`, which keeps its meaning.
- format `NormalizeResult` (type in src/ingest/osv.ts): adds the `docs` field.
- format `advisory_sources.source_id` for source `osv`: a second or later package uses `<OSV id>#<ecosystem>/<name>`. The first package keeps `<OSV id>`.
- function `run` (osv ingester, not exported): upserts each doc of a record.

## Design collisions

- `NormalizeResult`: combine — 106d954 adds a separate type `PhpNormalizeResult` in src/ingest/php-runtime.ts (a text match only). This plan changes `NormalizeResult` in src/ingest/osv.ts by adding `docs`; PR #31's diff does not touch osv.ts, so the two types stay independent and both land unchanged.
- `run`: combine — 48fcdb4 changes the module-local `run` in src/ingest/node-runtime.ts (NodeLinkError handling); this plan changes the module-local `run` in src/ingest/osv.ts. They are different non-exported functions in different files with no shared caller code, so both changes apply as written.

## Tasks

### T1. Fixture: two recorded OSV records
Fetch from `https://api.osv.dev/v1/vulns/<id>` at build time (probed 2026-10-22, both answer 200) and store them in `tests/fixtures/osv/multi-package.tcs-46.json` as a JSON array:
- `GHSA-jpcq-cgw6-v4j6` (CVE-2020-11023). Keep 3 of its 5 `affected[]` entries: `npm/jquery`, `RubyGems/jquery-rails`, `NuGet/jQuery`. NuGet is not in `DEFAULT_ECOSYSTEMS`, so it is the disabled package. Write the trim in a top-of-test comment.
- `GO-2022-0969` (CVE-2022-27664): `Go/stdlib` then `Go/golang.org/x/net`. The tcs-46 Go test reorders the entries to module first, stdlib second.
If the network is not available at build time, hand-write the 2 records from the probed shape and mark them `source: assumed` in the test comment.
VALIDATE: `node -e 'const r=require("./tests/fixtures/osv/multi-package.tcs-46.json");console.log(r.map(v=>v.id+":"+v.affected.length).join(","))'` prints `GHSA-jpcq-cgw6-v4j6:3,GO-2022-0969:2`
SATISFIES: "a recorded OSV record with three affected packages (two enabled ecosystems, one disabled)"

### T2. `normalizeOsv` returns one doc per enabled package
In src/ingest/osv.ts:
- Replace the `find` at line 200 with a loop over `affectedList` that collects the distinct enabled `(ecosystem, name)` pairs in first-appearance order. Same predicate as today (ecosystem in the list, non-empty string name).
- If the list is empty, return the same refusal as today: `no affected package in a listed ecosystem`.
- For each pair, build the doc with today's code (ranges from the `same` group, `action`, `summary`). Shared parts (`cve_ids`, `ghsa_id`, timestamps, `references`, severity) are computed once.
- Add `osvSourceId(id, index, ecosystem, name)`: index 0 gives `id`, others give `` `${id}#${ecosystem}/${name}` ``.
- Return `{ ok: true, doc: docs[0].doc, docs }`.
VALIDATE: `npx vitest run tests/ingest/osv-multi-package.tcs-46.test.ts -t "normalize"` passes, and `npx vitest run tests/ingest/osv.tcs-2.test.ts` still passes
SATISFIES: Scope 1, "`normalizeOsv` returns one `AdvisoryInput` per enabled `affected[]` entry ... `source_id` becomes `<OSV id>#<ecosystem>/<name>` for the second and later entries, keeping the first as `<OSV id>`"

### T3. `run()` upserts every doc
In `run()` (src/ingest/osv.ts:303-316): loop `norm.docs`. Call `upsertAdvisory(ctx.env.DB, d.doc, { source: "osv", source_id: d.source_id })` for each. Keep the try/catch per doc. Error lines use `d.source_id`. Keep `fetched += 1` per record. The cursor write per page stays the same.
VALIDATE: `npx vitest run tests/ingest/osv-multi-package.tcs-46.test.ts -t "run"` passes (first run: 2 upserted; second run: 0 upserted, 2 unchanged)
SATISFIES: Scope 3, "the cron use[s] the same path, so a re-read of an existing multi-package record adds the missing rows and marks the first `unchanged`"; acceptance "a second run yields `unchanged` twice"

### T4. Ingest acceptance test
Create tests/ingest/osv-multi-package.tcs-46.test.ts (cases listed under Acceptance tests). Use `createOsvFake` from tests/ingest/osv-fake.ts, so 0 network calls (assert the `fetch` spy count is 0, as osv.tcs-2 does). Suffix each record id with `-tcs46` before use, so ids are unique to this file.
VALIDATE: `npx vitest run tests/ingest/osv-multi-package.tcs-46.test.ts` passes; against `git show origin/main:src/ingest/osv.ts` (the REPRO red run in red.txt) it fails
SATISFIES: acceptance test 1 of the ticket; Scope 2 "The feed shows each as its own event; the advisory page (#34) for a CVE lists them all; `/v1/check` matches each package"

### T5. Go runtime: module first, stdlib second
Create tests/check/go-runtime-multi.tcs-46.test.ts. It reorders GO-2022-0969 (`-tcs46` id) to `golang.org/x/net` first, `stdlib` second, runs it through `normalizeOsv(v, ["Go"])` and `upsertAdvisory` for every doc, then calls `GET /v1/check?go=1.18.5`. The answer has an `affected` entry whose `advisory_id` is the stdlib row (read from `advisory_sources` by `GO-2022-0969-tcs46#Go/stdlib`).
VALIDATE: `npx vitest run tests/check/go-runtime-multi.tcs-46.test.ts` passes; it fails on main (main stores only `golang.org/x/net`)
SATISFIES: "`tests/check/go-runtime.tcs-40.test.ts` gains the case 'module first, stdlib second' returning the runtime hit" (placed in a per-ticket file, see ASSUMPTIONS)

### T6. Full suite and typecheck
VALIDATE: `npm run typecheck && npm test` exit 0
SATISFIES: Verification contract in CLAUDE.md; no regression in tcs-2, tcs-3, tcs-9, tcs-34, tcs-40

## Reproduction

REPRO: `npx vitest run tests/ingest/osv-multi-package.tcs-46.test.ts tests/check/go-runtime-multi.tcs-46.test.ts`
OBSERVED: on main, `normalizeOsv(GHSA-jpcq-cgw6-v4j6)` returns one doc (`npm/jquery`). `RubyGems/jquery-rails` is never stored. `POST /v1/check` with `jquery-rails 4.0.5` reports no hit for this GHSA. For GO-2022-0969 with module first, only `golang.org/x/net` is stored, so `/v1/check?go=1.18.5` misses it.
EXPECTED: two rows (`npm/jquery` and `RubyGems/jquery-rails`), each matched by `/v1/check`; the stdlib row answers the `go=` query.
ROOT CAUSE: src/ingest/osv.ts:200 (`affectedList.find(...)` keeps only the first enabled package) and src/ingest/osv.ts:310 (one upsert per record, keyed on `vuln.id`).
BLAST RADIUS: `run()` in src/ingest/osv.ts (the only production caller); tests/ingest/osv.tcs-2.test.ts and tests/check/go-runtime.tcs-40.test.ts (read `.doc`); upsertAdvisory in src/ingest/upsert.ts (receives more calls, unchanged code); feed, `/cve/:cve` and `/v1/check` readers (see more rows, unchanged code).

## Iron laws: how they apply

- Additive-only schema: no migration. New rows only. Existing `<OSV id>` rows keep their key.
- Indexes / EXPLAIN: no new table, no new query. All writes use existing statements (`UPSERT_SQL`, PK seeks).
- Retention: no new table. `advisories` grows by one row per extra package. Advisories are the product's history, kept by design (existing rule).
- Idempotent ingest on `(source, source_id)` (repo rule 3): each package has a stable key. A re-run gives `unchanged`. T3 and T4 test it.
- Delivery exactly-once (repo rule 4): each package row is its own advisory with its own id, so `(watchlist_id, advisory_id)` dedup applies per row. No change.
- DB-driven config (rule 5): the enabled list stays `sources.config_json.ecosystems`. No new limit, so no new knob.
- Dedup before spend: OSV is free and unmetered. No new call: one `getVuln` per record, as today.
- Deterministic, no LLM, no De-AI surface. Published text is still from the source with a link (rule 10).
- UI rules (sortable headers, list-over-cards, drill-down): no UI change.
- Scalable tests: the OSV seam is src/ingest/osv-client.ts. The fake is tests/ingest/osv-fake.ts. The new tests use the fake or call `normalizeOsv` directly: 0 network calls, asserted. The existing contract coverage for OSV is not changed.
- Performance: no screen or loader change. One extra D1 write batch per extra package during ingest.

## Build discipline (rules that bite)

- Per-ticket test files only. No edit to another ticket's test.
- Surgical change: osv.ts only; upsert.ts stays as it is.
- No hardcoded knob: none added.
- D1 mutation check: make `normalizeOsv` return only `docs[0]` and confirm cases 1, 3, 6, 7, 8 and 9 go red.
- D2 production entry point: cases 3 to 8 go through `osv.run` and the real routes (`/v1/events`, `/cve/:cve`, `/v1/check`).
- D4 real inputs: fixtures are real OSV records (trimmed, trim noted).
- D6 true exit codes: run the VALIDATE commands unpiped.

## ASSUMPTIONS

- The ticket names `tests/check/go-runtime.tcs-40.test.ts` for the "module first, stdlib second" case. The harness requires a new per-ticket test file. I put the case in `tests/check/go-runtime-multi.tcs-46.test.ts`. Other reading: append to the tcs-40 file.
- The ticket names `tests/ingest/osv-multi-package.tcs-NN.test.ts`. I used `tcs-46`.
- "returns one AdvisoryInput per enabled entry": I added `docs` and kept `doc` as the first doc, so existing callers do not change. Other reading: replace `doc` with an array and edit the tcs-2 and tcs-40 tests.
- "Enabled entry" means a distinct enabled `(ecosystem, name)` pair. Duplicate entries for one package (OSV often splits ranges over several entries) stay one advisory with all ranges, as today. Other reading: one row per raw entry, which would create duplicate rows for one package.
- The "recorded" record is the real GHSA-jpcq-cgw6-v4j6, trimmed from 5 to 3 `affected[]` entries so it matches the ticket's "three packages". Other reading: a hand-made record.
- If OSV reorders `affected[]` so a different package becomes first, the `<OSV id>` row takes the new first package and the old first package gets a `#` row. The second package keeps an old `#` row too. This is rare and adds rows; it loses nothing. Other reading: look up the stored component before choosing the key (an extra read per record).
- If a later revision of a record drops a package, its `#` row stays as it was. Today the same is true for a dropped record. Withdrawal handling is out of scope.
- The feed, the CVE page and `/v1/check` need no code change (grep evidence above). The tests prove each path. If a test shows otherwise, the fix goes in this PR.

## Sibling claims (not touched)

TCS-28 (CLI, skills, docs) and TCS-29 (php-runtime ingester) claim no file this plan edits. Open PR #31 (TCS-14) does not touch src/ingest/osv.ts.

## System invariants

(a) Cross-run state: `advisory_sources (source, source_id)` primary key. It is the natural unique key for each package row. No new store.
(b) External side effects: one OSV GET per record, unchanged. Each doc upserts in its own D1 batch. A failed batch throws out of the run, the page cursor is not written, and the next run retries the whole page. Idempotent keys make the retry safe. A record whose second doc fails validation keeps its first doc stored and reports the second in `errors`.
(c) Matcher negatives (the tests must include them): a disabled-ecosystem package (`NuGet/jQuery`) makes no row; a duplicate `(ecosystem, name)` entry makes no second row; a single-package record keeps exactly one row keyed `<OSV id>` with no `#` row (pinned against GO-2020-0001 from page1.json); an entry with an empty name makes no row.
(d) Neighbours: NVD, KEV and EPSS cron lanes read all rows per CVE (cve-page `group`, KEV `IN`), so they enrich every package row. `findByCve` excludes rows with an osv source, so a second package never merges into the first. Webhook delivery sees one more advisory per extra package, deduped per `(watchlist_id, advisory_id)`. The OSV `max_pages` and `page_size` caps count records, not docs. No lock or scheduler change.

## Requirements coverage

| Requirement | Task | Test |
|---|---|---|
| One advisory per (OSV id, package), own component, ranges, fixed_versions | T2 | osv-multi-package.tcs-46: "normalize: two docs with the right components and ranges" |
| First keeps `<OSV id>`, later get `<OSV id>#<eco>/<name>` | T2, T3 | osv-multi-package.tcs-46: "run: source ids" |
| Disabled ecosystem package is not stored | T2 | osv-multi-package.tcs-46: "normalize: NuGet entry yields no doc" |
| Existing single-package rows stay in place (additive) | T2 | osv-multi-package.tcs-46: "single-package record: one row, key unchanged"; osv.tcs-2 unchanged |
| Feed shows each as its own event | T3 | osv-multi-package.tcs-46: "feed: two events, distinct cursors" (GET /v1/events) |
| CVE page lists them all | T3 | osv-multi-package.tcs-46: "GET /cve/CVE-2020-11023 lists both" |
| /v1/check matches each package | T3 | osv-multi-package.tcs-46: "POST /v1/check jquery-rails is affected" |
| Re-read adds missing rows, first is unchanged | T3 | osv-multi-package.tcs-46: "re-read of a pre-change row adds the missing row" |
| Second run: unchanged twice | T3 | osv-multi-package.tcs-46: "second run: unchanged 2, upserted 0" |
| Go: module first, stdlib second answers go= | T2, T3 | go-runtime-multi.tcs-46 |
| Backfill (#32) uses the same path | T2 | n/a today: #32 is not built; it will call `normalizeOsv` and read `docs` |
| Out of scope: merging packages into one row | — | not built (negative: each package is its own row, tested above) |

## Acceptance tests

tests/ingest/osv-multi-package.tcs-46.test.ts (vitest, api project, osv fake, fetch spy = 0 calls):
1. normalize: `normalizeOsv(GHSA-jpcq-cgw6-v4j6-tcs46, DEFAULT_ECOSYSTEMS)` gives `docs.length === 2`: `[npm, jquery]` and `[RubyGems, jquery-rails]`. Each doc's `affected` and `fixed_versions` equal that package's own ranges from the fixture. `docs[0].source_id === "GHSA-jpcq-cgw6-v4j6-tcs46"`, `docs[1].source_id === "GHSA-jpcq-cgw6-v4j6-tcs46#RubyGems/jquery-rails"`. `doc === docs[0].doc`. No doc has component `jQuery` (NuGet).
2. normalize negatives: a duplicate `npm/jquery` entry added still gives 2 docs; an entry with name `""` gives no doc; GO-2020-0001 from page1.json gives 1 doc keyed `GO-2020-0001`.
3. run: through `osv.run` with the fake: first run `upserted === 2`, `errors === []`. `advisory_sources` has both source ids, pointing to 2 different advisory ids.
4. second run (cursor reset to 2000-01-01): `upserted === 0`, `unchanged === 2`.
5. re-read of a pre-change row: seed only the first doc with `upsertAdvisory(..., source_id "<id>")`, then `osv.run`: `upserted === 1`, `unchanged === 1`, both rows present.
6. feed: `GET /v1/events?...` returns both advisory ids as two events with different cursors.
7. CVE page: `GET /cve/CVE-2020-11023` with `Accept: application/json` lists both advisory ids.
8. check: `POST /v1/check` with `{ dependencies: [{ ecosystem: "RubyGems", name: "jquery-rails", version: "4.0.5" }] }` returns the second row's advisory id in `affected`.

tests/check/go-runtime-multi.tcs-46.test.ts:
9. GO-2022-0969-tcs46 reordered to x/net first, stdlib second, normalized with `["Go"]` and upserted per doc: `GET /v1/check?go=1.18.5` lists the stdlib row's advisory id; `go=1.19.1` (fixed) does not.

Regression risk: tests/ingest/osv.tcs-2.test.ts (normalize + run counts; the page1 fixture has only single-package records, checked), tests/check/go-runtime.tcs-40.test.ts, tests/ingest/upsert.tcs-2.test.ts, tests/routes/events.tcs-3.test.ts, tests/routes/check.tcs-9.test.ts, tests/routes/advisory-page.tcs-34.test.ts.

## QA screens

- `https://tocsin.sh/cve/CVE-2020-11023`: after an OSV run that reads GHSA-jpcq-cgw6-v4j6, the page lists `jquery` (npm) and `jquery-rails` (RubyGems).
- `POST https://tocsin.sh/v1/check` with `jquery-rails 4.0.5`: the GHSA is in `affected`.
- `GET https://tocsin.sh/v1/check?go=1.18.5`: GO-2022-0969 stdlib row is in `affected`.
No UI change; no browser screen work is needed.

## Design collision check (BH-5791)

Checked 4 listed and 0 derived symbols against main a627f293b6a2..a627f293b6a2 and 1 open PRs.
- `NormalizeResult` (function, listed): PR #31 106d954670e2, (text match). Resolution: combine.
- `run` (function, listed): PR #31 48fcdb4fa3ea, body or signature changed. Resolution: combine.

## Size

FILES: 1
LINES: 45
DIFF_KB: 22

KIND: bug
SIZE: S
