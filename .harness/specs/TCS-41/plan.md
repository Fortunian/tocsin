# TCS-41 plan: Deno and Bun runtime ingesters, /v1/check?deno=&bun=

Ticket: Fortunian/tocsin#41. Blocked-by #6 (CLOSED) and #39 (CLOSED). Both blockers are done.
Thread: 1 comment (bot, 2026-10-22T21:53:57Z). The latest state is "build". It is not on hold and not manual.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-22T21:16:03Z` shows TCS-50, TCS-46, TCS-49 and TCS-39. None of them adds a deno or bun ingester. `git log -S deno` shows only TCS-40, TCS-10, TCS-13, TCS-5 and TCS-4. Those added the `deno`/`bun` runtime names to the parser, the semver comparator and the CLI probes. No source row, no ingester and no GitHub-advisories client exists. `src/ingest/github-advisories.ts` does not exist.

CodeGraph: NOT AVAILABLE on this box. I found the file set with grep and by reading the code. The callers named below come from `grep -rn`.

## Live facts (probed 2026-10-23 in this session)

- `GET api.github.com/repos/denoland/deno/security-advisories?state=published&per_page=100&sort=published&direction=desc` answered 200 with 40 advisories on one page, and an ETag.
- The same call for `oven-sh/bun` answered 200 with `[]`. Bun has 0 published GitHub advisories today.
- Deno `vulnerabilities[]` data is not clean. Real values:
  - `package.ecosystem`/`name`: `rust/deno`, `deno/""`, `""/Deno`, `rust/denoland/deno`, `deno/node:crypto`, `composer/""`. Library crates also appear: `rust/deno_fetch`, `rust/deno_runtime`, `rust/deno_doc`, `rust/serde_v8`.
  - `vulnerable_version_range`: `<= 2.7.4`, `<=2.7.11`, `2.7.14`, `>=2.0.0`, `< v2.7.10`, ` >= v2.7.0`, `> 1.46.0 <= 2.1.6`, `<=2.1.12, <=2.2.12`, `<1.46.4, <2.1.2`, `1.5.0 - 1.10.1`, `=1.34.0`, `>= 1.9`.
  - `patched_versions`: `2.7.5`, `v2.7.10`, `2.2.15, 2.5.2`, `>= 2.2.5`, `2.1.13, >=2.2.13`, `2.1.13, 2.2.13, >=2.3.3`, ` 1.42.0`, `""` (GHSA-3j27-563v-28wf, range `>= 1.36.2, < 1.40.3`), `>= 1.32.1`.
- OSV `crates.io` has 38 records for package `deno` with the same CVEs (api.osv.dev query). The OSV ingester reads `crates.io` (`DEFAULT_ECOSYSTEMS`). So prod already holds these CVEs as `crates.io/deno` rows.
- Releases: deno `GET /releases?per_page=100` is 4 pages and about 4.9 MB per page. Tags look like `v2.9.8`. Bun's releases are 3 pages, with tags like `bun-v1.4.4`.

## The merge hazard (a key design point)

`upsertAdvisory` (src/ingest/upsert.ts:136-152) merges an incoming doc into ANY stored row that has the same primary CVE and no row from this source (`UPSERT_SQL.findByCve`). The creator keeps `ecosystem`/`component`. OSV already stored `crates.io/deno` rows for these CVEs. Without a change, every deno-runtime doc would merge into the crates.io row, no `deno/deno` row would exist, and `/v1/check?deno=` would answer nothing in prod. The reverse order also fails: if deno-runtime runs first, a later OSV crates.io record merges into the deno row and the crates.io match is lost. Task 2 fixes both directions. A CVE merge now happens only into a row with the same `ecosystem` AND `component`.

## Scope

1. Shared GitHub client `src/ingest/github-advisories.ts`. This is the seam and the only file that reads these api.github.com URLs. It does a conditional, paginated read of repository security advisories and a paginated read of releases.
2. A shared normalizer and ingester factory `src/ingest/github-runtime.ts`. The runtime name and URLs are parameters.
3. `src/ingest/deno-runtime.ts` and `src/ingest/bun-runtime.ts`. Each holds its defaults (code fallbacks for `sources.config_json`) and the factory call.
4. Migration `0013_deno_bun_runtime_sources.sql`. It adds the `deno-runtime` and `bun-runtime` source rows.
5. The registry gets two entries.
6. The CVE merge in upsert is limited to the same ecosystem and component.
7. Docs: RETENTION.md (sources count, new KV keys) and the env.ts comment.

Out of scope: Node and Python (ticket). CLI detection is already shipped (TCS-13). `packages/cli/src/check.ts:18-19` probes `bun --version` and `deno --version`, and `tests/cli/check.tcs-13.test.ts:127-138` pins it. `/v1/check` already accepts `deno=` and `bun=` (`src/check/parsers/runtimes.ts:3`) and matches them with semver (`src/check/match/index.ts:19-20`). No change is needed there; the new tests prove it end to end.

## Spec changes from comments

- 6352148268 board-harness-board: build against main now instead of waiting for #39 (#39 is now CLOSED). No scope change.

## Changed symbols

- const `defaultRegistry` (src/ingest/registry.ts): adds `"deno-runtime": denoRuntime` and `"bun-runtime": bunRuntime`. callers: left alone: `runIngesters`/`runCron` read the map unchanged.
- function `upsertAdvisory` / const `UPSERT_SQL.findByCve` (src/ingest/upsert.ts): the cross-source CVE merge matches only a stored row with the same `ecosystem` and `component`. callers: left alone: osv, node-runtime, php-runtime and python-runtime call it with the same signature. Only a merge across ecosystems changes, and that merge was wrong for them too.
- function `fetchAdvisoryPage` (new, src/ingest/github-advisories.ts): one conditional GET of one advisories page; returns `{notModified}` or `{body, etag?, next?}`.
- function `fetchReleasePage` (new, src/ingest/github-advisories.ts): one GET of one releases page; returns `{body, next?}`.
- function `nextLink` (new, src/ingest/github-advisories.ts): the `rel="next"` URL of a Link header, only on the allowed origin.
- function `normalizeGithubRuntimeAdvisory` (new, src/ingest/github-runtime.ts): GHSA JSON + runtime options -> AdvisoryInput, or a reason.
- function `parseRangeBounds`, `fixesFrom`, `rangesFor` (new, src/ingest/github-runtime.ts): pure range parsers.
- function `githubRuntimeIngester` (new, src/ingest/github-runtime.ts): builds an `Ingester` for one runtime.
- const `denoRuntime`, `DENO_DEFAULTS` (new, src/ingest/deno-runtime.ts); const `bunRuntime`, `BUN_DEFAULTS` (new, src/ingest/bun-runtime.ts).
- format `sources` rows `deno-runtime`, `bun-runtime` (migration 0013).
- format KV keys `cursor:deno-runtime`, `cursor:bun-runtime` (published_at cursor) and `deno-runtime:etag`, `bun-runtime:etag` (ETag of advisories page 1).

Open PR #56 (TCS-30) edits `runIngesters` and `RunResult` in src/ingest/registry.ts and src/ingest/types.ts, and appends to the end of docs/RETENTION.md. This plan does not change those symbols. In registry.ts it edits only the imports and the `defaultRegistry` literal. In RETENTION.md it edits only the `## sources` section and inserts new sections directly after it, not at the end of the file. So no Design-collisions section is needed. A textual rebase on registry.ts imports is possible and trivial.

## Design collisions

- `sources` (main 07a977891e95, TCS-30): combine — TCS-30 adds no row and no column. It adds the knob `dist_cache_seconds` to `config_json` of row `node-runtime` only, and it puts a per-post `RunResult.summary` before the detail in `sources.last_error`. The new rows `deno-runtime`/`bun-runtime` keep their own `config_json` keys (`DENO_DEFAULTS`/`BUN_DEFAULTS`), use the same knob-with-fallback pattern, and may leave `summary` unset. Rebase onto main before T6. Put the RETENTION.md edits in `## sources` and directly after it, not after the new `## KV node-dist-index` and `## KV cursor:node-runtime:parser` sections at the end of the file.
- `sources` (PR #31 3dcc73db75bf, TCS-14): combine — PR #31 changes no `sources` row. Its local launch worker runs `UPDATE sources SET enabled = 0 WHERE id NOT IN ('node-runtime','php-runtime')`, so the two new rows stay disabled there and its outbound fake needs no GitHub URL. Its prod check fails any enabled `/v1/status` source with `last_ok_at` NULL or older than 24 h. So the deno and bun ingesters must count a run with 0 advisories (bun today) or a 304 as ok, with no error, so `last_ok_at` advances on every cron tick. T4 already gives that result through `runIngesters`.

## Files to touch

Product code:
- `src/ingest/github-advisories.ts` (new)
- `src/ingest/github-runtime.ts` (new)
- `src/ingest/deno-runtime.ts` (new)
- `src/ingest/bun-runtime.ts` (new)
- `src/ingest/registry.ts`
- `src/ingest/upsert.ts`
- `src/env.ts` (comment on GITHUB_TOKEN users only)
- `migrations/0013_deno_bun_runtime_sources.sql` (new)

Docs:
- `docs/RETENTION.md`

Tests and fixtures (new, per ticket):
- `tests/ingest/deno-runtime.tcs-41.test.ts`
- `tests/ingest/bun-runtime.tcs-41.test.ts`
- `tests/ingest/github-runtime-normalize.tcs-41.test.ts`
- `tests/ingest/upsert-component-merge.tcs-41.test.ts`
- `tests/ingest/github-fake.tcs-41.ts` (test-mode fake for the seam: URL -> {status, body, headers}; records calls and request headers; throws on an unmapped URL)
- `tests/fixtures/deno-runtime/advisories.json`, `tests/fixtures/deno-runtime/releases.json`, `tests/fixtures/deno-runtime/README.md`
- `tests/fixtures/bun-runtime/advisories-empty.json`, `tests/fixtures/bun-runtime/advisories-synthetic.json`, `tests/fixtures/bun-runtime/releases.json`, `tests/fixtures/bun-runtime/README.md`

Tests of other tickets that must change (see below):
- `tests/cron/run.tcs-2.test.ts`
- `tests/routes/site.tcs-10.test.ts`
- `tests/routes/status-ledger.tcs-50.test.ts`
- `tests/worker/migrations.tcs-1.test.ts`
- `tests/routes/site-freshness.tcs-35.test.ts`

## Tests that must change

- `tests/cron/run.tcs-2.test.ts`: the registry key list (line 134) gains `bun-runtime` and `deno-runtime`.
- `tests/routes/site.tcs-10.test.ts`: the `/v1/status` source id list (line 249) gains `bun-runtime` and `deno-runtime`.
- `tests/routes/status-ledger.tcs-50.test.ts`: the seeded source count (lines 72, 90) is 9, not 7.
- `tests/worker/migrations.tcs-1.test.ts`: `SOURCES` (line 17) and the "seeds the 7 sources" case gain the two rows (9).
- `tests/routes/site-freshness.tcs-35.test.ts`: `SOURCES` (line 11) gains two; "7 of 7" becomes "9 of 9" and "6 of 7" becomes "8 of 9".

Each edit changes only the count or list premise that the new migration changes. No assertion is removed or loosened.

## Verify (run, not edited)

- `npm test` (all four vitest projects)
- `npm run typecheck`
- `npm run migrate:local`
- `tests/ingest/upsert.tcs-2.test.ts` (merge and EXPLAIN cases: regression risk from task 2)
- `tests/ingest/python-runtime.tcs-39.test.ts`, `tests/cron/runtime-ingest.tcs-6.test.ts`, `tests/cron/warnings.tcs-50.test.ts` (each runs `defaultRegistry` with other sources disabled; the new rows must stay disabled there)
- `tests/routes/check.tcs-9.test.ts`, `tests/routes/check-plan.tcs-9.test.ts`, `tests/check/match.tcs-5.test.ts`
- `tests/ingest/osv-multi-package.tcs-46.test.ts` (OSV upserts that share a CVE)

## Tasks

### T1. Seam: `src/ingest/github-advisories.ts`
- `fetchAdvisoryPage(fetchFn, url, token, etag?)` sends `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` and `User-Agent: tocsin.sh`. It adds `Authorization: Bearer <token.trim()>` only when the token is non-blank, and `If-None-Match` only when an ETag is given. A 304 returns `{notModified: true}`. A non-2xx throws `GithubHttpError(status, url)`. A body that is not a JSON array throws.
- `fetchReleasePage(fetchFn, url, token)` uses the same headers and never sends a conditional header.
- `nextLink(linkHeader, allowedOrigin)` returns the `rel="next"` URL. A next link on another origin throws `GithubLinkError`, and that URL is never fetched (same rule as `NodeLinkError`).
- The first page URL is `<advisories_url>?state=published&sort=published&direction=desc&per_page=<page_size>`. The releases URL is `<releases_url>?per_page=100`.
- This is the only file that fetches these URLs. The fetch function is injected.
VALIDATE: `npx vitest run tests/ingest/deno-runtime.tcs-41.test.ts -t "seam"`. The cases assert: the token header is present only when GITHUB_TOKEN is set; If-None-Match is sent on the second run; a foreign-origin next link is not fetched (the fake records 0 calls to it) and the run fails; an HTTP 403 throws and leaves the cursor and ETag unchanged.
SATISFIES: "the two ingesters share one GitHub-advisories client module (`src/ingest/github-advisories.ts`)" and "source = … GitHub security advisories endpoints (published, paginated, `GITHUB_TOKEN`)".

### T2. Merge only within the same ecosystem and component (`src/ingest/upsert.ts`)
- Change `UPSERT_SQL.findByCve` to: `SELECT a.id, a.doc_json FROM advisories a WHERE a.cve_primary = ?1 AND +a.ecosystem = ?3 AND +a.component = ?4 AND NOT EXISTS (SELECT 1 FROM advisory_sources s WHERE s.advisory_id = a.id AND s.source = ?2) ORDER BY a.cursor LIMIT 1`. The unary `+` keeps the plan on `idx_advisories_cve_primary` (same device as `GO_RUNTIME_CANDIDATE_SQL`). Numbered params keep positions 1 and 2 as they were.
- `upsertAdvisory` binds `(cvePrimary, key.source, doc.ecosystem, doc.component)`.
- Add a one-line comment at the merge that says why.
VALIDATE: `npx vitest run tests/ingest/upsert-component-merge.tcs-41.test.ts tests/ingest/upsert.tcs-2.test.ts`. Case A: an OSV `crates.io/deno` doc with CVE-X is stored first, then the deno-runtime doc with CVE-X. The result is two rows; the deno row has `ecosystem='deno'`; the crates.io row's sources are still only `osv`. Case B is the reverse order and gives the same two rows. Case C: same ecosystem and component from two sources still merges into one row (the existing tcs-2 case stays green). Case D: EXPLAIN QUERY PLAN of the new `findByCve` on 2,000 seeded rows uses `idx_advisories_cve_primary` and has no `SCAN advisories`.
SATISFIES: "`/v1/check?deno=2.1.0&bun=1.1.30` … feed them" (in prod the deno advisories would otherwise merge into the existing crates.io rows and never match a `deno` check).

### T3. Normalizer: `src/ingest/github-runtime.ts` (pure part)
Input: one GHSA object from the list, plus `{runtime, excludePackage: RegExp, released?: Set<string>}`. Output: `{ok: true, doc}`, `{ok: false, reason, needsReleases: true}` or `{ok: false, reason}` (terminal).
Rules, in order:
1. Skip with no advisory (terminal, reason) when `state !== "published"`, when `withdrawn_at != null`, or when `ghsa_id` does not match the GHSA pattern.
2. Runtime entries: each `vulnerabilities[]` entry whose `package.name` does NOT match `exclude_package_pattern` (default `_`, so `deno_fetch`, `deno_runtime`, `deno_doc` and `serde_v8` drop out). `""`, `deno`, `Deno`, `denoland/deno` and `node:crypto` are kept. The package ecosystem is ignored, because the repo is the runtime's own repo. If no entry is left, the advisory is terminal: "no <runtime> package entry".
3. Per entry, `parseRangeBounds(vulnerable_version_range)` tokenises `(<=|>=|<|>|=)?\s*v?(\d+(\.\d+){0,2})` and the form `A - B`. Versions pad to 3 parts. It returns `lower` (`>= X` -> X; `> X` -> X with patch+1; a bare `X` or `= X` -> X; `A - B` -> A; none -> `"0"`), `lt[]` (each `< X`) and `le[]` (each `<= X`).
4. Fixes (`fixesFrom`): parse `patched_versions` by splitting on `,`, stripping `>=`, `v` and spaces, and padding to 3 parts. Keep only `^\d+\.\d+\.\d+$`. These are authoritative. Add each `lt` value whose `major.minor` line no patched fix covers (so GHSA-f27p `<1.46.4, <2.1.2` + patched `2.1.2` gives fixes 1.46.4 and 2.1.2).
5. If the fix list is empty (only GHSA-3j27 in today's data):
   - For each `lt` X: X is a fix if `released` has X.
   - Else, for each `le` X: the fix is the lowest released version above X.
   - If `released` is not loaded yet, return `needsReleases`.
   - If it is loaded and nothing qualifies, the advisory is terminal: "no fixed <runtime> version".
6. Ranges (`rangesFor`): sort the fixes by semver to f1..fn. The first range is `{introduced: lower, fixed: f1}`. Range i>1 is `{introduced: <major>.<minor+1>.0 of f(i-1), fixed: fi}`. So `2.2.15, 2.5.2` gives `[0,2.2.15)` and `[2.3.0,2.5.2)`, and `2.3.4` is affected with fixed_in `2.5.2`. If `lower` is not below f1, introduced is `"0"`.
7. Doc fields:
   - `ecosystem = component = runtime`.
   - `cve_ids`: `[cve_id]` when it matches the CVE pattern, else `[]`. `ghsa_id`: ghsa_id.
   - `affected` and `fixed_versions` come from the union of the runtime entries (deduplicated, sorted).
   - `severity`: label from `severity` (`moderate` -> `medium`, unknown otherwise); score from `cvss_severities.cvss_v4.score`, then `cvss_v3.score`, when it is a number from 0 to 10.
   - `published_at`/`modified_at`: from `published_at`/`updated_at` (pattern-checked; modified falls back to published).
   - `summary`: `oneLine(summary)`, else the CVE id, else the GHSA id.
   - `action`: "Upgrade deno to 2.7.5 or later." or "Upgrade deno to 2.2.15 (2.2.x) or 2.5.2 or later." (≤200 chars, else the lowest fix only; same shape as node-runtime).
   - `references`: `[html_url]` when it is http(s), plus `https://www.cve.org/CVERecord?id=<cve>` when there is a CVE.
   - `sources`: `[{source: "<runtime>-runtime", source_id: ghsa_id, url: html_url}]`.
VALIDATE: `npx vitest run tests/ingest/github-runtime-normalize.tcs-41.test.ts`. A table test asserts each real string from "Live facts" (range -> lower/lt/le; patched -> fixes; ranges and fixed_in for 2 or more versions per row, on both sides of every bound).
SATISFIES: "`fixed_in` from `patched_versions`, releases from the GitHub releases endpoint when a patched version is missing" and "Ecosystems `deno` and `bun`, components `deno` and `bun`".

### T4. Ingester run: `githubRuntimeIngester(source, defaults)` in `src/ingest/github-runtime.ts`
Per run:
1. Read the config with `readRuntimeConfig` and the defaults. Validate that `exclude_package_pattern` compiles as a RegExp and that `release_tag_prefix` is non-empty; otherwise throw.
2. Read KV `cursor:<source>` and `<source>:etag`.
3. Page 1 with If-None-Match. On a 304: return all-zero, write nothing (dedup before spend: nothing changed upstream).
4. Read pages in published-desc order. Stop when an item has `published_at < cursor` (strictly less, so items at the cursor are re-read and come back `unchanged`), when there is no next link, or at `max_pages`. At the cap: `result.incomplete = true` and an error "more than <max_pages> pages" (the source shows failed, D12). The cursor and the ETag are NOT written, so nothing is skipped silently.
5. For each item, newest last (sorted ascending):
   - normalize.
   - If it needs releases: first run `SELECT 1 FROM advisory_sources WHERE source = ? AND source_id = ?` (dedup before the releases read; PK seek). On a hit, count it `unchanged` and skip. Else load releases once per run: up to `max_release_pages` pages; keep `draft === false && prerelease === false` tags that match `^<prefix>(\d+\.\d+\.\d+)$`. Then normalize again.
   - `ok` -> `upsertAdvisory(db, doc, {source, source_id: ghsa_id})`. inserted/updated -> `upserted`, unchanged -> `unchanged`. `InvalidAdvisoryError` -> `errors`.
   - A terminal skip -> `warnings` (sources.last_warning, the run stays ok). Reported once, because the cursor then moves past it.
6. After the whole run, with no cap hit: write the cursor as the max `published_at` seen (never lower than the stored one), and write the ETag from page 1 (or delete it when page 1 had none).
7. HTTP and D1 errors throw out of the run, and the cursor and ETag stay as they were.
`fetched` = items read from the list.
VALIDATE: `npx vitest run tests/ingest/deno-runtime.tcs-41.test.ts tests/ingest/bun-runtime.tcs-41.test.ts`.
SATISFIES: "Cursor on `published_at`; dedup before the metered read" and "a second run yields `unchanged`".

### T5. `src/ingest/deno-runtime.ts` and `src/ingest/bun-runtime.ts`
`DENO_DEFAULTS`:
- `advisories_url: "https://api.github.com/repos/denoland/deno/security-advisories"`
- `releases_url: "https://api.github.com/repos/denoland/deno/releases"`
- `release_tag_prefix: "v"`
- `exclude_package_pattern: "_"`
- `page_size: 100`, `max_pages: 10`, `max_release_pages: 5`

`BUN_DEFAULTS` is the same with `oven-sh/bun` and `release_tag_prefix: "bun-v"`.

Each file exports `denoRuntime = githubRuntimeIngester("deno-runtime", "deno", DENO_DEFAULTS)` (bun the same). Each default has a comment that says it is the code fallback for `sources.config_json` of its row (repo iron rule 5).
VALIDATE: `npx vitest run tests/ingest/deno-runtime.tcs-41.test.ts -t "config"`. A `config_json` override of `max_pages: 1` changes the page cap. A bad regex throws and the source shows failed.
SATISFIES: "`src/ingest/deno-runtime.ts` and `src/ingest/bun-runtime.ts` (+ client seams and fixtures)".

### T6. Migration `migrations/0013_deno_bun_runtime_sources.sql` + registry
- `INSERT OR IGNORE INTO sources (id, kind, enabled, config_json) VALUES ('deno-runtime','deno-runtime',1,'{}'), ('bun-runtime','bun-runtime',1,'{}');` with a header comment in the style of 0009. Additive only. No new table.
- In `src/ingest/registry.ts`, import the two ingesters and add the two keys to `defaultRegistry`.
VALIDATE: `npm run migrate:local && npx vitest run tests/worker/migrations.tcs-1.test.ts tests/cron/run.tcs-2.test.ts`.
SATISFIES: "`sources` rows (migration)".

### T7. End to end through the production entry and `/v1/check`
In each ingest test file: disable every other source, mock `globalThis.fetch` with the github fake, and run `runIngesters(env, defaultRegistry, …)` (production registry, D2). Then `SELF.fetch("https://tocsin.sh/v1/check?deno=2.1.0&bun=1.1.30")` through the worker:
- `deno=2.1.0` returns GHSA-2x3r-hwv5-p32x (`> 1.46.0 <= 2.1.6`, patched 2.1.7) with `fixed_in: "2.1.7"`.
- `deno=2.1.7` does not return it.
- The bun cases use the synthetic page.
VALIDATE: `npx vitest run tests/ingest/deno-runtime.tcs-41.test.ts -t "check"` and `npx vitest run tests/ingest/bun-runtime.tcs-41.test.ts -t "check"`.
SATISFIES: "`/v1/check` returns them for an old version and not for the patched one."

### T8. Fixtures
- `tests/fixtures/deno-runtime/advisories.json`: the real page-1 answer recorded with the T1 URL. Keep about 10 whole entries, each unedited, chosen to cover the decision table:
  - x2qc (`deno/""`, `<= 2.7.4`)
  - 7xh3 (`v` prefixes)
  - m2gf (two patched lines)
  - xqxc (three lines + `>=`)
  - 2x3r (`>` lower bound)
  - f27p (crate entry + `<` adds a fix)
  - 3j27 (empty patched)
  - vc52 (`=` + crate)
  - m3c4 (composer misfile)
  - 5379 (`node:crypto`)
- `tests/fixtures/deno-runtime/releases.json`: a real releases page that contains `v1.40.3`. Per entry keep only `tag_name`, `draft`, `prerelease` and `published_at`, with values unedited (a whole page is about 4.9 MB). Include one prerelease or draft entry if the page has one.
- `tests/fixtures/bun-runtime/advisories-empty.json`: the real `[]` answer.
- `tests/fixtures/bun-runtime/advisories-synthetic.json`: ONE hand-written entry in the GitHub schema shape. The README marks it SYNTHETIC: Bun has no published advisory to record, and this file proves only the code path, never a published fact.
- `tests/fixtures/bun-runtime/releases.json`: real bun release tags, trimmed the same way.
- Each README lists the URL, the UTC record time, the HTTP status, the recorded ETag, the sha256 of the recording and the trim rule (same format as `tests/fixtures/python-runtime/README.md`).
VALIDATE: `sha256sum tests/fixtures/deno-runtime/* tests/fixtures/bun-runtime/*` matches the README lines, and the bun README contains the word `SYNTHETIC`.
SATISFIES: "(+ client seams and fixtures)" and "a recorded page".

### T9. Docs
In `docs/RETENTION.md`:
- In `## sources`, change the count from 7 to 9 and add `deno-runtime` and `bun-runtime` to the list.
- Directly after that section (not at the end of the file), add `## KV cursor:deno-runtime, cursor:bun-runtime` and `## KV deno-runtime:etag, bun-runtime:etag`. Each is one key per source, overwritten in place, with no delete job.

In `src/env.ts`, the GITHUB_TOKEN comment names deno-runtime and bun-runtime too.
VALIDATE: `grep -n "deno-runtime" docs/RETENTION.md src/env.ts` shows both, and `grep -c "^## " docs/RETENTION.md` goes up by 2.
SATISFIES: repo iron rule 2 ("every table ships with … a retention rule"; here, every new KV key) for "Cursor on `published_at`".

## Iron laws: how they apply

- Sortable headers, list-over-cards, drill-down, mobile: n/a, no UI change. `/status` lists the two new rows through the existing table.
- DB-driven config: every URL, cap, prefix and pattern is a key of `sources.config_json` with a code fallback (`DENO_DEFAULTS`/`BUN_DEFAULTS`). The cadence is the existing cron. No new literal limit lacks a knob. The literal `100` for the releases `per_page` is the GitHub maximum, not a business limit. Put it in config as `release_page_size` too, so no literal stays.
- RLS: n/a (D1, not Supabase).
- Indexes: no new table. New query: the releases dedup seek `SELECT 1 FROM advisory_sources WHERE source=? AND source_id=?` on the PK `sqlite_autoindex_advisory_sources_1`. Changed query: `findByCve`. Both get EXPLAIN tests on 2,000 seeded rows (T2 case D; a deno test case for the dedup seek).
- No per-row correlated subquery over a large table: `findByCve`'s NOT EXISTS runs per candidate row of ONE CVE (index seek), as today.
- Retention: no new table. New KV keys are one per source, overwritten in place (T9).
- De-AI: no LLM. Summaries come from GHSA text; actions are computed.
- Dedup before spend (metered GitHub API):
  - Page 1 is conditional on the stored ETag; a 304 ends the run.
  - The published_at cursor stops pagination.
  - The releases read runs only for an advisory with no patched version that is NOT already in `advisory_sources` (persisted check before the call), at most once per run.
  - A 200 with an empty list is a complete, billed, terminal answer: the ETag is stored and the cursor is unchanged.
  - The ledger key is `(source, ghsa_id)`, a stable id, never a URL.
- Exactly-once / idempotent: `upsertAdvisory` on `(source, source_id=ghsa_id)`; a re-run is `unchanged`.
- Model id: none.
- Scalable tests:
  - Seam: `src/ingest/github-advisories.ts`.
  - Fake: `tests/ingest/github-fake.tcs-41.ts` (0 network; throws on an unmapped URL; `globalThis.fetch` is spied to throw in each file's `beforeEach`, as in python-runtime.tcs-39).
  - Contract test: none added. The repo has no real-vendor contract suite for GitHub yet; see ASSUMPTIONS.
  - Each test seeds unique ids, clears its own KV keys and resets `enabled` in `finally`.

## Build-discipline rules that bite

- D1/D2: mutation-check the range rules. Run through `runIngesters(env, defaultRegistry)`, not only the pure normalizer.
- D4: normalizer inputs are the recorded real entries, except the one SYNTHETIC bun entry, which is labelled.
- D9/D11: an empty `patched_versions` is not "no fix needed". A 304 with no stored cursor is not "done". A 403 is a failure, never an empty success.
- D12: at the page cap, set `incomplete` plus an error, and write no cursor.
- D13: the warning text is true in every state.
- D20: the migration has only INSERT OR IGNORE.
- D25: no change to python-runtime, the CLI or the check code.
- D26: no invented GHSA ids in the deno fixtures.

## ASSUMPTIONS

- Bun has 0 published GitHub security advisories (probed 2026-10-23). I assumed the bun ingester ships anyway, proven with the real empty page and one SYNTHETIC entry labelled in its README. Other reading: find another Bun advisory source. That is out of the ticket's stated source, so it would be a new ticket.
- The ticket says python-runtime "also uses" the shared client "when it lands". Python landed (TCS-39) on the PSF database because `python/cpython` advisories are empty. I assumed python-runtime is left alone. Other reading: move its GitHub listing call onto the new seam. That is a refactor with no user effect.
- The CVE merge across ecosystems (src/ingest/upsert.ts) is limited globally to the same ecosystem+component. Without this, prod deno docs merge into the existing OSV `crates.io/deno` rows and `/v1/check?deno=` stays empty. Other reading: an opt-in flag for only the two new sources. That leaves the reverse order (OSV after deno-runtime) and node-vs-npm CVEs merging wrongly.
- An entry is a runtime entry unless its package name matches `exclude_package_pattern` (default `_`; a knob). Other reading: an allow-list of names. That would drop GHSA-5379 (`node:crypto`, critical) and GHSA-m3c4 (`composer/""`).
- `patched_versions` is authoritative per release line. A `< X` bound adds a fix only for a line that patched does not cover. Other reading: take the lowest of the two per line (GHSA-23rx says `< 1.43.0` but patched `1.43.1`). That under-reports 1.43.0.
- `> X` becomes introduced = X with patch+1. A bare `X` or `= X` becomes introduced X.
- An advisory with no derivable released fix is not published. It becomes a warning, and the cursor moves past it. Other reading: publish it with `last_affected` and no upgrade action. Iron rule 10 (a fact from a source) made me choose the conservative path.
- The cursor is on `published_at` (ticket), so a later edit of an old advisory (for example a patched version added) is not re-read. To re-read everything, an operator deletes KV `cursor:<source>` and `<source>:etag`; the upserts are idempotent.
- Releases come from the GitHub releases endpoint (ticket), even though the git tag refs would be lighter. It is read only in the rare no-patched-version case. Today that is 1 of 40 deno advisories, and it is already deduped after the first store.
- No new real-vendor contract test. The repo has no GitHub contract suite. I added none, to keep the PR path at 0 vendor calls. A contract suite is its own ticket.
- The CLI part of "the CLI's detection feed them" is already shipped (TCS-13) and pinned by `tests/cli/check.tcs-13.test.ts:127-138`. No CLI change.

## System invariants

(a) Cross-run state:
- KV `cursor:<source>` (published_at; written only after a full run with no cap hit; never moves backwards).
- KV `<source>:etag` (ETag of page 1; written only with the cursor; deleted when absent).
- The dedup store for records is `advisory_sources (source, source_id)`, a real table with a natural PK. No config-JSON state.

(b) External side effects. The GitHub reads are the only side effect.
- On success: upserts, then the cursor and the ETag, in that order. A crash between them re-reads, and the result is `unchanged`.
- On failure (HTTP/D1 throw): nothing is written to KV, and the source is marked failed by `runIngesters`.
- With no token: unauthenticated reads (60/h per IP). Each run makes at most 1 call per source when nothing changed (304), so it works.
- A 304 never stamps progress it did not make.

(c) Negatives for the package filter. These must NOT become runtime entries: `deno_fetch`, `deno_runtime`, `deno_doc`, `serde_v8`. These MUST stay: `""`, `deno`, `Deno`, `denoland/deno`, `node:crypto`, `bun`.
Negatives for the merge: a `crates.io/deno` row and a `deno/deno` doc with the same CVE must NOT merge. An `npm/x` and a `node/node` doc with the same CVE must NOT merge.
Negatives for ranges: `2.2.16` with fixes `2.2.15, 2.5.2` is NOT affected. `1.46.0` with `> 1.46.0` is NOT affected. The patched version itself is NOT affected.

(d) Neighbours:
- The cron `*/10` runs all enabled sources in sequence. Two more sources add 2 GitHub calls per tick at most (1 when 304).
- python-runtime and php-runtime share `GITHUB_TOKEN`'s 5,000/h budget. The worst case is about 12/h per source plus a rare releases read (5 pages).
- `sources` grows from 7 to 9 rows. The `/status` and home freshness lines count them (see Tests that must change).
- PR #56 (TCS-30) touches other symbols in registry.ts and types.ts.
- No lock and no queue.

## Requirements coverage

| Requirement (ticket) | Task | Test |
|---|---|---|
| `src/ingest/deno-runtime.ts` + seam + fixtures | T1, T5, T8 | deno-runtime.tcs-41 "seam", "config" |
| `src/ingest/bun-runtime.ts` + seam + fixtures | T1, T5, T8 | bun-runtime.tcs-41 |
| Source = denoland/deno and oven-sh/bun GH security advisories, published, paginated, GITHUB_TOKEN | T1, T4 | deno "paginates via Link next", "token header" |
| `fixed_in` from `patched_versions` | T3 | github-runtime-normalize.tcs-41 table |
| Releases endpoint when a patched version is missing | T3, T4 | deno "GHSA-3j27 uses releases; 1 releases read; a second run makes 0 releases reads" |
| Ecosystems `deno`/`bun`, components `deno`/`bun` | T3, T2 | deno and bun "stored row ecosystem/component" + upsert-component-merge |
| `sources` rows (migration) | T6 | migrations.tcs-1 (changed), deno "row exists" |
| `/v1/check?deno=2.1.0&bun=1.1.30` | T7 | deno/bun "check" cases |
| The CLI's detection feeds them | already shipped (TCS-13) | tests/cli/check.tcs-13.test.ts:127-138 (run, unchanged) |
| Cursor on `published_at` | T4 | deno "stops at an item older than the cursor; never moves back" |
| Dedup before the metered read | T4 | deno "304 ends the run with 0 writes", "advisory_sources hit skips the releases read" |
| Shared client module `github-advisories.ts` | T1 | both test files import the ingesters, which use only that seam (fake call log shows only its URLs) |
| A recorded page yields advisories with the right `fixed_in` | T3, T4, T8 | deno/bun "first run" |
| A second run yields `unchanged` | T4 | deno/bun "second run" |
| `/v1/check` returns them for an old version, not the patched one | T7 | deno/bun "check" |
| Negative: Node and Python out of scope (no change) | none | `git diff --stat` touches no node-runtime/python-runtime file |

## Acceptance tests

`tests/ingest/deno-runtime.tcs-41.test.ts` (vitest, api project, through `runIngesters(env, defaultRegistry)` with only `deno-runtime` enabled and `globalThis.fetch` mocked by the github fake):
1. First run on the recorded page:
   - `upserted` equals the count of fixture entries that yield a doc.
   - Each stored doc has `ecosystem='deno'` and `component='deno'`.
   - GHSA-x2qc gives `fixed_versions ["2.7.5"]`; m2gf gives `["2.2.15","2.5.2"]`; xqxc gives 3 ranges; f27p gives fixes 1.46.4 and 2.1.2; 3j27 gives fixed 1.40.3 from releases.
   - The crate-only entries never produce a doc.
2. Second run with the fake answering 304 to the stored ETag: the result is all zero, and `advisories` count and max cursor are unchanged.
3. Second run with the fake answering 200 (no ETag): `upserted 0`, `unchanged >= 1`, and the advisories count is unchanged.
4. The cursor stops paging: with 2 pages (Link next) and a stored cursor between them, page 2 is not fetched.
5. A foreign-origin next link is not fetched; the run fails.
6. A 403 on page 1: the source's `last_error` is set, and KV is unchanged.
7. The page cap: with `max_pages: 1` and a next link, `incomplete` is set, there is an error, and no cursor is written.
8. Releases dedup: after the first run, a run whose cursor is reset makes 0 releases calls (3j27 is already in advisory_sources). The EXPLAIN of the dedup seek uses `sqlite_autoindex_advisory_sources_1`.
9. Through the worker: `GET /v1/check?deno=2.1.0` lists GHSA-2x3r with `fixed_in "2.1.7"`; `?deno=2.1.7` does not list it; `?deno=1.46.0` does not list it.
10. Token: the `authorization` header is present only when `env.GITHUB_TOKEN` is set.

`tests/ingest/bun-runtime.tcs-41.test.ts`:
1. The real empty page: run ok, 0 upserted, ETag stored, no cursor.
2. Synthetic page: one doc with `ecosystem='bun'`, and `fixed_in` equal to the entry's patched version.
3. Second run: `unchanged`.
4. `GET /v1/check?bun=1.1.30` lists it (the synthetic range covers 1.1.30); `?bun=<patched>` does not.
5. The `bun-v` tag prefix parses release tags.

`tests/ingest/github-runtime-normalize.tcs-41.test.ts`: the decision table over every real range and patched string in "Live facts". Each row asserts lower/lt/le, the fixes, the ranges, and `matchAdvisory` for at least 2 versions on each side, including the edges: the patched version, the `>` bound version, and a version between two lines. Also: withdrawn, not published, and no runtime entry are terminal; `moderate` maps to `medium`; the action stays ≤200 chars.

`tests/ingest/upsert-component-merge.tcs-41.test.ts`: cases A-D from T2, plus npm-vs-node with the same CVE giving 2 rows.

Regression suites at risk: `tests/ingest/upsert.tcs-2.test.ts` (findByCve SQL/plan), `tests/ingest/osv-multi-package.tcs-46.test.ts`, and the five count/list tests listed under "Tests that must change". Also `tests/ingest/python-runtime.tcs-39.test.ts`, `tests/cron/runtime-ingest.tcs-6.test.ts` and `tests/cron/warnings.tcs-50.test.ts`, which run `defaultRegistry` (they disable the other rows, so the new rows stay off).

## QA screens

- `GET /status`: the table lists `deno-runtime` and `bun-runtime` rows with last run and last ok.
- `GET /` freshness line: "N of 9 sources ok".
- `GET /v1/check?deno=2.1.0&bun=1.1.30` (JSON): after a prod ingest run, `affected` lists deno advisories with `fixed_in`.

[NOTE] not verified here: a prod ingest run against live GitHub. The tests use recorded pages only.

## Design collision check (BH-5791)

Checked 9 listed and 0 derived symbols against main ff7bd9b9db98..07a977891e95 and 1 open PRs.
- `sources` (function, listed): main 07a977891e95, (text match). Resolution: combine.
- `sources` (function, listed): PR #31 3dcc73db75bf, (text match). Resolution: combine.

## Size

FILES: 8
LINES: 470
DIFF_KB: 140

KIND: feature
SIZE: M
