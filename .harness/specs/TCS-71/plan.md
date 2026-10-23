# Plan: TCS-71 (issue #71). OSV ecosystems with a suffix are dropped: match on the base name, re-run Packagist

## Ticket state
- Issue #71 is open and labeled `ai-build`. It has 0 comments. The body is the whole spec.
- `Blocked-by: #32 (hard)`: #32 is CLOSED (merged as 0fe8f34). The ticket is buildable.
- Already on main? `git log origin/main --since=2026-10-23T04:52:04Z` shows 0 commits. `normalizeOsv` on main (src/ingest/osv.ts:216) still does an exact `ecosystems.includes(ecosystem)` compare. Nothing is done on main.
- Duplicate check: no PR and no remote branch for TCS-71 (the `gh pr list --search TCS-71` hits are #70, #17, #59, #24, other tickets).

## Spec changes from comments
none

## Scope
1. `normalizeOsv` matches `affected[].package.ecosystem` on its base name (the part before the first `:`). The doc stores `ecosystem` as the base name (`Packagist`). The full OSV string goes in a new optional doc field `ecosystem_qualifier` (only when the OSV string has a suffix).
2. The cron (`osv.run`) and the import route (`POST /v1/internal/import`) both call the same `normalizeOsv`. No second code path.
3. The import route counts a record with no package in an enabled ecosystem as `skipped` (reason `ecosystem_not_enabled`), not as an error.
4. `/v1/check` for `Packagist drupal/permissions_by_term 8.x-1.0` returns the advisory. This needs the Composer comparator to read the Drupal legacy version form `8.x-1.0` as `1.0` (today `parseComposer` returns null, so the check answers `invalid_version`).
5. docs/BACKFILL.md gets the one-line operator step to re-run Packagist.
6. `scripts/launch-check.sh` `cov-count`: no change. The threshold stays at 90 percent.

Out of scope (ticket): enabling Debian, Alpine, Ubuntu (#38). No migration: `ecosystem_qualifier` lives in `doc_json` only, and the `advisories.ecosystem` column gets the base name, which already exists.

## Tasks

### T1. Base-name match and qualifier in `normalizeOsv` (src/ingest/osv.ts)
- Add `export function baseEcosystem(e: string): string` (the part before the first `:`; the whole string when there is no `:`).
- Add `export const NOT_ENABLED_REASON = "no affected package in a listed ecosystem"` and use it as the existing failure reason. The text does not change (tests/ingest/osv-multi-package.tcs-46.test.ts:134 pins it with `toEqual`).
- In the package loop (osv.ts:213-218): compute `base = baseEcosystem(raw)`. Keep the entry when `ecosystems.includes(base)`. Deduplicate packages on `(base, component)`. Keep the first raw string that has a suffix as the qualifier of that package.
- In the doc loop (osv.ts:235): filter `same` on `baseEcosystem(a.package?.ecosystem) === ecosystem`, so the ranges of the suffixed entry are read.
- The doc gets `ecosystem: base` and, when the raw string differs from the base, `ecosystem_qualifier: <full OSV string>`. A plain `Packagist` record gets no `ecosystem_qualifier` key (so every stored plain record stays byte-identical and its re-import stays `unchanged`).
- `osvSourceId(v.id, i, ecosystem, component)` takes the base name. Index 0 keeps the bare id, so `DRUPAL-CONTRIB-2017-082` gets source_id `DRUPAL-CONTRIB-2017-082`.
VALIDATE: npx vitest run tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts tests/ingest/osv.tcs-2.test.ts tests/ingest/osv-multi-package.tcs-46.test.ts
SATISFIES: "`normalizeOsv` matches on the base ecosystem (the part before the first `:`), stores `ecosystem` as the base name (`Packagist`), and keeps the full OSV string in ... a new optional `ecosystem_qualifier` field"

### T2. Schema field `ecosystem_qualifier` (schema/advisory.v1.json, src/schema/advisory.ts, generated validator)
- Add an optional property `ecosystem_qualifier` to schema/advisory.v1.json: `{ "description": "The full OSV ecosystem string when it has a suffix, for example Packagist:https://packages.drupal.org/8.", "type": "string", "minLength": 1 }`. Not in `required`.
- Add `ecosystem_qualifier?: string` to `interface Advisory` in src/schema/advisory.ts.
- Run `npm run gen:schema` to rewrite src/schema/advisory.validate.generated.js.
VALIDATE: npm run gen:schema -- --check && npx vitest run tests/unit/schema.tcs-1.test.ts tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts
SATISFIES: "a new optional `ecosystem_qualifier` field (schema addition, additive, nullable) so the Drupal repository is not lost"

### T3. Import route counts not-enabled records as skipped (src/routes/internal-import.ts)
- At internal-import.ts:176, when `!norm.ok && norm.reason === NOT_ENABLED_REASON`: `skipped += 1` and count it in a new answer field `skipped_reasons: { ecosystem_not_enabled: <n> }`. Do not push an error line. Any other failure reason stays an error.
- The backfill row `skipped` counter gets the count through the existing `BACKFILL_UPSERT_SQL` bind (no SQL change).
VALIDATE: npx vitest run tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts tests/backfill/import.tcs-32.test.ts tests/routes/internal-import.tcs-32.test.ts
SATISFIES: "a `Debian:12` record is dropped while Debian is not enabled (and is counted as skipped with reason `ecosystem_not_enabled`)"

### T4. One function for cron and import
- No new code: both callers already import `normalizeOsv` (src/ingest/osv.ts:300 and src/routes/internal-import.ts:175). The test drives both entry points with the Drupal fixture (D2).
VALIDATE: npx vitest run tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts -t "cron"
SATISFIES: "The cron and the import route both use it (one function)."

### T5. Drupal legacy version form in the Composer comparator (src/check/match/composer.ts)
- In `parseComposer`, strip one leading Drupal core prefix `^\d+\.x-` before the regex runs (`8.x-1.0` reads as `1.0`). The packages.drupal.org/8 Composer facade uses the same mapping. A string with this prefix is invalid Composer today, so the change only turns a former `invalid_version` into a real compare. No other version string changes.
VALIDATE: npx vitest run tests/check/composer-drupal.tcs-71.test.ts tests/check/match.tcs-5.test.ts
SATISFIES: "`/v1/check` for `Packagist drupal/permissions_by_term 8.x-1.0` returns the advisory."

### T6. Operator step in docs/BACKFILL.md
- Add a section "Re-run one ecosystem after a normalizer change". One line: run the `backfill` workflow again with `ecosystem=Packagist`. The row has `done_at`, so the script reads the whole zip again and sends `start: true`, which resets the counters (osv-import.mjs:113-125). The 6,530 stored records count as `unchanged`; the 670 `DRUPAL-*` records land as `imported`. The cron picks up new ones from then on.
- Add one line under "Run" that a record with no package in an enabled ecosystem counts as `skipped` (reason `ecosystem_not_enabled` in the answer).
VALIDATE: grep -n "Re-run one ecosystem" docs/BACKFILL.md && grep -n "ecosystem_not_enabled" docs/BACKFILL.md
SATISFIES: "Re-run the Packagist backfill with the reset flag (...; document the one-line operator step in docs/BACKFILL.md)"

## Files to touch
- src/ingest/osv.ts
- src/routes/internal-import.ts
- src/check/match/composer.ts
- src/schema/advisory.ts
- schema/advisory.v1.json
- src/schema/advisory.validate.generated.js (generated by `npm run gen:schema`)
- docs/BACKFILL.md
- tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts (new)
- tests/check/composer-drupal.tcs-71.test.ts (new)
- tests/fixtures/osv/drupal-contrib-2017-082.tcs-71.json (new: the recorded OSV record, fetched 2026-10-23 from api.osv.dev, `details` kept as recorded)
- tests/fixtures/osv/debian-12.tcs-71.json (new: a minimal OSV record with one `Debian:12` package; source: assumed shape, same keys as the Drupal record)

## Tests that must change
None

## Verify (run, not edited)
- npm test
- npm run typecheck
- npm run gen:schema -- --check
- tests/ingest/osv.tcs-2.test.ts, tests/ingest/osv-multi-package.tcs-46.test.ts, tests/backfill/import.tcs-32.test.ts, tests/routes/internal-import.tcs-32.test.ts, tests/check/match.tcs-5.test.ts, tests/routes/check.tcs-9.test.ts, tests/unit/schema.tcs-1.test.ts (regression risk; unchanged)
- scripts/launch-check.sh (no edit; prod `COVERAGE_CHECK=1` run is the operator gate after the re-run)

## Changed symbols
- function `normalizeOsv`: matches `affected[].package.ecosystem` on the base name; adds `ecosystem_qualifier` to the doc when the OSV string has a suffix. callers: left alone: `osv.run` (src/ingest/osv.ts) and the import POST handler call it with the same signature and result shape.
- function `baseEcosystem` (new): the part of an OSV ecosystem string before the first `:`.
- function `parseComposer`: reads a leading Drupal `N.x-` prefix. callers: left alone: `composerComparator` (Packagist and php) keeps its interface.
- route `POST /v1/internal/import`: a not-enabled record counts as `skipped`, and the answer gains `skipped_reasons`.
- format `schema/advisory.v1.json`: new optional property `ecosystem_qualifier`.

## Design collisions
- Open PRs #70 (TCS-64), #68 (TCS-11), #67 (TCS-66) change none of the symbols above. None of them touch src/ingest/osv.ts, src/routes/internal-import.ts, src/check/match/composer.ts or the advisory schema.
- `schema/advisory.v1.json` (PR #70, bd89acb3c823, TCS-64): combine — the match is text only. bd89acb rewrites the one-line `DOCS_HTML` string in site/docs.generated.ts (key confirm, rotate and mail limits in docs/API.md), and that line holds the existing link `/schema/advisory.v1.json`. It does not edit schema/advisory.v1.json, src/schema/advisory.ts or the generated validator, so T2 adds `ecosystem_qualifier` on top with no overlap.
- `schema/advisory.v1.json` (PR #68, dca953f2a735, TCS-11): combine — the match is text only. dca953f rewrites the same `DOCS_HTML` line (watch-list delivery text) and adds the SQL column `advisories.exploited_at` (migration 0018), not a JSON-schema property. It does not edit schema/advisory.v1.json, so T2's optional property is independent of it.

## Sibling claims (not touched)
- /root/harness/state/claims/tocsin/ is empty at plan time. Open PRs #70 and #68 edit docs/API.md and site/docs.generated.ts; this plan does not edit those files (see ASSUMPTIONS).

## Edge cases
- A record with both `Packagist` and `Packagist:https://packages.drupal.org/8` for the same name: one doc; the ranges of both entries; the qualifier from the suffixed entry.
- An ecosystem string with more than one `:` (`Maven:https://repo.example/x`): the base is `Maven`; the qualifier keeps the whole string.
- An ecosystem string that starts with `:` or is `"Packagist:"`: base is `""` or `Packagist`. `""` never matches an enabled entry. `"Packagist:"` gets the qualifier `Packagist:`; the test pins this.
- A config `ecosystems` entry with a suffix (`Debian:12`): it never matches a base name. Today no config row has a suffix (DEFAULT_ECOSYSTEMS and the seed row 0002 list base names). See ASSUMPTIONS.
- The import route's `oldest` (coverage_since) check compares `d.doc.ecosystem === body.ecosystem`. Drupal docs now carry `Packagist`, so they count for Packagist coverage. This is correct.
- A plain record already stored: its doc gets no new key, so `canonicalJson` is equal and the re-import is `unchanged`. The test pins this with an existing-shape Packagist record.
- `8.x-` prefix on a non-Drupal Packagist version: such a string was `invalid_version` before; it now compares as the part after the prefix. The test pins `1.0.0`, `v1.2` and `dev-main` as unchanged results.

## Iron laws
- Additive schema (repo rule 1): one optional JSON-schema property. No SQL migration, no column change.
- Indexes and retention (rule 2): no new table and no new query. The check reads through the existing `idx_advisories_component_ecosystem`.
- Idempotent on `(source, source_id)` (rule 3): source_id of a suffixed record is the bare OSV id; the test runs the import twice and asserts `unchanged` the second time and 1 row in `advisory_sources`.
- DB-driven config (rule 5, BH-7945): the enabled list stays the `sources.osv.config_json` row. This plan adds no limit, rate, threshold or timeout. `COV_MIN_PCT` stays 90.
- Deterministic (rule 6): no LLM. No De-AI surface.
- Dedup before spend (rule 7): no metered call is added. The backfill reads the public OSV bucket.
- Feed reads (rule 8): no change.
- No secrets (rule 9): fixtures carry no token.
- UI rules (sortable headers, list over cards, drill-down, mobile): no UI change in this ticket.
- RLS: not Supabase (D1). No table.
- Build discipline that bites: D1/D63 (prove each test red on main first, and by mutation: revert the base-name match and watch the suffix test go red), D2 (one test through `POST /v1/internal/import` and one through `osv.run` and one through `/v1/check`), D4 (the Drupal fixture is the recorded OSV record, not a hand shape), D5 (BACKFILL.md says only what the code does), D8 (the prod re-run is a human step in the PR body), D11 (a not-enabled record is `skipped`, a malformed one is still an error), D62 (no existing assertion changes), D67 (the PR body uses `Refs #71`, because the prod re-run and the prod `cov-count` gate are not in this PR).

## Performance
- No screen and no loader change. `/v1/check` keeps its reads and statement count. The import route keeps one `STORED_MODIFIED_SQL` read per request.

## ASSUMPTIONS
- Qualifier storage: the ticket allows `sources[].url` or a new `ecosystem_qualifier` field. I picked the field, because `sources[].url` is the osv.dev link and a repository URL there would be wrong data. Other reading: put it in `sources[].url`, which needs no schema change.
- No new reset flag: the ticket says "the import route's reset input". The route already has `start: true`, and the script sends it on any run after `done_at`. I document that as the reset. Other reading: add a `--reset` script input; it would do the same thing.
- Cron behaviour for a not-enabled record stays an error line (tests/ingest/osv.tcs-2.test.ts:280 pins it). Only the import route moves it to `skipped`, because the ticket's skip count is the backfill count. Other reading: drop the cron error line too; that changes another ticket's test.
- `8.x-1.0` support: the ticket's acceptance test uses the Drupal legacy form, and `parseComposer` rejects it today. I add the prefix strip in the comparator. Other reading: test with `1.0.0` only and leave the comparator alone; the acceptance line would then not hold as written.
- Config entries are base names. A config entry with a suffix does not match. Other reading: match the full string as well; no row needs that today.
- docs/API.md field table: not edited, because open PRs #70 and #68 edit docs/API.md and the generated site/docs.generated.ts. The new field is described in schema/advisory.v1.json, which /schema/advisory.v1.json serves. Other reading: add the row now and take the merge conflict.

## Reproduction
REPRO: npx vitest run tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts
OBSERVED: `normalizeOsv(<DRUPAL-CONTRIB-2017-082>, ["Packagist", ...])` returns `{ ok: false, reason: "no affected package in a listed ecosystem" }`; the import route lists the record in `errors` and counts it in neither `imported` nor `skipped`; `/v1/check` for `drupal/permissions_by_term` returns no finding.
EXPECTED: one advisory with ecosystem `Packagist`, component `drupal/permissions_by_term`, affected `[{ introduced: "0", fixed: "1.35.0" }]`, `ecosystem_qualifier` `Packagist:https://packages.drupal.org/8`; a `Debian:12` record counts as `skipped`; a second import is `unchanged`; `/v1/check` returns the advisory for `8.x-1.0`.
ROOT CAUSE: src/ingest/osv.ts:216 (`!ecosystems.includes(ecosystem)` is an exact compare on the full OSV string), plus src/ingest/osv.ts:235 (the same exact compare when it collects ranges), plus src/check/match/composer.ts:6 (the Composer regex rejects `8.x-1.0`).
BLAST RADIUS: `normalizeOsv` callers: `osv.run` (src/ingest/osv.ts, the cron through src/ingest/registry.ts) and the POST handler in src/routes/internal-import.ts (the backfill through scripts/backfill/run.mjs). `parseComposer` callers: `composerComparator` in src/check/match/composer.ts, used for `Packagist` and `php` in src/check/match/index.ts, which serves `/v1/check` (src/routes/check.ts) and the MCP check tool. CodeGraph is not available on this box; the list comes from grep.

## Failure modes
- Decision rule: the OSV ecosystem match keeps an `affected[]` entry when `baseEcosystem(raw)` (the part before the first `:`) equals an enabled config entry, with an exact, case-sensitive compare. Keep cases: `Packagist` (plain, live main data), `Packagist:https://packages.drupal.org/8` (the recorded DRUPAL-CONTRIB-2017-082), `Packagist:` (edge: empty suffix, source: assumed), a record with both `Packagist` and the suffixed string for one name (one doc, source: assumed). Drop cases (near misses): `Debian:12`, `Alpine:v3.18`, `Ubuntu:22.04` (not enabled, source: assumed), `Maven:https://repo.example/x` (more than one `:`, base not enabled, source: assumed), `PackagistX` (prefix match), `packagist` (case differs), `:Packagist` (empty base), an entry with no `name`. No case has an unknown side. Test: osv-ecosystem-suffix.tcs-71 "normalize" cases plus the negative-list table (System invariants c); composer-drupal.tcs-71 for the `N.x-` version rule (`8.x-1.0` reads as `1.0`; `1.0.0`, `v1.2`, `1.0-beta2` unchanged; `dev-main`, `8.x-dev` invalid).
- Exit paths: the import route has three exits per record. A normalized record goes to `imported`/`unchanged` as today. A record with reason `NOT_ENABLED_REASON` goes to `skipped` and `skipped_reasons.ecosystem_not_enabled`, with no error line. Any other failure reason stays an error line. A D1 error still throws a 500 before the backfill row moves, so no counter moves on that path. The plan adds no wait state, lock, marker or attempt counter. Test: osv-ecosystem-suffix.tcs-71 "import route" case (`skipped: 1`, `errors: []`, backfill row `skipped` = 1) and the existing tests/routes/internal-import.tcs-32.test.ts error cases stay green.
- Writer/reader round-trip: two new formats. (1) `ecosystem_qualifier` in `doc_json`: writer `normalizeOsv`; readers `validateAdvisory` (schema/advisory.v1.json plus the generated validator), `canonicalJson` in the upsert (a plain record has no key, so it stays `unchanged`), and the feed and `/schema/advisory.v1.json` that serve the doc as stored. (2) `skipped_reasons` in the import answer: writer the import POST handler; reader scripts/backfill/osv-import.mjs logs the answer and reads only `skipped` for the row, which does not change. Test: osv-ecosystem-suffix.tcs-71 normalize case (doc passes `validateAdvisory`), the second import POST answers `unchanged: 1`, and `npm run gen:schema -- --check`.
- Alert or freeze blast radius: n/a — the plan adds no alert, page or freeze. A not-enabled record moves from an error line to a skip count, which removes noise and adds none.
- Defaults in prod: n/a — the plan adds no knob. The enabled list stays the `sources.osv.config_json` row, and `COV_MIN_PCT` stays 90.
- Status evidence: the import answer `skipped` and `skipped_reasons.ecosystem_not_enabled` count only records whose `normalizeOsv` result is `{ ok: false, reason: NOT_ENABLED_REASON }`. `/v1/status` coverage reads `imported + unchanged` from the backfill row, which only real upserts move. The prod `cov-count` pass is a human step after the re-run, and the PR uses `Refs #71`, so this PR claims no "done" for it. Test: osv-ecosystem-suffix.tcs-71 "import route" case asserts `imported: 1`, `skipped: 1`, `errors: []` and the backfill row counts.

## System invariants
- (a) Cross-run state: the existing `backfill` row (PK `ecosystem`) and `advisory_sources` (PK `(source, source_id)`). No new store.
- (b) External side effects: none new. The import route writes D1 only; a D1 error still throws a 500 before the backfill row moves.
- (c) Negative list for the matcher (records that must NOT produce a Packagist advisory): `Debian:12`, `Alpine:v3.18`, `Ubuntu:22.04`, `Maven:https://repo.example/x`, `PackagistX`, `packagist` (case differs), `:Packagist`, and an entry with no `name`. The suffix test asserts each.
- (d) Neighbors: the OSV cron lane (same function, same caps `page_size`/`max_pages`), the backfill workflow (same route, same `import.max_batch`), `/v1/status` coverage (reads `imported + unchanged` from the backfill row; a re-run counts the Drupal records), `scripts/launch-check.sh` `cov-count` (reads `/v1/status`; threshold unchanged). Upsert cross-source merge (src/ingest/upsert.ts `merge`) keys on `(cve_primary, ecosystem, component)`: Drupal docs now carry `Packagist` and can merge with a GHSA doc of the same package and CVE, which is the right result.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| Match on base ecosystem (before the first `:`) | T1 | osv-ecosystem-suffix.tcs-71: Drupal record normalizes; negative list does not |
| Store `ecosystem` as the base name `Packagist` | T1 | osv-ecosystem-suffix.tcs-71: doc.ecosystem and `advisories.ecosystem` column = `Packagist` |
| Keep the full OSV string (qualifier) | T1, T2 | osv-ecosystem-suffix.tcs-71: `ecosystem_qualifier`; schema validates it |
| Component `drupal/permissions_by_term`, ECOSYSTEM range | T1 | osv-ecosystem-suffix.tcs-71: component and `affected` |
| Additive, nullable schema field | T2 | schema.tcs-1 stays green; suffix test validates a doc with and without the field |
| Cron and import use one function | T4 | osv-ecosystem-suffix.tcs-71: cron case and import case on the same fixture |
| `Debian:12` dropped while not enabled, counted as skipped `ecosystem_not_enabled` | T3 | osv-ecosystem-suffix.tcs-71: import answer `skipped: 1`, `skipped_reasons.ecosystem_not_enabled: 1`, `errors: []` |
| Negative: a suffixed record is no longer dropped with no skip count | T1, T3 | osv-ecosystem-suffix.tcs-71: Drupal record not in `errors` |
| Second run is `unchanged` | T1 | osv-ecosystem-suffix.tcs-71: second POST `unchanged: 1`, one `advisory_sources` row |
| `/v1/check` Packagist drupal/permissions_by_term 8.x-1.0 returns the advisory | T5 | osv-ecosystem-suffix.tcs-71 (route) + composer-drupal.tcs-71 (comparator) |
| Operator step to re-run Packagist in docs/BACKFILL.md | T6 | grep check (VALIDATE of T6) |
| Prod gate: `cov-count` passes after the re-run | none in this PR (human step after merge) | not testable here; PR body carries the step and the PR uses `Refs #71` |
| Keep `cov-count` at 90 percent | no edit | scripts/launch-check.sh unchanged in the diff |
| Out of scope: Debian/Alpine/Ubuntu enabling | no task | the Debian record stays skipped |

## Acceptance tests
- `tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts`
  - normalize: the recorded `DRUPAL-CONTRIB-2017-082` with the default ecosystems gives one doc: `ecosystem` `Packagist`, `component` `drupal/permissions_by_term`, `affected` `[{introduced:"0", fixed:"1.35.0"}]`, `fixed_versions` `["1.35.0"]`, `ecosystem_qualifier` `Packagist:https://packages.drupal.org/8`, `sources[0].source_id` `DRUPAL-CONTRIB-2017-082`. The doc passes `validateAdvisory`.
  - normalize: a plain Packagist record gets no `ecosystem_qualifier` key.
  - normalize: each record of the negative list (System invariants c) returns `{ ok: false, reason: NOT_ENABLED_REASON }` with `["Packagist"]` enabled.
  - normalize: one record with both `Packagist` and the suffixed string for the same name gives one doc with the ranges of both entries.
  - import route: POST `{ ecosystem: "Packagist", records: [drupal, debian12], ... }` with the bearer fixture token answers `imported: 1`, `skipped: 1`, `skipped_reasons: { ecosystem_not_enabled: 1 }`, `errors: []`; the backfill row `skipped` is 1; the `advisories` row has column `ecosystem` = `Packagist`.
  - import route: the same POST a second time (new `last_id` order kept) answers `unchanged: 1`, `inserted: 0`, and `advisory_sources` has 1 row for `('osv', 'DRUPAL-CONTRIB-2017-082')`.
  - cron: `osv.run` with the OSV fake (tests/ingest/osv-fake.ts) listing the Drupal id in the Packagist CSV upserts 1 advisory with `ecosystem` `Packagist` and no error line.
  - check route: after the import, POST `/v1/check` with `dependencies: [{ ecosystem: "Packagist", name: "drupal/permissions_by_term", version: "8.x-1.0" }]` lists the advisory in `affected` with `fixed_in` `1.35.0`; version `1.35.0` lists no finding.
- `tests/check/composer-drupal.tcs-71.test.ts`
  - `parseComposer("8.x-1.0")` equals `parseComposer("1.0")`; `8.x-1.34` < `1.35.0`; `1.0.0`, `v1.2`, `1.0-beta2` keep their old results; `dev-main` and `8.x-dev` stay invalid.
- Regression risk: tests/ingest/osv.tcs-2.test.ts, tests/ingest/osv-multi-package.tcs-46.test.ts, tests/backfill/import.tcs-32.test.ts, tests/routes/internal-import.tcs-32.test.ts, tests/check/match.tcs-5.test.ts, tests/routes/check.tcs-9.test.ts, tests/unit/schema.tcs-1.test.ts, tests/mcp/* (the MCP check tool uses the same matcher).

## QA screens
- No browser screen changes. API checks after deploy and the Packagist re-run:
  - `GET https://tocsin.sh/v1/status`: the Packagist `coverage[].imported` is about 7,200 (was 6,530).
  - `POST https://tocsin.sh/v1/check` with the Drupal dependency above: the advisory is in `affected`.
  - `COVERAGE_CHECK=1 bash scripts/launch-check.sh`: `ok cov-count`.

```pr-body-requires
Refs #71 <- D67: the prod re-run and the prod cov-count gate are not in this PR
Re-run the Packagist backfill <- T6 / ticket scope 3 (operator step after deploy)
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Design collision check (BH-5791)

Checked 5 listed and 0 derived symbols against main 41c4549a09d1..41c4549a09d1 and 3 open PRs.
- `schema/advisory.v1.json` (function, listed): PR #70 bd89acb3c823, (text match). Resolution: combine.
- `schema/advisory.v1.json` (function, listed): PR #68 dca953f2a735, (text match). Resolution: combine.

## Size
FILES: 5
LINES: 70
DIFF_KB: 30

KIND: bug
SIZE: S
