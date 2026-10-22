# Plan: TCS-5 (issue #5) Check: version range matcher per ecosystem

## Ticket state
- Issue #5, open, labeled `ai-build`, created 2026-10-22T00:26:45Z. Body is the spec. Comment thread: 0 comments.
- `Blocked-by: #1 (hard)`: #1 is CLOSED (merged as aaa6f23, TCS-1 scaffold). Buildable.
- Already on main? `git log origin/main --since=2026-10-22T00:26:45Z` shows only aaa6f23 (scaffold). There is no `src/check/` on origin/main and no other branch than `ticket/tcs-1`. Nothing of this ticket is done on main.
- CodeGraph: not available on this box (prompt header). Files found with `git ls-tree` and Read.
- Verification map: absent in this repo. Not consulted, not created.

## Spec changes from comments
none

## Scope
Pure functions, no I/O, no D1, no network, in a new directory `src/check/match/`.
Input is the TCS-1 `Advisory` type (`src/schema/advisory.ts`): `ecosystem`, `component`,
`affected: AffectedRange[]` (each entry is one interval `{introduced?, fixed?, last_affected?}`,
OSV shape, already flat), and `fixed_versions: string[]`.

Per-ecosystem comparators (each module exports `parse`-validity and `compare(a, b): -1|0|1`):
- `semver.ts`: npm, node, deno, bun. Uses the `semver` npm package (`semver.parse(v, {loose: true})`, `semver.compare`). No range strings: we compare versions one by one, so pre-release handling is exact (`24.22.1-rc.1 < 24.22.1`).
- `pep440.ts`: PyPI, python. Hand-written PEP 440 parser and sort key (epoch, release with trailing zeros removed, pre a/b/rc with the alternate spellings alpha/beta/c/pre/preview, post incl. `-N`/rev/r, dev, local). No external package.
- `composer.ts`: Packagist, php. Optional `v` prefix, 1 to 4 numeric parts padded to 4, stability suffix order `dev < alpha(a) < beta(b) < RC(rc) < stable < patch(pl, p)`. `dev-<branch>` versions are invalid.
- `gomod.ts`: Go (and the `go` runtime, see ASSUMPTIONS). `v`-prefixed semver, `+incompatible` dropped. Pseudo-versions (`vX.0.0-yyyymmddhhmmss-abcdefabcdef`, `vX.Y.Z-pre.0.yyyymmddhhmmss-…`, `vX.Y.Z-0.yyyymmddhhmmss-…`): when both sides are pseudo-versions on the same base, compare the 14-digit timestamp; otherwise semver precedence.
- `cargo.ts`: crates.io. Semver via the `semver` package, strict (no loose, no `v`).
- `gem.ts`: RubyGems. Hand-written Gem::Version rules: `-` becomes `.pre.`, segments are runs of digits or letters, trailing zero segments dropped, a letter segment marks a pre-release and sorts below any number, letters compare lexically.

Shared logic in `range.ts`:
- `inRange(v, r, cmp)`: lower bound `introduced` (absent or `"0"` = from the beginning, inclusive), upper bound `fixed` exclusive, `last_affected` inclusive, no upper bound = open-ended.
- `lowestFixedAbove(v, candidates, cmp)`: the lowest candidate strictly greater than `v`.

Dispatcher `index.ts`:
- `matchAdvisory(dep, advisory): MatchResult` where `MatchResult = { affected: boolean; fixed_in?: string; skipped?: "unsupported_ecosystem" | "invalid_version" | "invalid_range" }`.
- `isAffected(dep, advisory): boolean` = `matchAdvisory(dep, advisory).affected` (the ticket's named signature).
- Steps: (1) `dep.ecosystem !== advisory.ecosystem` or name mismatch → `{affected: false}`. (2) Ecosystem not in the dispatch map → `{affected: false, skipped: "unsupported_ecosystem"}`. (3) Dep version does not parse → `{affected: false, skipped: "invalid_version"}`. (4) Check each range; a range with an unparseable bound is ignored. (5) Affected → `fixed_in` = lowest of (`affected[].fixed` ∪ `fixed_versions`) above the dep version, omitted if none. Not affected and a range was ignored → `skipped: "invalid_range"`.
- Name match: exact, except PyPI/python where both sides are PEP 503 normalized (lowercase, runs of `-_.` → `-`).

`types.ts`: `Dependency = { ecosystem: string; name: string; version: string }`, `MatchResult`, `Comparator`.

## ASSUMPTIONS
- Test file name. The ticket names `tests/check/match.test.ts`. The harness rule is a per-ticket file name. I use `tests/check/match.tcs-5.test.ts` (same directory, ticket suffix). Other reading: the literal name; a rename is a one-line change.
- `Dependency` type. TCS-4 (parsers) is the ticket that produces `Dependency[]` and is being planned at the same time; it is not on main. I define `Dependency` in `src/check/match/types.ts` with the exact field set the TCS-4 body gives (`{ecosystem, name, version}`). TypeScript is structural, so TCS-4's type is assignable without an import. Other reading: import it from `src/check/parsers/`, which does not exist yet and would block this build on TCS-4.
- Unknown ecosystem, bad version. The ticket's return shape is `{affected, fixed_in?}`. I add an optional `skipped` reason so the check endpoint (#9, "checked n" coverage) can report what it could not check instead of a silent `false` (D11: absent ≠ not affected). Other reading: throw; that turns one bad lockfile line into a 500 for the whole request.
- `fixed_in` candidates. "Lowest fixed version above the dependency's version": candidates are every `affected[].fixed` plus every `fixed_versions` entry that parses. Only set when `affected` is true. Other reading: only the `fixed` of the matched range; for the real node ranges both give the same answer (24.22.1 for 24.x, 26.12.1 for 26.x).
- Ecosystem names are exact and case-sensitive (OSV names `npm`, `PyPI`, `Go`, `Packagist`, `crates.io`, `RubyGems`, runtimes `node`, `php`, `python`, `go`, `deno`, `bun`). `dep.ecosystem` must equal `advisory.ecosystem`; a `go` runtime dep never matches a `Go` module advisory. Other reading: case-insensitive matching; it is easy to add later and harder to take back.
- `go` runtime. CLAUDE.md lists `go` as a runtime; the ticket routes only `Go`. I route `go` to `gomod.ts` with a small runtime normalizer: strip a leading `go`/`v`, pad a missing patch (`1.21` → `1.21.0`), `1.21rc2` → `1.21.0-rc.2`. Other reading: leave `go` unsupported (it would then return `skipped: "unsupported_ecosystem"`).
- Name normalization only for PyPI/python (PEP 503). npm, Packagist, Go, crates.io, RubyGems names compare exact. Other reading: also fold `-`/`_` for crates.io; not asked for.
- Dispatch map is code, not a DB row (iron rule 5). It maps an ecosystem name to a comparator function, which is code by nature, not a business parameter.
- No production caller in this PR. The check endpoint is #9 and is out of scope per the ticket. `src/check/match/index.ts` is the entry point the tests drive (D2 within scope; D27 noted: the consumer is #9).

## Files to touch
- `package.json` (add `semver` to dependencies, `@types/semver` to devDependencies)
- `package-lock.json` (regenerated by `npm install semver @types/semver`)
- `src/check/match/types.ts` (new)
- `src/check/match/range.ts` (new)
- `src/check/match/semver.ts` (new)
- `src/check/match/pep440.ts` (new)
- `src/check/match/composer.ts` (new)
- `src/check/match/gomod.ts` (new)
- `src/check/match/cargo.ts` (new)
- `src/check/match/gem.ts` (new)
- `src/check/match/index.ts` (new)
- `tests/check/match.tcs-5.test.ts` (new)

## Tests that must change
None

## Verify (run, not edited)
- `npm test` (whole suite, incl. `tests/unit/schema.tcs-1.test.ts`, `tests/worker/health.tcs-1.test.ts`, `tests/worker/migrations.tcs-1.test.ts`)
- `npm run typecheck`
- `npm run gen:schema -- --check` (CI step; this ticket does not touch the schema, it must stay clean)

## Changed symbols
- function `matchAdvisory`: new, `src/check/match/index.ts`, `(dep, advisory) => MatchResult`.
- function `isAffected`: new, `src/check/match/index.ts`, `(dep, advisory) => boolean`.
- function `inRange`: new, `src/check/match/range.ts`.
- function `lowestFixedAbove`: new, `src/check/match/range.ts`.
- function `compareSemver`: new, `src/check/match/semver.ts` (plus `parseSemver`).
- function `comparePep440`: new, `src/check/match/pep440.ts` (plus `parsePep440`, `normalizePypiName`).
- function `compareComposer`: new, `src/check/match/composer.ts` (plus `parseComposer`).
- function `compareGo`: new, `src/check/match/gomod.ts` (plus `parseGo`, `normalizeGoRuntime`).
- function `compareCargo`: new, `src/check/match/cargo.ts`.
- function `compareGem`: new, `src/check/match/gem.ts` (plus `parseGem`).
- format `MatchResult`: new type `{affected, fixed_in?, skipped?}` in `src/check/match/types.ts`.
- format `Dependency`: new type `{ecosystem, name, version}` in `src/check/match/types.ts`.

## Sibling claims (not touched)
- `/root/harness/state/claims/tocsin/` is empty at plan time. TCS-4 (parsers) is planning in parallel and lives in its own directory `src/check/parsers/`; this plan does not edit it. The one shared risk is `package.json`/`package-lock.json` if TCS-4 adds a yaml package. That overlap is unavoidable: the ticket requires the `semver` package.

## Iron laws: how they apply
- Additive schema, indexes, EXPLAIN, retention, RLS: n/a. No table, no migration, no query.
- Idempotency, exactly-once, dedup-before-spend: n/a. No writes, no metered call (no NVD, no LLM, no email).
- DB-driven config: the only "config" is the ecosystem → comparator map, which is code dispatch (see ASSUMPTIONS).
- Deterministic before LLM: everything is deterministic; no LLM.
- UI (sortable headers, list-over-cards, drill-down, 375px, no native dialogs): n/a. No UI.
- De-AI: n/a. No human-facing text.
- Performance: n/a for a screen. Pure CPU functions, O(ranges) per advisory. No reads, 0 statements, no skeleton.
- Scalable tests: no vendor touched. The tests make 0 network calls; each case is independent table data.
- Model id: no model call.

## Build-discipline rules that bite this ticket
- D1 mutation check: flip `fixed` to inclusive, flip `last_affected` to exclusive, drop the `"0"` special case, drop the epoch, return the highest instead of lowest `fixed_in`; each mutation must turn a case red.
- D3 assert values: each case asserts `affected` and, where given, `fixed_in`.
- D4 real inputs: use the real node advisory fixture `tests/fixtures/advisory/valid.json` for the 2026-10-21 node cases.
- D6 true exit codes: record `npm test` and `npm run typecheck` exit codes unpiped.
- D11 absent ≠ false: an invalid version or unsupported ecosystem carries `skipped`, never a plain clean `false`.
- D17 identity keys: PyPI name normalization applied to both sides; test `Requests` vs `requests` and `zope.interface` vs `zope-interface`.
- D25 surgical: no edits outside the files listed.

## Tasks

### T1. Add the semver dependency
Run `npm install semver@^7` and `npm install -D @types/semver`. Confirm `import { parse, compare } from "semver"` resolves under `@cloudflare/vitest-pool-workers` (semver 7 is CommonJS; if the default import fails in the workers pool, use `import * as semver from "semver"`).
VALIDATE: `node -e "require('semver')" && grep -E '"semver"|"@types/semver"' package.json` prints both lines, and `npm run typecheck` exits 0.
SATISFIES: "`semver.ts` for npm, node, deno, bun (use the `semver` package)."

### T2. Types and shared range logic
Write `types.ts` (`Dependency`, `MatchResult`, `Comparator = { parse(v): boolean-valid; compare(a, b): number }`) and `range.ts` (`inRange`, `lowestFixedAbove`) per Scope.
VALIDATE: `npm test -- tests/check/match.tcs-5.test.ts -t "range"` passes the boundary cases: `fixed` exclusive, `last_affected` inclusive, `introduced: "0"`, absent `introduced`, open-ended range.
SATISFIES: "The OSV `affected[]` shape is the input: `introduced`, `fixed`, `last_affected` events, where `introduced: "0"` means from the beginning."

### T3. semver.ts and cargo.ts
`semver.ts`: loose parse (accepts `v24.22.0`), `semver.compare`. `cargo.ts`: strict parse, same compare.
VALIDATE: `npm test -- tests/check/match.tcs-5.test.ts -t "npm"` and `-t "crates.io"` pass, 10+ cases each, incl. pre-release (`1.0.0-alpha < 1.0.0-beta < 1.0.0`).
SATISFIES: "`semver.ts` for npm, node, deno, bun" and "`cargo.ts` for crates.io (semver)".

### T4. pep440.ts
Hand-written parser and sort key per Scope. Invalid input (e.g. `latest`, `1.0-foo`) → not valid.
VALIDATE: `npm test -- tests/check/match.tcs-5.test.ts -t "PyPI"` passes 10+ cases incl. `1.0.post1 > 1.0`, `1.0rc1 < 1.0`, `1.0.dev1 < 1.0a1`, `2024.1`, `1!1.0 > 2.0`, `1.0 == 1.0.0`.
SATISFIES: "`pep440.ts` for PyPI and python (implement PEP 440 comparison; no external package)" and "PEP 440 cases: `1.0.post1`, `1.0rc1`, `2024.1`, epoch `1!1.0`."

### T5. composer.ts
Parser and compare per Scope.
VALIDATE: `npm test -- tests/check/match.tcs-5.test.ts -t "Packagist"` passes 10+ cases incl. `v1.2.3 == 1.2.3`, `1.2.3.4 > 1.2.3`, `1.2.3 == 1.2.3.0`, `1.0.0-RC1 < 1.0.0`, `1.0.0-beta2 < 1.0.0-RC1`, `1.0.0-p1 > 1.0.0`, `dev-main` → `skipped: invalid_version`; and `-t "php"` passes `8.4.26` vs a php range.
SATISFIES: "`composer.ts` for Packagist and php (semver-like with `v` prefix and 4-part versions)."

### T6. gomod.ts
Parser, pseudo-version timestamp compare, `+incompatible`, `go` runtime normalizer per Scope.
VALIDATE: `npm test -- tests/check/match.tcs-5.test.ts -t "Go"` passes 10+ cases incl. `v0.0.0-20210101000000-abcdefabcdef < v0.0.0-20220101000000-123456789abc`, a pseudo-version below its tagged release, `v2.0.0+incompatible`, and `-t "go runtime"` passes `go1.22.3` and `1.21rc2 < 1.21.0`.
SATISFIES: "`gomod.ts` for Go (`v`-prefixed semver, pseudo-versions compare by timestamp)."

### T7. gem.ts
Gem::Version compare per Scope.
VALIDATE: `npm test -- tests/check/match.tcs-5.test.ts -t "RubyGems"` passes 10+ cases incl. `1.0 == 1.0.0`, `1.10 > 1.9`, `1.0.0.pre1 < 1.0.0`, `1.0.0-rc1 < 1.0.0`, `1.0.a < 1.0.b`.
SATISFIES: "`gem.ts` for RubyGems (Gem::Version rules)."

### T8. index.ts dispatcher
`matchAdvisory` and `isAffected` per Scope, with the dispatch map covering npm, node, deno, bun, PyPI, python, Packagist, php, Go, go, crates.io, RubyGems.
VALIDATE: `npm test -- tests/check/match.tcs-5.test.ts -t "node 2026-10-21"` passes: with `tests/fixtures/advisory/valid.json`, `24.22.0` → `{affected: true, fixed_in: "24.22.1"}`, `24.22.1` → `{affected: false}`, `26.0.0` → `fixed_in: "26.12.1"`; and `-t "dispatch"` passes: name mismatch → false, ecosystem mismatch → false, `Maven` → `skipped: unsupported_ecosystem`, `not-a-version` → `skipped: invalid_version`.
SATISFIES: "`src/check/match/index.ts` dispatches on ecosystem and returns `{affected: boolean, fixed_in?: string}` where `fixed_in` is the lowest fixed version above the dependency's version." and the node acceptance criterion.

### T9. Acceptance test file
Write `tests/check/match.tcs-5.test.ts`: one `describe` per ecosystem, table-driven `it.each`, each row a `(version, ranges, fixed_versions?, expected affected, expected fixed_in?)`, driven through `matchAdvisory` (the dispatcher), plus direct `compare` tables for PEP 440 ordering. Then run the D1 mutations listed above by hand and confirm each one turns a case red; revert.
VALIDATE: `npm test` exits 0 and `npm run typecheck` exits 0; the test count for `tests/check/match.tcs-5.test.ts` is at least 10 per ecosystem family (npm, node, PyPI, Packagist, Go, crates.io, RubyGems).
SATISFIES: "`tests/check/match.test.ts`: table-driven, at least 10 cases per ecosystem, including boundaries (`fixed` is exclusive, `last_affected` is inclusive), `introduced: "0"`, pre-release tags, and the real 2026-10-21 node ranges".

## Edge cases
- `introduced` absent and `introduced: "0"`: both mean from the beginning; `"0"` is never passed to a parser (it is not valid semver).
- A range with only `introduced`: open-ended; affected for every version at or above it.
- A range with both `fixed` and `last_affected` (malformed but schema-valid): both bounds apply.
- Pre-release dep below a `fixed` release: affected (`24.22.1-rc.1` with fixed `24.22.1`).
- Unparseable range bound: that range is ignored; `skipped: "invalid_range"` only if no other range matched.
- Empty `affected[]`: not affected.
- `fixed_versions` with no candidate above the dep (only `last_affected` ranges): `fixed_in` omitted, never invented (D26).
- Duplicate candidates in `affected[].fixed` and `fixed_versions`: same answer.
- Whitespace around versions: trimmed once at parse.
- Go `+incompatible` and build metadata: ignored for precedence.

## System invariants
(a) Cross-run state: none. Pure functions; no store.
(b) External side effects: none. No network, no D1, no KV, no queue.
(c) Adversarial negatives (the matcher gates a client-visible "affected" verdict), each must be in the tests as NOT affected or skipped: dep at exactly `fixed` (`24.22.1`); dep one patch above `last_affected`; dep below `introduced` (`23.9.0` against `24.0.0`–`24.22.1`); a package with the same name in another ecosystem (`npm/requests` vs a PyPI advisory); a `go` runtime dep against a `Go` module advisory named `go`; `dev-main` (Packagist) → skipped, not affected; `latest` → skipped; `Maven` → skipped; `1.0.post1` against `fixed: "1.0.post1"`.
(d) Neighbor interactions: no cron, lock, cap or scheduler. The future consumers are #9 (check endpoint) and #13 (CLI); they import `matchAdvisory`/`isAffected` and read `skipped` for coverage. TCS-4 produces `Dependency[]` with the same three fields; structural typing makes the two compatible with no shared file.

## Requirements coverage
| Requirement (ticket) | Task | Acceptance test |
|---|---|---|
| Pure functions in `src/check/match/` | T2–T8 | whole file imports only `src/check/match/*` and `src/schema/advisory.ts` types; no I/O |
| `isAffected(dep, advisory): boolean` | T8 | `dispatch` cases call `isAffected` and assert a boolean |
| `semver.ts` for npm, node, deno, bun, using `semver` | T1, T3 | `npm`, `node`, `deno`/`bun` describe blocks |
| `pep440.ts` for PyPI and python, no external package | T4 | `PyPI`, `python` blocks; package.json gains only `semver`/`@types/semver` |
| `composer.ts` for Packagist and php, `v` prefix, 4-part | T5 | `Packagist`, `php` blocks |
| `gomod.ts` for Go, pseudo-versions by timestamp | T6 | `Go` block, pseudo-version rows |
| `cargo.ts` for crates.io | T3 | `crates.io` block |
| `gem.ts` for RubyGems, Gem::Version rules | T7 | `RubyGems` block |
| OSV shape input; `introduced: "0"` = from the beginning | T2 | `range` block |
| `fixed` exclusive, `last_affected` inclusive | T2 | `range` block boundary rows |
| `index.ts` dispatches, returns `{affected, fixed_in?}` | T8 | `dispatch` block |
| `fixed_in` = lowest fixed version above dep version | T8 | `node 2026-10-21` block (24.x → 24.22.1, 26.x → 26.12.1) |
| ≥10 cases per ecosystem, table-driven | T9 | count per describe ≥ 10 |
| Pre-release tags | T3–T7 | rc/alpha/beta/pre rows in each block |
| Real 2026-10-21 node ranges: `24.22.0` affected, `24.22.1` not | T8 | `node 2026-10-21` block with `tests/fixtures/advisory/valid.json` |
| PEP 440 cases `1.0.post1`, `1.0rc1`, `2024.1`, `1!1.0` | T4 | `PyPI` block |
| Out of scope: parsers, the endpoint (negative) | — | diff touches no `src/check/parsers/`, no `src/routes/`, no `src/app.ts` (checked by the files list) |

## Acceptance tests
File: `tests/check/match.tcs-5.test.ts` (vitest, runs in the workers pool like the rest of the suite).
- `range`: `introduced:"0",fixed:"1.0.0"` → `0.0.1` affected, `1.0.0` not; `introduced:"1.0.0",last_affected:"1.2.0"` → `1.2.0` affected, `1.2.1` not, `0.9.9` not; `{introduced:"2.0.0"}` → `99.0.0` affected; `{fixed:"1.0.0"}` (no introduced) → `0.5.0` affected; `affected: []` → not affected.
- `node 2026-10-21`: fixture advisory; `24.22.0` → `{affected:true, fixed_in:"24.22.1"}`; `24.22.1` → `{affected:false}`; `26.0.0` and `26.12.0` → `fixed_in:"26.12.1"`; `26.12.1` → not; `22.23.3` → `fixed_in:"22.23.4"`; `23.0.0` → not; `v24.22.0` → affected; `24.22.1-rc.1` → affected, `fixed_in:"24.22.1"`; `27.0.0` → not.
- `npm`: 10+ rows incl. `1.0.0-alpha`/`-beta` ordering, `introduced:"0"`, `last_affected`, `0.0.0`.
- `deno`, `bun`: 2+ rows each through the same comparator (they count with npm/node toward the semver family).
- `PyPI`: 10+ rows: `1.0.post1 > 1.0`, `1.0rc1 < 1.0`, `1.0.dev1 < 1.0a1 < 1.0b1 < 1.0rc1`, `2024.1` in `introduced:"2023.0",fixed:"2024.2"`, `1!1.0` not in `fixed:"2.0"` (epoch makes it greater), `1.0 == 1.0.0`, `1.0+local > 1.0`, `Requests` matches advisory component `requests`, `latest` → `skipped:"invalid_version"`.
- `python`: 3+ rows, `3.12.1` vs a python range.
- `Packagist`: 10+ rows per T5. `php`: 3+ rows (`8.4.26`).
- `Go`: 10+ rows per T6. `go runtime`: 3+ rows per T6.
- `crates.io`: 10+ rows; `v1.0.0` → `skipped:"invalid_version"` (strict).
- `RubyGems`: 10+ rows per T7.
- `dispatch`: name mismatch → `{affected:false}` with no `skipped`; ecosystem mismatch → `{affected:false}`; `Maven` → `skipped:"unsupported_ecosystem"`; `isAffected` returns the same boolean as `matchAdvisory(...).affected`; an advisory with one bad range bound and no other match → `skipped:"invalid_range"`; with a bad bound plus a matching good range → affected.
- Adversarial negatives from System invariants (c) as rows in their blocks.

Suites at regression risk: `tests/unit/schema.tcs-1.test.ts` (shares the `Advisory` type; not edited), `tests/worker/*.tcs-1.test.ts` (shares the vitest workers pool; the new dependency must not break module loading). `npm test` runs all of them.

## QA screens
None. No route or screen changes. The check endpoint (#9) is the first screen-facing consumer.

## Design collision check (BH-5791)

Checked 12 listed and 0 derived symbols against main aaa6f2322bf4..aaa6f2322bf4 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 10
LINES: 600
DIFF_KB: 45

KIND: feature
SIZE: M
