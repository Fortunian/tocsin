# TCS-75 plan: OSV action names every fixed line; a check item names the matched line's fix

Ticket: Fortunian/tocsin#75. Blocked-by #2 is CLOSED. The thread has 0 comments, so the issue body is the spec.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-23T13:01:59Z -- src/ingest/osv.ts src/check/run.ts` shows no commit that touches the action. Main still has `const lowest = [...fixed].sort(compareVersions)[0]` at `src/ingest/osv.ts:256` and `action: a.action` at `src/check/run.ts:102`.

CodeGraph is NOT AVAILABLE on this box. I found the callers with grep (evidence below).

## Spec changes from comments

none

## Scope

1. `normalizeOsv` writes one action sentence that names each fixed line when a package has 2 or more distinct fixed versions. The form is the form the Node ingester uses (`src/ingest/node-runtime.ts:137`): "Upgrade undici to 6.28.1 (6.x), 7.29.1 (7.x) or 8.10.2 (8.x) or later." If the text is over 200 chars, or the lines cannot be named, the action is "Upgrade undici to the fixed version for your line (see fixed_versions)." One fixed version gives the same text as today. No fixed version gives the same `NO_FIX` text as today.
2. `/v1/check` affected items get a per-match `action`. For an OSV-created advisory with 2 or more distinct fixed versions, and a non-null `fixed_in`, the action is `Upgrade <component> to <fixed_in> or later.` In every other case the item keeps the stored `action`. The Action (`action/check.mjs:291`) and the CLI (`packages/cli/src/check.ts:153`) already print `item.action`, so they need no change.
3. No backfill. Stored rows get the new text on the next OSV re-read, through the normal upsert.

Live data (curl to api.osv.dev at planning time, GHSA-rfgv-xxqx-mfg5, modified 2026-09-29T18:30:41Z): undici has 3 SEMVER ranges: 6.7.0→6.28.1, 7.0.0→7.29.1, 8.0.0→8.10.2. GHSA-3wwx-pv8p-q78v and GHSA-r53p-7pc4-xj5r have the same 3 fixes.

## ASSUMPTIONS

- Number of lines. The ticket example names 2 lines (6.x, 7.x). The recorded record has 3 (6.x, 7.x, 8.x). I assume the sentence names every fixed line, so the undici test asserts 3 parts. The other reading (only 2 lines) would drop a real fix, so I reject it.
- Line labels. The ticket shows "(6.x)" and "(7.x)" but gives no rule. I assume: label each fix with its first numeric segment ("6.x"). If 2 fixes have the same first segment, use the first two segments ("1.21.x", "1.22.x", as for Go stdlib). If the labels are still not distinct, or a needed segment is not all digits (for example a Debian epoch "1:2.3-4"), use the fallback sentence. The other reading (always major.minor) gives "6.28.x" for undici, which does not match the ticket.
- Order. Parts go in ascending version order (`compareVersions`), the same as the Node ingester. The ticket example is ascending too.
- An open line (a range with no fix) is not named in the sentence. This matches the Node ingester. The other reading would add "no fix for 9.x"; the ticket does not ask for it.
- Per-match scope. The ticket names `normalizeOsv` and OSV records. I apply the per-match action only when `sources[0].source === "osv"` (the creator owns `action`, `src/ingest/upsert.ts:78`). Runtime advisories (node, php, python, deno, bun) keep their stored line-by-line text. Reason: the Python action carries a "fix is not released yet" note (`src/ingest/python-runtime-normalize.ts:150`), and the PHP action carries an "unsupported lines get no fix" note. A generic rewrite would drop those notes and could point a user to an unreleased Python. `tests/cron/runtime-ingest.tcs-6.test.ts:107` pins the Node multi-line text on a check item and stays green. The other reading (all sources) is a follow-up if wanted.
- Per-match only for 2 or more distinct fixes. With 1 fix the stored text is already right. This keeps `tests/routes/check.tcs-9.test.ts:170` (a fixture action "Upgrade tcs9-vuln-fixture.") unchanged.
- The per-match fix is the existing `fixed_in` (`lowestFixedAbove`, `src/check/match/index.ts:66`). The ticket calls `fixed_in` "the matched range's fix". I do not change how `fixed_in` is computed.
- "pages print that one": the advisory page (`site/advisory.ts:99`) and the landing table (`site/landing.ts:31`) show one advisory, not a match. They print the stored action, which item 1 fixes. No page change. No page renders check items (grep for `fixed_in` in `site/` and `src/site/` finds only `site/docs.generated.ts`).
- Go toolchain view (`src/check/go-runtime.ts:19`) keeps `sources`, so a `go=` check of a multi-fix stdlib advisory says "Upgrade go to 1.22.5 or later." This is correct for the runtime view.
- No docs change. `docs/API.md:88` says the action is "computed from the data", which stays true. A doc edit forces a regenerate of `site/docs.generated.ts`, which open PR #79 also edits.

## Changed symbols

- function `normalizeOsv` (`src/ingest/osv.ts`): the `action` of a package with 2 or more fixes names each line; the `lowest` local goes away. callers: left alone: `src/ingest/osv.ts` run loop and `src/routes/internal-import.ts` only read `docs`; the doc shape does not change.
- function `osvAction` (new, `src/ingest/osv-action.ts`): builds the sentence from component and fixed list.
- function `matchAction` (new, `src/check/action.ts`): picks the item action from advisory and `fixed_in`.
- function `runCheck` (`src/check/run.ts`): `AffectedItem.action` comes from `matchAction`. callers: left alone: `src/routes/check.ts:52` passes the result through unchanged.
- format `AffectedItem.action` (`/v1/check` JSON): value changes for OSV multi-fix advisories only; type unchanged.

## Design collisions

- `normalizeOsv`: combine — open PR #79 (TCS-38) edits the packages loop and `source_id` in the same `docs.map` block but does not touch the `lowest` or `action:` lines. This ticket changes only those two lines and moves the text into a new file, so the two diffs combine as a clean 3-way merge.
- `runCheck`: combine — PR #79 changes `groupKey` and the candidate lookup. This ticket changes only the `action:` field of the pushed item and adds one import. No shared line.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at planning time.

## Files to touch

- `src/ingest/osv-action.ts` (new): `osvAction(component: string, fixed: string[]): string`.
- `src/ingest/osv.ts`: import `osvAction`; replace lines 256 and 271 with `action: osvAction(component, fixed)`.
- `src/check/action.ts` (new): `matchAction(a: Advisory, fixed_in: string | undefined): string`.
- `src/check/run.ts`: import `matchAction`; line 102 `action: matchAction(a, r.fixed_in)`.
- `tests/fixtures/osv/undici-multi-range.tcs-75.json` (new): the GHSA-rfgv-xxqx-mfg5 record, recorded verbatim from `https://api.osv.dev/v1/vulns/GHSA-rfgv-xxqx-mfg5`, plus a `SOURCES` note (URL and fetch time) in the test file header.
- `tests/ingest/osv-multi-range-action.tcs-75.test.ts` (new).
- `tests/check/per-match-action.tcs-75.test.ts` (new).
- `tests/ingest/osv.tcs-2.test.ts` (3 rows of `EXPECTED_ACTION`, see below).

## Tests that must change

- `tests/ingest/osv.tcs-2.test.ts`: the premise "action = lowest fixed version" changes for records with 2 or more fixes. Rows change: `GHSA-fhjf-83wg-r2j9` → "Upgrade mixin-deep to 1.3.2 (1.x) or 2.0.1 (2.x) or later."; `GO-2024-2963` → "Upgrade stdlib to 1.21.12 (1.21.x) or 1.22.5 (1.22.x) or later."; `GHSA-9qj7-jvg4-qr2x` → "Upgrade passenger to 3.0.21 (3.x) or 4.0.5 (4.x) or later.". The comment on line 19 changes to say this. All other rows stay.

## Tasks

### T1. `osvAction` in a new file, used by `normalizeOsv`
- Distinct fixed versions, sorted with `compareVersions` (import from `./osv`; `osv.ts` imports `osvAction`, a cycle on functions only, called at run time, is safe; if the builder prefers, move nothing and pass the comparator in as a parameter instead).
- 0 fixes → `"No fix published. Pin and monitor."` (the same text as `NO_FIX`; export `NO_FIX` from the new file and import it in `osv.ts` so there is one copy).
- 1 fix → `Upgrade ${component} to ${f} or later.` passed through the same 200-char one-line cut as today.
- 2+ fixes → labels at depth 1, else depth 2, else fallback. Text `Upgrade ${component} to ${parts.slice(0,-1).join(", ")} or ${last} or later.` with part `${f} (${label}.x)`. If over 200 chars, or no distinct labels → `Upgrade ${component} to the fixed version for your line (see fixed_versions).`, cut to 200.
- The 200 is the schema limit (`schema/advisory.v1.json:100`, "max 200 chars"), the same literal `oneLine` uses today. It is a format bound, not a business knob.
VALIDATE: npx vitest run tests/ingest/osv-multi-range-action.tcs-75.test.ts tests/ingest/osv.tcs-2.test.ts tests/ingest/osv-multi-package.tcs-46.test.ts tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts
SATISFIES: Scope 1 "normalizeOsv writes the action as the Node ingester does for lines ... capped at 200 chars with the fallback"

### T2. `matchAction` in a new file, used by `runCheck`
- Return `Upgrade ${a.component} to ${fixed_in} or later.` (cut to 200) only when all 3 hold: `a.sources[0]?.source === "osv"`, `fixed_in !== undefined`, and the distinct set of `a.affected[].fixed` plus `a.fixed_versions` has 2 or more members. Else return `a.action`.
VALIDATE: npx vitest run tests/check/per-match-action.tcs-75.test.ts tests/routes/check.tcs-9.test.ts tests/cron/runtime-ingest.tcs-6.test.ts tests/check/go-runtime.tcs-40.test.ts tests/check/go-runtime-multi.tcs-46.test.ts
SATISFIES: Scope 2 "/v1/check items carry a per-match action computed from the matched range (\"Upgrade undici to 7.29.1 or later.\"), and the Action/CLI/pages print that one"

### T3. Update the 3 pinned rows in `tests/ingest/osv.tcs-2.test.ts`
VALIDATE: npx vitest run tests/ingest/osv.tcs-2.test.ts
SATISFIES: Scope 1 (the spec change for multi-fix records that the old test pinned)

### T4. Full contract
VALIDATE: npm run typecheck && npm test
SATISFIES: CLAUDE.md verification contract ("A ticket is done when its acceptance tests fail before the change and pass after it")

## Edge cases

- Duplicate fixes across `affected` entries of one package: `rangesOf` already dedups `fixed`.
- 2 fixes in the same major (Go 1.21.12, 1.22.5): depth-2 labels.
- 2 fixes in the same major.minor (1.2.3, 1.2.4): fallback sentence.
- Pre-release fix ("2.0.0-rc.1") with "2.0.1": labels collide at depth 1 and 2 → fallback.
- Non-digit segment (Debian "1:2.3-4", pseudo-version only matters if 2+ fixes): fallback.
- Long component name: the one-line cut still holds the 200 cap (schema validation in `upsertAdvisory` would refuse a longer one).
- Check: dep version below all ranges' fixes but in no range → not affected, no item.
- Check: dep in an open-ended range (no fix above it) → `fixed_in` undefined → stored action.
- Check: OSV advisory with 1 fix → stored action (tcs-9 pin).
- Check: KEV/EPSS enrichment does not take `sources[0]` (`src/ingest/upsert.ts:73`), so an enriched OSV row still gets the per-match action.

## Iron laws

- Sortable headers, list-over-cards, drill-down, mobile, native dialogs: no UI change. n/a.
- DB-driven config: no new knob. The 200 cap is the schema's own field limit.
- Schema/RLS/indexes/retention: no migration, no new table, no new query. n/a.
- No per-row correlated subquery: no SQL change.
- Dedup before spend: no metered call. The OSV fetch path does not change.
- De-AI / no LLM: text is deterministic from the record (repo rule 6 and 10).
- Idempotent ingest (repo rule 3): the doc for a record is a pure function of the record, so a re-run writes the same text; the upsert key does not change.
- Performance: `runCheck` keeps 1 `db.batch`; `matchAction` is pure, O(ranges) per hit. Statement count unchanged. No screen or loader change.
- Scalable tests: no vendor call in tests. The OSV record is a recorded fixture; no network in the PR suite.

Build discipline rules that bite: D1 (mutation: revert `run.ts:102` to `a.action` and the check test must go red; revert to `lowest` and the ingest test must go red), D2 (the check test goes through `POST /v1/check` on the worker, not only the pure helper), D4 (the fixture is a real OSV record; the check test seeds the doc that `normalizeOsv` produces from it), D5 (no comment claims behavior the code does not have), D6 (true exit codes), D25 (surgical: only the listed files), D34 (INTENT line: the ticket body).

## Verify (run, not edited)

- `npm run typecheck`
- `npm test`
- `tests/cron/runtime-ingest.tcs-6.test.ts` (runtime multi-line action on a check item must stay)
- `tests/routes/check.tcs-9.test.ts` (single-fix stored action must stay)
- `tests/routes/advisory-page.tcs-34.test.ts`, `tests/routes/site.tcs-10.test.ts` (pages print the stored action)
- `tests/action/check.tcs-33.test.ts`, `tests/cli/check-summary.tcs-28.test.ts`, `tests/mcp/tools.test.ts`

## Reproduction

REPRO: npx vitest run tests/ingest/osv-multi-range-action.tcs-75.test.ts tests/check/per-match-action.tcs-75.test.ts
OBSERVED: `normalizeOsv` on GHSA-rfgv-xxqx-mfg5 gives action "Upgrade undici to 6.28.1 or later."; `POST /v1/check` for undici 7.29.0 gives an item with `fixed_in` "7.29.1" and `action` "Upgrade undici to 6.28.1 or later."
EXPECTED: stored action "Upgrade undici to 6.28.1 (6.x), 7.29.1 (7.x) or 8.10.2 (8.x) or later."; the 7.29.0 item action "Upgrade undici to 7.29.1 or later."; the 6.20.0 item action "Upgrade undici to 6.28.1 or later."
ROOT CAUSE: src/ingest/osv.ts:256 (`const lowest = [...fixed].sort(compareVersions)[0]`, used at src/ingest/osv.ts:271 as the only version in the action) and src/check/run.ts:102 (`action: a.action`, the stored text, not the match)
BLAST RADIUS: `normalizeOsv` is called by the OSV cron ingester (`src/ingest/osv.ts` run) and `src/routes/internal-import.ts` (backfill import); every OSV advisory doc, the feed `/v1/events`, `/advisories/{id}` (`site/advisory.ts:99`), the landing table (`site/landing.ts:31`) and MCP tools read the stored action. `runCheck` is called by `src/routes/check.ts:52` (GET and POST `/v1/check`); its items reach the GitHub Action (`action/check.mjs:291`), the CLI (`packages/cli/src/check.ts:153`) and the MCP check tool. Grep evidence; CodeGraph not available.

The two test files do not exist yet. The executor writes them first and records them red against the merge base (both fail on the asserted strings above).

## System invariants

None beyond the iron laws. This is a pure text change on 2 code paths with no new state, no side effect, no query and no scheduler; the store (`advisories.doc_json`) and its upsert key do not change.

## Requirements coverage

| Requirement (ticket) | Task | Test |
|---|---|---|
| Multi-range OSV action names each line's fix ("6.28.1 (6.x) or 7.29.1 (7.x) or later") | T1 | `tests/ingest/osv-multi-range-action.tcs-75.test.ts` case 1 |
| Over 200 chars → fallback "Upgrade undici to the fixed version for your line (see fixed_versions)." | T1 | same file, case 3 |
| Single-range record is unchanged | T1 | same file, case 2; `tests/ingest/osv.tcs-2.test.ts` single-fix rows |
| Check item action from the matched range: undici 7.29.0 → "Upgrade undici to 7.29.1 or later." | T2 | `tests/check/per-match-action.tcs-75.test.ts` case 1 |
| undici 6.20.0 → 6.28.1 | T2 | same file, case 2 |
| Action/CLI/pages print the item's action | T2 (no client change: they print `item.action`) | `tests/action/check.tcs-33.test.ts` and `tests/cli/check-summary.tcs-28.test.ts` stay green; same file case 1 asserts the JSON the Action reads |
| NEGATIVE: the check item must not name another line's fix | T2 | same file, cases 1 and 2 assert `not.toContain` of the other versions |
| NEGATIVE: no backfill of stored rows | none (no migration, no script) | n/a: the diff adds no migration or script; scope gate |
| Stored rows change on the next OSV re-read | T1 (upsert path unchanged) | same ingest file, case 4 (re-upsert rewrites `action`) |

## Acceptance tests

`tests/ingest/osv-multi-range-action.tcs-75.test.ts` (vitest, workers pool):
1. `normalizeOsv(<undici fixture>, DEFAULT_ECOSYSTEMS)` → `doc.action` is exactly "Upgrade undici to 6.28.1 (6.x), 7.29.1 (7.x) or 8.10.2 (8.x) or later."; `doc.fixed_versions` unchanged (3 items).
2. The same fixture with the 7.x and 8.x `affected` entries removed → action "Upgrade undici to 6.28.1 or later." (single range unchanged). A fixture with no fix → "No fix published. Pin and monitor."
3. A synthetic record from the fixture with a 180-char package name and 2 fixes → action is the fallback "Upgrade <name> to the fixed version for your line (see fixed_versions)." cut to 200; length ≤ 200. Also fixes "1.2.3" and "1.2.4" → fallback (labels not distinct). Also Go-style "1.21.12" and "1.22.5" → "(1.21.x)" and "(1.22.x)".
4. Upsert a doc with the old action (`"Upgrade undici to 6.28.1 or later."`) through `upsertAdvisory`, then upsert the new `normalizeOsv` output for the same `(osv, GHSA-rfgv-xxqx-mfg5)` → the stored `doc_json.action` is the new text and there is still 1 row (re-read rewrites, no duplicate).

`tests/check/per-match-action.tcs-75.test.ts` (vitest, workers pool, through `SELF.fetch` on `POST /v1/check` with a unique `CF-Connecting-IP` per test):
1. Seed the `normalizeOsv` doc of the undici fixture with `upsertAdvisory`. Check `{"dependencies":[{"ecosystem":"npm","name":"undici","version":"7.29.0"}]}` → the item for GHSA-rfgv-xxqx-mfg5 has `fixed_in` "7.29.1" and `action` "Upgrade undici to 7.29.1 or later."; `action` does not contain "6.28.1" or "8.10.2".
2. Same, version "6.20.0" → `fixed_in` "6.28.1", `action` "Upgrade undici to 6.28.1 or later.".
3. Version "7.29.1" → no affected item for undici.
4. Pure `matchAction` cases: a doc with `sources[0].source` "node-runtime" and 2 fixes keeps its stored action; an OSV doc with 1 fix keeps its stored action; an OSV doc with 2 fixes and `fixed_in` undefined keeps its stored action.

Each test seeds its own advisory ids (unique component suffix or id per test where the fixture allows; the undici fixture is seeded once per test file in `beforeAll` and only read), so the files do not depend on order or share rows with other files.

Regression risk suites: `tests/ingest/osv.tcs-2.test.ts` (changes, above), `tests/ingest/osv-multi-package.tcs-46.test.ts`, `tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts`, `tests/routes/check.tcs-9.test.ts`, `tests/cron/runtime-ingest.tcs-6.test.ts`, `tests/check/go-runtime*.test.ts`, `tests/check/coverage.tcs-32.test.ts`, `tests/mcp/tools.test.ts`.

## Entry points

no user-facing entry point (an API text field changes; the Action, CLI, MCP and pages already show `action` and need no change).

## QA screens

- `https://tocsin.sh/v1/check` (POST JSON, undici 7.29.0): the item `action` names 7.29.1. API only.
- `https://tocsin.sh/advisories/<id of GHSA-rfgv-xxqx-mfg5>`: after the next OSV re-read, "Action:" lists 6.28.1 (6.x), 7.29.1 (7.x) and 8.10.2 (8.x). No browser layout change.

## Design collision check (BH-5791)

Checked 5 listed and 0 derived symbols against main da7be288a488..da7be288a488 and 5 open PRs.
- `normalizeOsv` (function, listed): PR #79 e4efb1bc0ade, body or signature changed. Resolution: combine.
- `runCheck` (function, listed): PR #79 e4efb1bc0ade, body or signature changed. Resolution: combine.

## Size

FILES: 4
LINES: 70
DIFF_KB: 18

KIND: bug
SIZE: S
