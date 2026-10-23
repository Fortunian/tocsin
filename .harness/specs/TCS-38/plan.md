# Plan: TCS-38 — More OSV ecosystems (Maven, NuGet, Hex, Pub, Alpine, Debian) with matchers and lockfile parsers

Ticket: Fortunian/tocsin#38, filed 2026-10-22T21:16:01Z, label `ai-build`, state OPEN.
Blocked-by: #32 (hard). #32 is CLOSED (merged as 0fe8f34). The ticket is buildable.
Thread: 0 comments. The issue body is the whole spec.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-22T21:16:01Z` shows 0fe8f34 (TCS-32 backfill),
41c4549 (TCS-8 limits), a8dbeca (TCS-71 base-name ecosystem match) and 249c734 (undici). None adds a
Maven, NuGet, Hex, Pub, Alpine or Debian matcher, parser or config row. TCS-71 (a8dbeca) added
`baseEcosystem()` in `src/ingest/osv.ts`; this plan reuses it.

CodeGraph: NOT AVAILABLE on this box. Files and callers below come from grep and reads.

## Spec changes from comments

none

## Scope

1. Config row: a migration adds `Maven`, `NuGet`, `Hex`, `Pub`, `Alpine`, `Debian` to `sources.config_json.ecosystems` of row `osv`. Idempotent. It never removes or reorders an edited list.
2. Matchers: one file per ecosystem in `src/check/match/` (the existing matcher folder): `maven.ts`, `nuget.ts`, `hex.ts`, `pub.ts`, `apk.ts`, `dpkg.ts`. Each exports a `Comparator`. The OSV range logic stays in `range.ts` (`introduced`, `fixed`, `last_affected`).
3. Release scope for OS ecosystems: OSV writes `Alpine:v3.18` and `Debian:12`. One package has different fixed versions per release. The normalizer must keep one doc per (release, package) for `Alpine` and `Debian`, and the matcher must compare a dependency only with the advisory of its own release. Without this, a Debian 12 version is compared with Debian 11 ranges (false positives) — a wrong-data defect.
4. Lockfile parsers: `pom.xml`, `gradle.lockfile`, `packages.lock.json`, `mix.lock`, `pubspec.lock`, and one OS package list parser (`apk list --installed` text, `dpkg -l` text, and `dpkg-query -W` two-column text).
5. `/v1/check` OS input: `alpine=<release>` or `debian=<release>` (runtime style) plus an `os_packages` text field, in JSON and in multipart.
6. Backfill: `backfill.yml` gets the six ecosystems as options. The runs themselves are operator steps after deploy (PR body). `coverage_since` is written by the existing import route per ecosystem.
7. Landing hook names the new ecosystems. `docs/API.md` lists the new lockfile names and the OS input. `docs/BACKFILL.md` lists the new options.
8. CLI and GitHub Action discovery: `packages/cli/src/lockfiles.js` lists the new lockfile names, so `npx tocsin check` and the Action send them.

Out of scope (ticket): runtime ingesters, Docker image scanning.

## Proposed split (SIZE XL)

The work bundles 3 independent workstreams. Each child ships on its own and is reviewable alone.

- C0 — JVM and .NET: migration adds `Maven`, `NuGet`; `maven.ts`, `nuget.ts`; parsers `pom.xml`, `gradle.lockfile`, `packages.lock.json`; parser and matcher registry lines; CLI lockfile names; `backfill.yml` options; `docs/API.md`, `docs/BACKFILL.md`. Carries the log4j prod gate (Task 9).
- C1 — Elixir and Dart: migration adds `Hex`, `Pub`; `hex.ts`, `pub.ts`; parsers `mix.lock`, `pubspec.lock`; registry lines; CLI names; workflow options; docs. Blocked-by C0 (same registry, docs and workflow files).
- C2 — OS packages: release scope in `normalizeOsv` (Task 3), base-name lookup in candidates, run and coverage, `apk.ts`, `dpkg.ts`, `os-packages.ts` parser, `/v1/check` OS input, migration adds `Alpine`, `Debian`. Blocked-by C1. The `Alpine`/`Debian` config rows MUST land in the same PR as Task 3, never before it: a backfill with the old normalizer stores merged release ranges.
- C3 — Landing hook copy (Task 8) after C2 merges, so the page never names an ecosystem the API does not check.

The tasks below are the whole ticket. Each task names its child.

## Files to touch

Product code:
- `migrations/0021_osv_more_ecosystems.sql` (new; 0017–0020 are taken by open PRs #67, #68, #70, #73; renumber at rebase if needed)
- `src/ingest/osv.ts` (`normalizeOsv`: release-scoped package key and source id for `Alpine`, `Debian`; new export `RELEASE_SCOPED`)
- `src/check/match/index.ts` (registry lines; base-name and release match)
- `src/check/match/maven.ts` (new)
- `src/check/match/nuget.ts` (new)
- `src/check/match/hex.ts` (new)
- `src/check/match/pub.ts` (new)
- `src/check/match/apk.ts` (new)
- `src/check/match/dpkg.ts` (new)
- `src/check/candidates.ts` (`lookupEcosystem`: query key on the base ecosystem)
- `src/check/run.ts` (`groupKey` on the base ecosystem)
- `src/check/coverage.ts` (`coverageOwner` on the base ecosystem)
- `src/check/parsers/types.ts` (`ParserId` union)
- `src/check/parsers/index.ts` (parser and filename registry)
- `src/check/parsers/pom-xml.ts` (new)
- `src/check/parsers/gradle-lockfile.ts` (new)
- `src/check/parsers/nuget-lock.ts` (new)
- `src/check/parsers/mix-lock.ts` (new)
- `src/check/parsers/pubspec-lock.ts` (new)
- `src/check/parsers/os-packages.ts` (new)
- `src/routes/check.ts` (OS input in `GET`, JSON and multipart)
- `packages/cli/src/lockfiles.js` (new names)
- `site/landing.ts` (hook sentence)
- `.github/workflows/backfill.yml` (six options)

Docs and generated:
- `docs/API.md`, `site/docs.generated.ts` (regenerated by `node scripts/gen-docs.mjs`, never hand-edited), `docs/BACKFILL.md`

Tests (new, per ticket):
- `tests/check/maven.tcs-38.test.ts`, `tests/check/nuget.tcs-38.test.ts`, `tests/check/hex.tcs-38.test.ts`, `tests/check/pub.tcs-38.test.ts`, `tests/check/alpine.tcs-38.test.ts`, `tests/check/debian.tcs-38.test.ts`
- `tests/check/parsers.tcs-38.test.ts`
- `tests/check/os-input.tcs-38.test.ts`
- `tests/ingest/osv-release-scope.tcs-38.test.ts`
- `tests/routes/check-plan.tcs-38.test.ts`
- `tests/worker/osv-ecosystems-migration.tcs-38.test.ts`
- `tests/routes/landing-ecosystems.tcs-38.test.ts`
- `tests/cli/lockfiles.tcs-38.test.ts`
- Fixtures: `tests/fixtures/osv/tcs-38/<ecosystem>/*.json` (real OSV records, fetched from `https://api.osv.dev/v1/vulns/<id>` during the build, listed with their ids in `tests/fixtures/osv/tcs-38/SOURCES.md`); `tests/fixtures/lockfiles/pom.xml`, `gradle.lockfile`, `packages.lock.json`, `mix.lock`, `pubspec.lock`, `apk-installed.txt`, `dpkg-l.txt`, `dpkg-query.txt` (recorded from real projects or real containers; source per file in `tests/fixtures/lockfiles/SOURCES.md`)
- `tests/fixtures/lockfiles/SOURCES.md` (append one line per new fixture file; it is a fixture provenance list, not a test)

Tests that must change: see the section below.

## Tests that must change

- `tests/worker/migrations.tcs-1.test.ts`: it pins the exact list of migration file names (`applies 0001..0017`); this ticket adds `0021_osv_more_ecosystems.sql`.

## Verify (run, not edited)

- `npm test`
- `npm run typecheck`
- `npm run migrate:local`
- `node scripts/gen-docs.mjs` then `git diff --exit-code site/docs.generated.ts` after commit
- Existing suites at regression risk: `tests/check/match.tcs-5.test.ts`, `tests/check/parsers.tcs-4.test.ts`, `tests/routes/check.tcs-9.test.ts`, `tests/routes/check-plan.tcs-9.test.ts`, `tests/check/coverage.tcs-32.test.ts`, `tests/check/go-runtime.tcs-40.test.ts`, `tests/check/composer-drupal.tcs-71.test.ts`, `tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts`, `tests/ingest/osv-multi-package.tcs-46.test.ts`, `tests/ingest/osv.tcs-2.test.ts`, `tests/backfill/import.tcs-32.test.ts`, `tests/routes/internal-import.tcs-32.test.ts`, `tests/routes/status-coverage.tcs-32.test.ts`, `tests/routes/site.tcs-10.test.ts`, `tests/cli/check.tcs-13.test.ts`, `tests/action/lockfiles.tcs-33.test.ts`, `tests/launch/launch-check.tcs-14.test.ts`.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at plan time. Open PRs (not claims) that share files:
- #68 (TCS-11) and #70 (TCS-64) edit `docs/API.md` and `site/docs.generated.ts`. This plan's doc edit is a few lines in the Check section and the advisory `ecosystem` row; a rebase regenerates `site/docs.generated.ts`.
- #68 edits `src/watchlists/filter.ts`. This plan does NOT edit it (see ASSUMPTIONS A9).
- #67, #68, #70, #73 add migrations 0017–0020 and edit `tests/worker/migrations.tcs-1.test.ts`. This plan uses 0021.

## Changed symbols

- format `migrations/0021_osv_more_ecosystems.sql`: new migration; `sources.config_json.ecosystems` of row `osv` gains six names.
- function `normalizeOsv` (`src/ingest/osv.ts`): for an ecosystem in `RELEASE_SCOPED` (`Alpine`, `Debian`), the package key is the full OSV string (`Debian:12`), each release becomes its own doc with `ecosystem_qualifier` = that string, and a non-first doc's source id is `<id>#<full string>/<name>`. Other ecosystems unchanged. callers: left alone: `src/ingest/osv.ts` cron `run` and `src/routes/internal-import.ts` consume `docs[]` unchanged.
- function `osvSourceId` (`src/ingest/osv.ts`): called with the full OSV string for release-scoped ecosystems; signature unchanged.
- function `matchAdvisory` (`src/check/match/index.ts`): compares base ecosystems; for a release-scoped dependency (`Debian:12`) it requires `advisory.ecosystem_qualifier === dep.ecosystem`.
- function `supportsEcosystem` (`src/check/match/index.ts`): looks up the comparator by `baseEcosystem(dep.ecosystem)`, and accepts a release-scoped base only with a release suffix.
- function `candidateKeys` / `lookupName` (`src/check/candidates.ts`): the query key uses the base ecosystem (new helper `lookupEcosystem`). PyPI path unchanged.
- function `runCheck` (`src/check/run.ts`): `groupKey` for a dependency uses `lookupEcosystem`. No new statement.
- function `coverageOwner` (`src/check/coverage.ts`): owner key is `baseEcosystem(ecosystem)` for OSV package ecosystems. Runtime branch unchanged.
- function `detectParser` / `detect` / constant `SUPPORTED_FILENAMES` (`src/check/parsers/index.ts`): new filenames `pom.xml`, `gradle.lockfile`, `packages.lock.json`, `mix.lock`, `pubspec.lock`.
- function `parseOsPackages` (new, `src/check/parsers/os-packages.ts`).
- route `GET /v1/check`: `alpine=` / `debian=` without a package list answers 400 that names `os_packages` (today the key is skipped as `unknown runtime`).
- route `POST /v1/check`: JSON accepts `runtimes.alpine` / `runtimes.debian` plus top-level `os_packages`; multipart accepts form fields `alpine` / `debian` plus `os_packages`.
- constant `LOCKFILE_NAMES` (`packages/cli/src/lockfiles.js`): five new names. callers: `packages/cli/src/check.ts` and `action/check.mjs` read it unchanged.
- function `renderLanding` (`site/landing.ts`): the hook sentence names the new ecosystems.

## Entry points

- `POST /v1/check` (API, the primary entry): touched. Lockfiles by filename; OS input by `alpine`/`debian` + `os_packages`.
- `GET /v1/check` query: touched (400 for an OS release without a package list; GET has no body for a package list).
- CLI `npx tocsin check`: touched through `packages/cli/src/lockfiles.js` (finds and sends the five new lockfile names). OS package lists: no change, because the CLI runs on a developer machine, not in the container; reading `apk`/`dpkg` there is a separate feature.
- GitHub Action (`action/check.mjs`): touched through the same `lockfiles.js`. The upgrade-command map gets no entry, so an affected Maven item shows no command (existing null path).
- MCP server (`mcp/`): no change, because its check tool forwards to `/v1/check` and gains the ecosystems with it.
- Feed `GET /v1/events?ecosystem=Maven`: no change, because the feed filter does not validate names; new advisories appear after the backfill.
- Watch lists `POST /v1/watchlists` `ecosystems`: no change in this ticket, because `src/watchlists/filter.ts` is edited by open PR #68; see ASSUMPTIONS A9.
- Status `/v1/status`, `/status`: no change in code, because the coverage table already has one row per enabled OSV ecosystem; the six rows show `complete: false` until each backfill finishes.
- Landing `/`: touched (hook sentence).
- Docs `/docs`: touched (generated from `docs/API.md`).

Entry-point test: `tests/check/os-input.tcs-38.test.ts` and each per-ecosystem test go through `POST /v1/check` (`SELF.fetch`); `tests/cli/lockfiles.tcs-38.test.ts` proves the CLI discovery list sends the new names.

## Tasks

### Task 1 — Config row migration (C0 for Maven/NuGet, C1 for Hex/Pub, C2 for Alpine/Debian)

`migrations/0021_osv_more_ecosystems.sql`:
1. If `config_json` has no `ecosystems` key, set it to the current code fallback list (`npm`, `PyPI`, `Go`, `Packagist`, `crates.io`, `RubyGems`), so the next step appends to the list the cron reads today:
   `UPDATE sources SET config_json = json_set(config_json, '$.ecosystems', json('["npm","PyPI","Go","Packagist","crates.io","RubyGems"]')) WHERE id = 'osv' AND json_extract(config_json, '$.ecosystems') IS NULL;`
2. For each new name, append only when absent:
   `UPDATE sources SET config_json = json_insert(config_json, '$.ecosystems[#]', 'Maven') WHERE id = 'osv' AND NOT EXISTS (SELECT 1 FROM json_each(sources.config_json, '$.ecosystems') WHERE value = 'Maven');`
3. No DROP, no DELETE, no schema change. `DEFAULT_ECOSYSTEMS` in `src/ingest/osv.ts` stays as it is (TCS-71 tests pin "Debian not enabled" on the code fallback).
VALIDATE: `npm test -- tests/worker/osv-ecosystems-migration.tcs-38.test.ts tests/worker/migrations.tcs-1.test.ts` (asserts: row `osv` lists the 12 names after apply; a second apply of the same SQL changes 0 rows and keeps the order; an edited list `["npm","Maven"]` becomes `["npm","Maven","NuGet","Hex","Pub","Alpine","Debian"]` with no duplicate; a list without `npm` stays without `npm`).
SATISFIES: Scope 1 — "Add Maven, NuGet, Hex, Pub, Alpine, Debian to the osv source's ecosystems config row (a migration that updates config_json, idempotent)."

### Task 2 — Matchers, one file per ecosystem (C0: Maven, NuGet; C1: Hex, Pub; C2: Alpine, Debian)

Each file exports `<name>Comparator: Comparator` with `valid` and `compare`. `compare` throws on an input `valid` rejected (same as `gem.ts`). Registry: one line per ecosystem in `COMPARATORS` in `src/check/match/index.ts` (see A2).
- `maven.ts`: Maven `ComparableVersion` order. Tokens split on `.`, `-` and digit/letter changes. Qualifier order `alpha`=`a` < `beta`=`b` < `milestone`=`m` < `rc`=`cr` < `snapshot` < `""`=`ga`=`final`=`release` < `sp`; an unknown qualifier sorts after `sp`, lexically, case-insensitive. Trailing null items trim (`1.0.0` = `1`). `1.2.3-SNAPSHOT` < `1.2.3`.
- `nuget.ts`: NuGet SemVer 2 with 1–4 numeric parts (`1.2.3.4`; missing parts are 0). Pre-release labels compare case-insensitive, numeric labels numerically. Build metadata (`+...`) is ignored.
- `hex.ts`: Elixir `Version` (strict SemVer 2, three parts, pre-release order, build ignored). Uses the `semver` package with `loose: false`.
- `pub.ts`: Dart `pub_semver`: SemVer 2 precedence, and build metadata breaks a tie (`1.2.3+1` > `1.2.3`, compared like a pre-release list).
- `apk.ts`: apk-tools version order. Dotted digit parts, an optional single letter, suffixes `_alpha` < `_beta` < `_pre` < `_rc` < (none) < `_cvs` < `_svn` < `_git` < `_hg` < `_p`, each with an optional number, then `-r<N>`. `1.2.3-r4` > `1.2.3-r3` > `1.2.3_rc1-r9`.
- `dpkg.ts`: Debian policy order. `[epoch:]upstream[-revision]`; epoch numeric (absent = 0); `verrevcmp` with `~` before everything, then end of string, then letters, then other characters; digit runs numerically. `1:2.3-4+deb12u1` > `2.9-1`; `2.3-4~deb12u1` < `2.3-4`.
- Edge cases each test pins: empty string, whitespace, leading `v` (valid only where the ecosystem allows: none of these six), `1.2.3-SNAPSHOT`, `1:2.3-4+deb12u1`, `1.2.3-r4`, a 4-part NuGet version, a version with only an epoch change.
VALIDATE: `npm test -- tests/check/maven.tcs-38.test.ts tests/check/nuget.tcs-38.test.ts tests/check/hex.tcs-38.test.ts tests/check/pub.tcs-38.test.ts tests/check/alpine.tcs-38.test.ts tests/check/debian.tcs-38.test.ts`; then the mutation check (D1): swap the sign of each `compare` once and confirm each file goes red.
SATISFIES: Scope 2 — "Version matchers for each (... one file per ecosystem ...). OSV range events (introduced, fixed, last_affected) drive all of them." and Acceptance "One test file per ecosystem under tests/check/: 10 known advisory ranges each ... including the qualifier and epoch edge cases."

### Task 3 — Release scope for Alpine and Debian advisories (C2)

`src/ingest/osv.ts`:
- `export const RELEASE_SCOPED: ReadonlySet<string> = new Set(["Alpine", "Debian"]);` (a name-to-code mapping, like `COMPARATORS`; not a business value).
- In `normalizeOsv`, the package key is `(scopeKey, component)` where `scopeKey` is the raw OSV string when `RELEASE_SCOPED.has(base)` and the raw string has a non-empty suffix, else the base. The `same` filter uses the same key. `qualifier` = the raw string. Source id for index > 0: `osvSourceId(v.id, i, scopeKey, component)` so `DSA-1#Debian:11/openssl` and `DSA-1#Debian:12/openssl` never collide.
- A bare `Debian` or `Alpine` (no release) entry: skipped for that package (a range without a release cannot be matched safely). If no package is left, the reason is `NOT_ENABLED_REASON`'s sibling `"no release on an OS package"`. The import route already counts a non-ok result as skipped.
- Packagist and every other ecosystem: unchanged (TCS-71 test "a plain and a suffixed entry for one name give one doc" keeps passing).
`src/check/match/index.ts`, `src/check/candidates.ts`, `src/check/run.ts`, `src/check/coverage.ts`:
- A dependency of an OS ecosystem has `ecosystem` = `Alpine:v3.18` / `Debian:12` (built by Task 5). `lookupEcosystem(e)` = `baseEcosystem(e)`. Candidate keys and `groupKey` use it, so the one existing `CANDIDATE_SQL` with `idx_advisories_component_ecosystem` serves the read.
- `matchAdvisory`: `baseEcosystem(dep.ecosystem) === advisory.ecosystem`, name equal, and when the base is release-scoped, `advisory.ecosystem_qualifier === dep.ecosystem`. A non-scoped dependency keeps today's exact rule (`dep.ecosystem === advisory.ecosystem`), so `npm` never matches a `Packagist:...` row.
- `supportsEcosystem("Debian")` (no release) is false; `supportsEcosystem("Debian:12")` is true; `supportsEcosystem("Maven:x")` is false (only release-scoped bases take a suffix).
- `coverageOwner("Debian:12")` → backfill row `Debian`. The coverage item echoes the dependency string `Debian:12`.
VALIDATE: `npm test -- tests/ingest/osv-release-scope.tcs-38.test.ts tests/ingest/osv-ecosystem-suffix.tcs-71.test.ts tests/ingest/osv-multi-package.tcs-46.test.ts tests/check/coverage.tcs-32.test.ts` (asserts: a DEBIAN-CVE fixture with `Debian:11` and `Debian:12` entries gives 2 docs with qualifiers `Debian:11`, `Debian:12`, distinct source ids and their own ranges; an import of it twice is `unchanged` on the second run; a `Debian:12` dependency at the Debian 11 fixed version is matched only against the Debian 12 doc).
SATISFIES: Scope 2 — "Alpine (apk version), Debian (dpkg version). OSV range events ... drive all of them." (A range from another release is not this package's range; without this task the Debian and Alpine results are wrong.)

### Task 4 — Lockfile parsers (C0: pom.xml, gradle.lockfile, packages.lock.json; C1: mix.lock, pubspec.lock)

New files in `src/check/parsers/`, each `(text) => ParseResult` with `ResultBuilder`, registered in `PARSERS` and `BY_NAME` (lowercase basename):
- `pom-xml.ts` (`pom.xml` → `Maven`): every `<dependency>` block in `<dependencies>` and `<dependencyManagement>`; name `groupId:artifactId`; `version` literal. `${prop}` resolves from `<properties>` of the same file; `${project.version}` resolves from the top-level `<version>`; anything else is skipped with reason `unresolved property`. No version: skipped `no version (managed by a parent)`. A file with no `<project` tag throws `LockfileParseError`. Regex parse with comments removed first (no XML library in the Worker bundle).
- `gradle-lockfile.ts` (`gradle.lockfile` → `Maven`): lines `group:artifact:version=configurations`; `empty=` and `#` lines ignored; any other line skipped `not a lock line`.
- `nuget-lock.ts` (`packages.lock.json` → `NuGet`): `dependencies.<framework>.<name>.resolved`; `type: "Project"` skipped `project reference`. Not JSON, or no `dependencies` object: `LockfileParseError`.
- `mix-lock.ts` (`mix.lock` → `Hex`): entries `"key": {:hex, :name, "version", ...}`; `:git` and `:path` entries skipped `not from hex`.
- `pubspec-lock.ts` (`pubspec.lock` → `Pub`): `packages:` map; `source: hosted` with `version: "x"`; `sdk`, `git`, `path` sources skipped `not hosted`. Indentation-based line reader (no YAML dependency added).
`src/check/parsers/types.ts`: `ParserId` gains `pom-xml`, `gradle-lockfile`, `nuget-lock`, `mix-lock`, `pubspec-lock`, `os-packages`.
`packages/cli/src/lockfiles.js`: add `pom.xml`, `gradle.lockfile`, `packages.lock.json`, `mix.lock`, `pubspec.lock`.
VALIDATE: `npm test -- tests/check/parsers.tcs-38.test.ts tests/check/parsers.tcs-4.test.ts tests/cli/lockfiles.tcs-38.test.ts tests/action/lockfiles.tcs-33.test.ts` (each recorded fixture gives its expected dependency count and three named `{ecosystem, name, version}` items; a broken file gives `LockfileParseError` → 400 through `POST /v1/check`).
SATISFIES: Scope 3 — "Lockfile parsers: pom.xml and gradle.lockfile, packages.lock.json, mix.lock, pubspec.lock" and Acceptance "Lockfile parser tests with a recorded fixture per file type."

### Task 5 — OS package list input (C2)

`src/check/parsers/os-packages.ts`: `parseOsPackages(os: "alpine" | "debian", release: string, text: string): ParseResult`.
- Release normalize: Alpine `3.18`, `v3.18`, `3.18.4` → `Alpine:v3.18`; Debian `12`, `12.5` → `Debian:12`. Anything else → `LockfileParseError` (400 that names the field).
- Alpine text (`apk list --installed`): line `<pkg>-<ver>-r<N> <arch> {<origin>} (<license>) [installed]`. Name = `origin` (OSV Alpine names are aports source packages); version = `<ver>-r<N>`. Dedupe on (origin, version).
- Debian text: `dpkg -l` lines with state `ii` (`ii  <name>[:arch]  <version>  <arch>  <desc>`), name = binary name with `:arch` removed; and two-column `dpkg-query -W -f='${source:Package} ${Version}\n'` lines (name = source package). Header lines (`Desired=`, `||/`, `+++-`) are ignored; other states (`rc`, `un`) skipped `not installed`.
`src/routes/check.ts`:
- JSON: `runtimes.alpine` / `runtimes.debian` (string release) plus top-level `os_packages` (string). Pull both OS keys out before `parseRuntimes`, so they are not reported as `unknown runtime`.
- Multipart: form fields `alpine` / `debian` (release) and `os_packages` (text). Read these three names before the lockfile loop; they do not count as lockfiles.
- 400 cases: release without `os_packages`; `os_packages` without a release; both `alpine` and `debian`; a bad release. Each 400 body names the field.
- `GET /v1/check?debian=12`: 400 `{ error: "debian= needs os_packages; send it with POST /v1/check" }`.
- The existing body cap (`check.max_body_bytes`, settings row) covers `os_packages`. No new limit.
VALIDATE: `npm test -- tests/check/os-input.tcs-38.test.ts tests/routes/check.tcs-9.test.ts` (asserts: a recorded `apk-installed.txt` with `alpine=3.18` and a seeded `Alpine:v3.18` advisory for `openssl` < `3.1.4-r1` reports `libcrypto3-3.1.4-r0` under its origin `openssl`; the same text with `alpine=3.19` does not match the 3.18 doc; each 400 case above; `debian` key is not in `skipped` as `unknown runtime`).
SATISFIES: Scope 3 — "for OS packages an apk list --installed or dpkg -l text block (/v1/check accepts them as runtime style inputs alpine= and debian= plus the package list)."

### Task 6 — Backfill options and docs (C0 adds Maven/NuGet; C1 Hex/Pub; C2 Alpine/Debian)

- `.github/workflows/backfill.yml`: add the six names to `ecosystem.options`.
- `docs/BACKFILL.md`: list the options; one paragraph: Alpine and Debian records hold one doc per release, so run them with `batch` 25 (about 4 releases × 5 D1 queries per record against the 1,000-query limit).
- The import route writes `backfill.coverage_since` and `done_at` per ecosystem (existing TCS-32 code). No code change.
VALIDATE: `grep -c -E '^\s+- (Maven|NuGet|Hex|Pub|Alpine|Debian)$' .github/workflows/backfill.yml` prints 6; `npm test -- tests/backfill/workflow.tcs-32.test.ts tests/check/coverage.tcs-32.test.ts`.
SATISFIES: Scope 4 — "Run the #32 backfill for each new ecosystem and record coverage_since." (The build delivers the option and the correct normalizer; the run itself is an operator step, listed in the PR body.)

### Task 7 — API docs (C0, C1, C2 each add their part)

- `docs/API.md`: Check section lists `pom.xml`, `gradle.lockfile`, `packages.lock.json`, `mix.lock`, `pubspec.lock`; one paragraph and one curl example for `alpine=`/`debian=` + `os_packages`, with the recommended `dpkg-query -W -f='${source:Package} ${Version}\n'` form and the note that `dpkg -l` binary names that differ from the source package do not match. Advisory `ecosystem` row and watch list text name the new ecosystems where they list OSV names.
- `site/docs.generated.ts`: `node scripts/gen-docs.mjs`.
VALIDATE: `node scripts/gen-docs.mjs && git diff --exit-code site/docs.generated.ts` (after commit) and `grep -c 'pubspec.lock' docs/API.md` ≥ 1.
SATISFIES: Scope 5 — "docs/API.md lists the lockfile names."

### Task 8 — Landing hook (C3)

`site/landing.ts`: the hook sentence becomes "Your agent runs on Node, PHP, Python, Go, Rust, Ruby, Java, .NET, Elixir, Dart, Alpine, Debian and the packages on top of them." The comment "Do not reword it" stays; the ticket is the client's own instruction to change this one sentence. All other landing copy unchanged.
VALIDATE: `npm test -- tests/routes/landing-ecosystems.tcs-38.test.ts tests/routes/site.tcs-10.test.ts` (GET `/` HTML contains each of `Java`, `.NET`, `Elixir`, `Dart`, `Alpine`, `Debian` in the hook paragraph).
SATISFIES: Scope 5 — "The landing hook names the new ecosystems."

### Task 9 — log4j acceptance through the production entry point (C0)

`tests/check/maven.tcs-38.test.ts` includes: import the real OSV record `GHSA-jfh8-c2jp-5v3q` (fixture) through `POST /v1/internal/import` with `ecosystem: "Maven"`, then `POST /v1/check` JSON `{"dependencies":[{"ecosystem":"Maven","name":"org.apache.logging.log4j:log4j-core","version":"2.14.1"}]}`; assert `affected[0].cve_ids` contains `CVE-2021-44228` and `fixed_in` is `2.15.0`; and `2.17.1` is not affected by that record.
The prod gate itself runs after deploy and after the Maven backfill (operator step in the PR body):
`curl -s -H 'Content-Type: application/json' -d '{"dependencies":[{"ecosystem":"Maven","name":"org.apache.logging.log4j:log4j-core","version":"2.14.1"}]}' https://tocsin.sh/v1/check | jq '[.affected[].cve_ids[]] | index("CVE-2021-44228") != null'` prints `true`.
VALIDATE: `npm test -- tests/check/maven.tcs-38.test.ts -t log4j`
SATISFIES: Acceptance — "Prod gate: after the backfill, POST /v1/check with Maven org.apache.logging.log4j:log4j-core 2.14.1 returns CVE-2021-44228."

### Task 10 — Query plan proof for the new keys (C0, extended in C2)

`tests/routes/check-plan.tcs-38.test.ts`: seed 20,000 advisories over all 12 OSV ecosystems (unique ids per test run), then `EXPLAIN QUERY PLAN` of `CANDIDATE_SQL` with keys `[["Maven","org.apache.logging.log4j:log4j-core"],["Debian","openssl"]]` uses `idx_advisories_component_ecosystem` and has no `SCAN advisories`.
VALIDATE: `npm test -- tests/routes/check-plan.tcs-38.test.ts`
SATISFIES: Repo iron rule 2 and rule 8 for the new query keys (feed reads are cheap); supports Scope 2.

## Edge cases

- Maven `1.2.3-SNAPSHOT` < `1.2.3`; `1.0` = `1.0.0` = `1`; `1.0-RC1` < `1.0`; `1.0-sp1` > `1.0`; qualifier case (`RC1` = `rc1`).
- OSV Maven records: some have only `versions[]` and no ranges; today's `rangesOf` path handles that (unchanged).
- NuGet `1.2.3.4` vs `1.2.3`; `1.0.0-Beta` = `1.0.0-beta`.
- Pub `1.2.3+1` > `1.2.3`.
- Debian epoch `1:2.3-4+deb12u1` > `2.9-1`; `~` sorts low; native package with no revision.
- Alpine `1.2.3-r4`; `_rc` and `_p` suffixes; a letter after the last digit (`1.2.3a`).
- A dependency in `Debian:12` with no Debian 12 doc for that advisory: not affected (and `partial_coverage` until `Debian` backfill `done_at`).
- A bare `Debian` dependency (from the JSON `dependencies[]` array without a release): `unsupported_ecosystem` skip, never clean.
- `pom.xml` with a parent-managed version: skipped with reason, never guessed (D26).
- Empty `os_packages`: 400 (D11: empty input aborts).
- Multipart with a lockfile AND OS input: both are checked in one answer.

## Iron laws that apply

- Additive-only schema: the migration is an `UPDATE` of one config row; no table, column or index change. D20: no DROP or DELETE statement.
- Indexes and EXPLAIN: no new table. The new keys use the existing `CANDIDATE_SQL` and `idx_advisories_component_ecosystem`; Task 10 proves it on 20,000 seeded rows.
- Retention: no new table. `backfill` grows by 6 rows (one per ecosystem, bounded). `advisories` keeps its rule in `docs/RETENTION.md` (advisories are history and are kept). Debian adds the largest volume (one doc per release per record); `docs/BACKFILL.md` records it.
- No per-row correlated subquery: none added.
- DB-driven config: the ecosystem list is the `osv` config row (Task 1). `RELEASE_SCOPED` and `COMPARATORS` are name-to-code maps, not business values. No new limit, rate or cap: the OS text is bounded by the existing `check.max_body_bytes` row; the import batch by `import.max_batch`.
- Dedup before spend: no metered call. OSV export and API are free and read only by the existing ingester and workflow.
- Idempotent ingestion on `(source, source_id)`: Task 3's source id includes the release, so two releases never share a key, and a re-run is `unchanged`.
- No LLM, no model id, no De-AI surface.
- UI rules (sortable headers, list over cards, drill-down): no new table or page. The landing change is one sentence.
- Secrets: none. No new env var.

## Performance (loader `/v1/check`)

- Reads: one `db.batch` (unchanged): feed cursor, N candidate chunks, optional Go toolchain read, two coverage reads. All run in one round trip.
- Statement count: unchanged formula, 3 + ceil(keys/200) (+1 for `go`). A check of 300 Maven deps is 5 statements.
- Indexes: `idx_advisories_component_ecosystem` (Task 10), `idx_advisories_cursor`, PK of `backfill`, PK of `sources`.
- Skeleton: none (JSON API, no page). Landing `/`: no new read.

## System invariants

(a) Cross-run state: the ecosystem list lives in `sources.config_json` of row `osv` (an operator knob, correct store). Advisory identity stays `advisory_sources (source, source_id)` PK; release-scoped source ids are `<id>#<Ecosystem:release>/<name>` for index > 0. The backfill watermark stays the `backfill` table keyed on `ecosystem` (base name). No new store.
(b) Side effects: none new in the request path. The backfill run (operator) uses the existing import route: success writes rows and counters; failure leaves `last_id` and no `done_at`, so coverage stays `partial` (never stamped done without data). `coverage_since` is written only by the final batch (existing).
(c) Adversarial negatives for the matcher (a wrong match is client-visible): must NOT match — `npm` dep vs a `Maven` row with the same name; `Debian:11` dep vs a `Debian:12` doc; `Debian` (no release) dep; `Alpine:v3.18` dep vs a `Debian:12` doc of the same package name; `Maven:https://x` dep (suffix on a non-scoped base); a `Packagist:...` row for an `npm` dep; a NuGet name in another case (`newtonsoft.json` vs `Newtonsoft.Json`, see A6). The tests in Tasks 2, 3 and 5 include each.
(d) Neighbors: the OSV cron reads `modified_id.csv` for each listed ecosystem (`max_csv_rows` 200,000 cap per list, existing); six more lists add six fetches per run against the existing `max_pages`/`page_size` budget, so the cron does more listing but the same record cap. The backfill workflow concurrency group is per ecosystem (unchanged). `osv` `sources.coverage_since` is write-once and already set; adding ecosystems never moves it. `/v1/status` coverage shows the six as incomplete until their runs finish. Watch lists: unchanged (A9). Open PRs #67/#68/#70/#73 take migrations 0017–0020; this plan takes 0021.

## Requirements coverage

| Requirement (ticket) | Task | Test |
|---|---|---|
| Six names in `osv` `ecosystems` row, migration, idempotent | 1 | `tests/worker/osv-ecosystems-migration.tcs-38.test.ts` |
| Maven matcher (qualifiers) | 2 | `tests/check/maven.tcs-38.test.ts` |
| NuGet matcher (SemVer 2, 4-part) | 2 | `tests/check/nuget.tcs-38.test.ts` |
| Hex matcher (semver) | 2 | `tests/check/hex.tcs-38.test.ts` |
| Pub matcher (semver) | 2 | `tests/check/pub.tcs-38.test.ts` |
| Alpine matcher (apk) | 2, 3 | `tests/check/alpine.tcs-38.test.ts`, `tests/ingest/osv-release-scope.tcs-38.test.ts` |
| Debian matcher (dpkg) | 2, 3 | `tests/check/debian.tcs-38.test.ts`, `tests/ingest/osv-release-scope.tcs-38.test.ts` |
| One file per ecosystem; registry as a folder | 2 | file list in Task 2; see A2 |
| OSV events introduced/fixed/last_affected drive all | 2 | each per-ecosystem test has at least one `last_affected` range |
| 10 known advisory ranges per ecosystem, affected and not affected | 2 | each per-ecosystem test (10 real OSV records, 1 affected + 1 not-affected version each) |
| Edge cases `1.2.3-SNAPSHOT`, `1:2.3-4+deb12u1`, `1.2.3-r4` | 2 | maven / debian / alpine tests |
| Parsers pom.xml, gradle.lockfile | 4 | `tests/check/parsers.tcs-38.test.ts` |
| Parser packages.lock.json | 4 | same |
| Parsers mix.lock, pubspec.lock | 4 | same |
| apk / dpkg text with `alpine=` / `debian=` | 5 | `tests/check/os-input.tcs-38.test.ts` |
| Recorded fixture per file type | 4, 5 | fixtures under `tests/fixtures/lockfiles/` |
| Backfill per new ecosystem, `coverage_since` recorded | 6 | `tests/backfill/workflow.tcs-32.test.ts` (options), import path in `tests/ingest/osv-release-scope.tcs-38.test.ts`; prod run is an operator step |
| Landing hook names the ecosystems | 8 | `tests/routes/landing-ecosystems.tcs-38.test.ts` |
| docs/API.md lists lockfile names | 7 | `grep` VALIDATE in Task 7 |
| Prod gate: log4j-core 2.14.1 → CVE-2021-44228 | 9 | `tests/check/maven.tcs-38.test.ts -t log4j` locally; curl after deploy + backfill |
| Out of scope: runtime ingesters, Docker scanning (negative) | — | no file under `src/ingest/*-runtime*` or Docker code in the diff (`git diff --name-only origin/main` check in review) |

## Acceptance tests

- `tests/check/maven.tcs-38.test.ts`: comparator order table (SNAPSHOT, RC, sp, trailing zeros, case); 10 real OSV Maven records (incl. `GHSA-jfh8-c2jp-5v3q` log4j) — each with one version inside and one outside its range via `matchAdvisory`; the log4j import + `POST /v1/check` test (Task 9); negative: same name as `npm` dep does not match.
- `tests/check/nuget.tcs-38.test.ts`: 4-part, case-insensitive pre-release, build ignored; 10 real OSV NuGet records in/out.
- `tests/check/hex.tcs-38.test.ts`: strict semver; 10 real OSV Hex records in/out.
- `tests/check/pub.tcs-38.test.ts`: build-metadata tie-break; 10 real OSV Pub records in/out.
- `tests/check/alpine.tcs-38.test.ts`: apk order (`1.2.3-r4`, `_rc`, `_p`, letter); 10 real OSV Alpine records in/out, each matched with its own `Alpine:vX.Y` dependency; one cross-release negative.
- `tests/check/debian.tcs-38.test.ts`: dpkg order (`1:2.3-4+deb12u1`, `~`, epoch); 10 real OSV Debian records in/out; cross-release negative; bare `Debian` dep is `unsupported_ecosystem`.
- `tests/ingest/osv-release-scope.tcs-38.test.ts`: `normalizeOsv` on a two-release Debian record and a two-branch Alpine record (doc count, qualifiers, source ids, ranges); Packagist record unchanged; re-import is `unchanged`.
- `tests/check/parsers.tcs-38.test.ts`: one recorded fixture per new file type (count + 3 named items + skip reasons); one broken file per type → `LockfileParseError`; `detectParser` case-insensitive names.
- `tests/check/os-input.tcs-38.test.ts`: through `POST /v1/check` JSON and multipart: apk origin match, dpkg-query source match, dpkg -l binary match, every 400 case, `GET ?debian=12` 400.
- `tests/routes/check-plan.tcs-38.test.ts`: EXPLAIN on 20,000 seeded rows, index used, no `SCAN advisories`.
- `tests/worker/osv-ecosystems-migration.tcs-38.test.ts`: default row, edited row, re-apply idempotence.
- `tests/routes/landing-ecosystems.tcs-38.test.ts`: hook paragraph names the six.
- `tests/cli/lockfiles.tcs-38.test.ts`: `LOCKFILE_NAMES` has the five names and `isLockfileName("POM.XML")` is true.
- Each test seeds its own rows with unique ids (no order dependence). No test calls a real vendor: OSV fixtures are recorded files (SCALABLE TESTS rule; OSV is fetched only once, by the builder, to record fixtures).

## QA screens

- `/` (landing): the hook sentence names Java, .NET, Elixir, Dart, Alpine, Debian. Check at 375 px that the paragraph wraps with no horizontal scroll.
- `/docs`: the Check section lists the new lockfile names and the OS input example.
- `/status`: the Coverage table shows six new rows, `complete` false until each backfill run ends.
- API: `POST /v1/check` with each recorded fixture (curl from the PR body).

## ASSUMPTIONS

- A1. Folder name: the ticket says `src/check/matchers/<ecosystem>.ts`; the repo's matcher folder is `src/check/match/`. I assumed the existing folder (one file per ecosystem there). Other reading: create `src/check/matchers/` beside it, which splits the matchers over two folders.
- A2. "The registry is a folder, not a list": a Worker bundle has no runtime directory read, and the repo has no generator for it. I assumed one import and one map line per ecosystem in `src/check/match/index.ts` (today's pattern). Other reading: a build-time generator that writes the registry from the folder; that is a new build step for all 18 matchers and its own ticket.
- A3. OS input shape: "runtime style inputs alpine= and debian= plus the package list". I assumed JSON `runtimes.alpine`/`runtimes.debian` plus a top-level `os_packages` string, and multipart fields `alpine`/`debian` plus `os_packages`. `GET` answers 400 because a query string has no package list. Other reading: a lockfile-style multipart field (`apk-installed.txt`) with the release inside the text.
- A4. Release scope: OSV writes `Alpine:v3.18` and `Debian:12`, and the TCS-71 normalizer merges releases into one doc. I assumed one doc per release for `Alpine` and `Debian` only (Task 3). Other reading: keep one merged doc and accept cross-release false positives. I rejected it as wrong data.
- A5. Package names: OSV Alpine and Debian name the source package. I assumed the apk `{origin}` as the name, and for Debian both `dpkg -l` binary names (ticket text) and the `dpkg-query ${source:Package}` form (recommended in docs). Other reading: `dpkg -l` only, which misses a binary whose name differs from its source (for example `libssl3` from `openssl`). The docs say so plainly.
- A6. NuGet names: NuGet ids are case-insensitive, but OSV stores the canonical case and the candidate query is exact. I assumed exact-case match (same as every other ecosystem except PyPI). Other reading: a lowercase expression index like the PyPI one (migration 0005); that is a new index and its own ticket if real lockfiles show case drift.
- A7. pom.xml is not a lockfile. I assumed direct dependencies with a literal or same-file property version only; a parent-managed version is skipped with a reason, never guessed. Other reading: resolve parent POMs over the network, which is a metered, non-deterministic fetch in the request path.
- A8. Backfill runs: the build cannot run the GitHub workflow against prod (no prod token on this box). I assumed the PR delivers the workflow options and the operator runs `backfill` once per new ecosystem after deploy (PR body lists the six runs and the log4j curl). Other reading: an automated run from CI on merge.
- A9. Watch lists: `src/watchlists/filter.ts` builds `KNOWN_ECOSYSTEMS` from `DEFAULT_ECOSYSTEMS`, so `POST /v1/watchlists` with `ecosystems: ["Maven"]` answers 400. The ticket does not name watch lists, and open PR #68 edits that file. I assumed no change here. Other reading: add the six names to `KNOWN_ECOSYSTEMS` in this ticket.
- A10. Landing copy: `site/landing.ts` says "Do not reword it". The ticket (the client) asks for the hook to name the new ecosystems. I assumed a change to that one sentence only.
- A11. `DEFAULT_ECOSYSTEMS` (the code fallback) stays at six names, because TCS-71 tests pin "Debian not enabled" on it. The migration writes the explicit list into the row instead.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section (copied verbatim)
TEST-CHANGE: <- ## Tests that must change (tests/worker/migrations.tcs-1.test.ts)
## Operator steps <- Task 6 / Task 9: backfill runs per ecosystem and the log4j curl
```

## Design collision check (BH-5791)

Checked 13 listed and 0 derived symbols against main 249c734302a8..249c734302a8 and 4 open PRs.
- `runCheck` (function, listed): PR #73 9a30a4263295, body or signature changed. Resolution: combine.
- `GET /v1/check` (function, listed): PR #70 bd89acb3c823, (text match). Resolution: combine.
- `POST /v1/check` (function, listed): PR #70 bd89acb3c823, (text match). Resolution: combine.
- `GET /v1/check` (function, listed): PR #68 dca953f2a735, (text match). Resolution: combine.
- `POST /v1/check` (function, listed): PR #68 dca953f2a735, (text match). Resolution: combine.

## Size

FILES: 24
LINES: 950
DIFF_KB: 160

KIND: feature
SIZE: XL

## Design collisions

- `runCheck`: combine — PR #73 (9a30a42) adds a local helper `runCheck(baseUrl)` in `tests/launch/launch-node-ledger.tcs-69.test.ts` that runs the CLI against a test worker; it does not touch `runCheck` in `src/check/run.ts`. The names only collide; this plan's `groupKey`/`lookupEcosystem` change to `src/check/run.ts` stands as written.
- `GET /v1/check`: combine — PR #70 (bd89acb) adds no route change; it only adds `/v1/check` rate-limit and 2 MB body-cap lines to `docs/API.md` (and the regenerated `site/docs.generated.ts`). Keep those lines, add this plan's `alpine=`/`debian=` 400 text to the Check section, and regenerate `site/docs.generated.ts` after the rebase.
- `POST /v1/check`: combine — PR #70 (bd89acb) changes only docs: the `check.max_body_bytes` 2 MB cap also bounds the new `os_packages` field and the new lockfiles, so this plan adds no second cap. Keep #70's docs lines, add the new lockfile names and the OS input paragraph, and regenerate `site/docs.generated.ts`.
- `GET /v1/check`: combine — PR #68 (dca953f) changes only the watch-list delivery paragraph in `docs/API.md` and the regenerated `site/docs.generated.ts`; no check code. This plan edits a different section; regenerate `site/docs.generated.ts` after the rebase.
- `POST /v1/check`: combine — PR #68 (dca953f) changes no check route or parser code, only docs text outside the Check section. This plan's Check-section edits apply on top; regenerate `site/docs.generated.ts` after the rebase.
