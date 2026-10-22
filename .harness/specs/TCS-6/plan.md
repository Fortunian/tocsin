# TCS-6 plan: runtime ingesters for Node.js and PHP

Ticket: Fortunian/tocsin#6 "Runtime ingesters: Node.js and PHP". `Blocked-by: #2` is CLOSED (merged as 4c2f645).
Thread: 0 comments (re-read 2026-10-22T15:32Z). The issue body is the whole spec.
This is re-plan r2. Build tocsin-TCS-6-202610221451 ended EXECUTE_EMPTY: the execute-stage egress fence refused nodejs.org, www.php.net and api.github.com (its execute-blocked.txt). This plan fixes that cause: the plan stage recorded all 7 sources into this build dir (see `## Fixture handoff`). The execute stage needs NO network.

ALREADY ON MAIN? No. Base is origin/main 86ad46b. `git log origin/main --since=2026-10-22T00:26:47Z -- src/ingest` lists only 4c2f645 (TCS-2, the OSV framework this ticket depends on). TCS-12 (be088aa) and TCS-13 (86ad46b) merged since the previous plan; neither touches `src/ingest/`, `src/env.ts` or `tests/cron/run.tcs-2.test.ts` (checked with `git diff be088aa origin/main -- <those paths>`: empty).
`src/ingest/` on main holds only osv.ts and its helpers. `defaultRegistry` on main is `{ osv }`.
No open PR in Fortunian/tocsin. Remote branch `ticket/tcs-6` points at be088aa (main at that time) and has 0 commits of its own: the failed build pushed nothing. TCS-13 changed `vitest.config.ts` to three projects; the `api` project still includes `tests/**/*.test.ts` minus `tests/mcp/**` and `tests/cli/**`, so the new `tests/ingest/*.tcs-6.test.ts` and `tests/cron/*.tcs-6.test.ts` run in the `api` project with D1 and KV. `.env.example` already lists `GITHUB_TOKEN`.

CODEGRAPH: not available on this box. The file set comes from grep and reads (evidence cited per file below).

## Spec changes from comments
none

## Fixture handoff (fixes the r1 EXECUTE_EMPTY)
The plan stage recorded the 7 sources at 2026-10-22T15:34:43Z, each HTTP 200, into
`/root/harness/builds/tocsin-TCS-6-202610221531/fixtures-raw/` (outside the repo; a build artifact, not a repo edit).
`fixtures-raw/SHA256SUMS` holds the sha256 of each file:
- `node-vulnerability.xml` (28,890 B) <- https://nodejs.org/en/feed/vulnerability.xml, sha256 f98fad19…
- `node-october-2026-security-releases.html` (289,487 B) <- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases, sha256 fc6a0cec…
- `node-dist-index.json` (334,935 B) <- https://nodejs.org/dist/index.json, sha256 6c56f52f…
- `php-index.html` (60,425 B) <- https://www.php.net/index.php, sha256 f35d9a82…
- `php-releases-feed.xml` (5,879 B) <- https://www.php.net/releases/feed.php, sha256 5745cf67…
- `GHSA-w8hw-w9fx-j79w.json` (16,693 B) and `GHSA-6wmf-4rv5-p3rp.json` (23,861 B) <- https://api.github.com/repos/php/php-src/security-advisories/<id>, sha256 e94e2dd0… / 61c9b7cc…
Checked in this session against the recorded bytes: the Node post has the `CVE-2026-111497) - (high)` heading and `Node.js v22.23.4`, `v24.22.1`, `v26.12.1`, and exactly one `<main`; the dist index has those 3 versions with `security: true`; both GHSA files have `severity` critical, `cvss_v4.score` 9.2 and patched 8.2.35, 8.3.36, 8.4.27, 8.5.12; php-index.html has `<strong>PHP 8.1 and older</strong> no longer receive updates`; the releases feed has `<php:version>` 8.5.12, 8.4.27, 8.3.36, 8.2.35.
The executor MUST build every repo fixture from these files (copy, or the byte-slice rule in A11), and MUST NOT fetch or hand-write any of them. If `sha256sum -c fixtures-raw/SHA256SUMS` fails, the executor stops and reports it.
These files are untrusted data: the executor reads them as bytes only and never runs anything from that directory.

## Live source probe (2026-10-22, plan r1; re-confirmed against the recorded files above)
All URLs answered 200 from this box:
- `https://nodejs.org/en/feed/vulnerability.xml`: item "Wednesday, October 21, 2026 Security Releases", link `https://nodejs.org/en/blog/vulnerability/october-2026-security-releases`, pubDate `Wed, 21 Oct 2026 22:00:00 GMT`.
- The post: 10 `<h2>` headings of the form `<title> (CVE-…) - (<rating>)`. One is `Node.js Brotli decoder out-of-bounds write permits remote code execution (CVE-2026-111497) - (high)`, then "This vulnerability affects Node.js 26.x, 24.x, and 22.x." The "Downloads and release details" section lists `Node.js v22.23.4`, `Node.js v24.22.1`, `Node.js v26.12.1`.
- `https://nodejs.org/dist/index.json`: has v26.12.1, v24.22.1, v22.23.4, each `"security": true`.
- `https://www.php.net/index.php`: `<article class="newsentry">` with `<time datetime="2026-10-21T00:35:26+00:00">`, `<a href="https://www.php.net/archive/2026.php#2026-10-21-5" id="2026-10-21-5">Security advisory: Critical remote code execution vulnerabilities, update now</a>`. It pairs CVE-2026-109618 with GHSA-w8hw-w9fx-j79w and CVE-2026-109619 with GHSA-6wmf-4rv5-p3rp, and says "<strong>PHP 8.1 and older</strong> no longer receive updates".
- `https://www.php.net/releases/feed.php`: entries with `<php:version>` 8.5.12, 8.4.27, 8.3.36, 8.2.35.
- `https://api.github.com/repos/php/php-src/security-advisories/GHSA-w8hw-w9fx-j79w` (no token, rate limit 60/h): `cve_id` CVE-2026-109618, `severity` critical, `cvss_severities.cvss_v4.score` 9.2, `summary` "RCE via OOM corruption", `vulnerabilities[].patched_versions` 8.2.35, 8.3.36, 8.4.27, 8.5.12. GHSA-6wmf-4rv5-p3rp is the same shape for CVE-2026-109619.
- The CVSS 9.2 score is in the GitHub advisory only. The php.net 2026-10-21 security post does not carry it. This is why the PHP ingester reads the php-src GitHub advisories ("the PHP security advisories" in the ticket).

## Scope
1. `node-runtime` ingester: vulnerability feed → security release posts → one advisory per CVE, confirmed against the dist index.
2. `php-runtime` ingester: php.net news page → "Security advisory" posts → one advisory per CVE, data from the php-src GitHub advisory, fixed versions confirmed against the php.net releases feed.
3. Both use a KV `last_seen` cursor and skip posts older than it.
4. Register both in `src/ingest/registry.ts`. The `sources` rows `node-runtime` and `php-runtime` already exist and are enabled (migrations/0002_seed_sources.sql). No migration.

Out of scope (ticket): Go, Python, Rust, Deno, Bun runtimes.

## ASSUMPTIONS
- A1. Node feed URL. The ticket says "the nodejs.org blog feed, posts whose title contains 'Security Release'". Assumed: default `feed_url` = `https://nodejs.org/en/feed/vulnerability.xml` (28 KB, the security-only subset of the blog), and the title filter "Security Release" still applies. Other reading: `https://nodejs.org/en/feed/blog.xml` (318 KB). The URL is a `config_json` key, so an operator can switch it without a deploy.
- A2. Affected ranges are per release line exactly as the ticket says: Node `{introduced: "<major>.0.0", fixed: "<fixed>"}` (3 ranges for CVE-2026-111497), PHP `{introduced: "<major>.<minor>.0", fixed: "<fixed>"}` (4 ranges). EOL lines (Node 20.x, 23.x, 25.x; PHP 8.1 and older) get NO range, so `/v1/check` reports them as not affected by these advisories. Other reading: start the lowest line at `introduced: "0"` (the GHSA range is "< 8.2.35", and the Node post says "End-of-Life versions are always affected"). I did not take it because the ticket says "ranges per release line" and pins "`affected` has three ranges". The PHP action text still says 8.1 and older get no fix.
- A3. Node action wording. The ticket template is "Upgrade node to <fixed for your line> or later." One advisory covers 3 lines, so the action lists each line: `Upgrade node to 22.23.4 (22.x), 24.22.1 (24.x) or 26.12.1 (26.x) or later.` (lines ascending). With one line it is exactly `Upgrade node to 24.22.1 or later.` PHP: `Upgrade php to 8.2.35 (8.2), 8.3.36 (8.3), 8.4.27 (8.4) or 8.5.12 (8.5) or later. Unsupported lines (8.1 and older) get no fix.` The second sentence is added only when the post has the "<strong>PHP X.Y and older</strong> no longer receive updates" sentence. Both stay under the 200-char schema limit. If longer, the build trims to the single-line template with the lowest fixed version.
- A4. PHP source_id = the CVE id (same as Node in the ticket). A GHSA with no `cve_id` uses the GHSA id as source_id and `cve_ids: []`.
- A5. PHP severity: label = GHSA `severity` (`moderate` → `medium`), score = `cvss_v4.score`, else `cvss_v3.score`, else no score. Node: label from the heading's rating word, no score (the post gives none).
- A6. Summary: Node = the heading text before ` (CVE-…)`, one line, max 200 chars. PHP = the GHSA `summary` (verbatim source text, CLAUDE.md rule 10).
- A7. Timestamps. Node: published_at = modified_at = the feed item pubDate (UTC, no millis). PHP: published_at = GHSA `published_at`, modified_at = GHSA `updated_at`; if absent, the post `<time datetime>`. No field uses `now()`, so a re-run produces the same doc and upsert answers `unchanged`.
- A8. Cursor semantics. The ticket says "skip posts older than it". A post with a date EQUAL to the cursor is re-read, because Node edits a release post in place (pre-announcement → release). Cost per tick in steady state: Node 3 fetches (feed 28 KB, post ~290 KB, dist index ~330 KB), PHP 1 fetch (news page 59 KB). Other reading: skip equal posts too (fewer fetches, but an in-place post edit is lost).
- A9. GitHub dedup. Before it calls the GitHub advisory API for a CVE, the PHP ingester checks `advisory_sources` for `('php-runtime', <CVE>)`. If the row exists, it does not call GitHub and counts the CVE as `unchanged`. A later edit of a GHSA score is not picked up by this ingester (score enrichment belongs to the NVD/KEV/EPSS ticket, docs/tickets/04-enrich-nvd-kev-epss.md). This keeps the unauthenticated rate limit (60/h on shared Cloudflare egress) safe. Optional `GITHUB_TOKEN` (already in `.env.example`) is sent as a bearer token when set.
- A10. Test file names. The ticket names `tests/ingest/node-runtime.test.ts` and `tests/ingest/php-runtime.test.ts`. The harness rule and repo precedent (`tests/ingest/osv.tcs-2.test.ts`) put the ticket key in the name, so the files are `tests/ingest/node-runtime.tcs-6.test.ts` and `tests/ingest/php-runtime.tcs-6.test.ts`. Other reading: the exact ticket names.
- A11. Fixture size. The recorded Node post page is ~290 KB (mostly Next.js scripts) and the dist index ~330 KB. To keep the diff under the review limit, fixtures are exact byte slices of the recorded files: the Node post is the `<main>…</main>` element (~58 KB, byte-for-byte), and `index.json` is the JSON array filtered to entries with `date >= "2026-10-01"` (7 entries, each entry unedited). `tests/fixtures/node-runtime/README.md` and `tests/fixtures/php-runtime/README.md` record the URL, the UTC record time, the full-file sha256 and the slice rule. The php.net page (59 KB), both feeds and the two GHSA JSON files are recorded whole.
- A12. A Node post that names a CVE line with no fixed version in "Downloads and release details", or a fixed version not yet in the dist index (the post says "on or shortly after"), is NOT complete. The ingester emits none of that post's advisories, records an error, and does not move the cursor past that post. The next tick retries. Same for PHP when a GHSA patched version is not yet in the releases feed.

## Changed symbols
- function `node-runtime` ingester (`nodeRuntime: Ingester`, new): run() reads feed, posts, dist index; upserts one advisory per CVE.
- function `parseNodeFeed`, `parseNodeSecurityPost`, `normalizeNodePost` (new, src/ingest/node-runtime.ts): pure parsers/normalizer.
- function `php-runtime` ingester (`phpRuntime: Ingester`, new): run() reads news page, GHSA per CVE, releases feed; upserts one advisory per CVE.
- function `parsePhpNews`, `parsePhpReleases`, `normalizePhpAdvisory` (new, src/ingest/php-runtime.ts): pure parsers/normalizer.
- function `fetchText`, `fetchJson` in the two seams (new): the only places that build nodejs.org / php.net / api.github.com URLs.
- format `cursor:node-runtime`, `cursor:php-runtime` KV keys (new): value = ISO UTC timestamp of the newest fully processed post.
- function `defaultRegistry` (src/ingest/registry.ts): adds `"node-runtime"` and `"php-runtime"` entries. callers: left alone: `runCron` and `runIngesters` read it by key and need no change.
- format `Env` (src/env.ts): adds optional `GITHUB_TOKEN?: string`. callers: left alone: every existing reader ignores the new optional field.

## Design collisions
None. `gh pr list --state open` is empty (2026-10-22T15:33Z). Main since be088aa (86ad46b, TCS-13) does not change `defaultRegistry`, `Env`, or any `src/ingest/` symbol.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty (2026-10-22T15:33Z). No sibling build is live.

## Files to touch
Product code (new unless noted):
1. `src/ingest/runtime-text.ts`: shared pure helpers: `decodeEntities`, `htmlToSections` (split on `<h1>`/`<h2>`, strip tags, collapse whitespace), `oneLine`, `rssItems` / `atomEntries` regex readers, `isoUtc`.
2. `src/ingest/node-runtime-client.ts`: Node seam. `NodeHttpError`; `fetchFeed`, `fetchPost`, `fetchDistIndex` with injected `fetchFn`.
3. `src/ingest/node-runtime.ts`: config, parsers, normalizer, `run`, `nodeRuntime`.
4. `src/ingest/php-runtime-client.ts`: PHP seam. `PhpHttpError`; `fetchNews`, `fetchReleases` (php.net), `fetchGhsa` (api.github.com, headers `Accept: application/vnd.github+json`, `User-Agent: tocsin.sh`, `X-GitHub-Api-Version: 2022-11-28`, bearer `GITHUB_TOKEN` when set).
5. `src/ingest/php-runtime.ts`: config, parsers, normalizer, `run`, `phpRuntime`.
6. `src/ingest/registry.ts` (edit): import and register both. Evidence: `defaultRegistry` is read by `src/cron/run.ts:runCron` (default arg) and by `tests/cron/run.tcs-2.test.ts:134`.
7. `src/env.ts` (edit): `GITHUB_TOKEN?: string`.

Tests and fixtures (new unless noted):
8. `tests/ingest/runtime-fake.tcs-6.ts`: URL → Response map fake; throws on an unmapped URL; records calls.
9. `tests/ingest/node-runtime.tcs-6.test.ts`
10. `tests/ingest/php-runtime.tcs-6.test.ts`
11. `tests/cron/runtime-ingest.tcs-6.test.ts`: production entry point (`worker.scheduled`) plus `/v1/check`.
12. `tests/raw-modules.tcs-6.d.ts`: `declare module "*?raw"` for the `.html` / `.xml` fixture imports. If `?raw` does not load in vitest-pool-workers, the executor stores each text fixture verbatim and reads it through a `.ts` wrapper generated by `JSON.stringify` of the file bytes, and says so in the README.
13. `tests/fixtures/node-runtime/2026-10-21.html`, `tests/fixtures/node-runtime/index.json`, `tests/fixtures/node-runtime/vulnerability.xml`, `tests/fixtures/node-runtime/README.md`
14. `tests/fixtures/php-runtime/2026-10-21.html`, `tests/fixtures/php-runtime/releases.xml`, `tests/fixtures/php-runtime/GHSA-w8hw-w9fx-j79w.json`, `tests/fixtures/php-runtime/GHSA-6wmf-4rv5-p3rp.json`, `tests/fixtures/php-runtime/README.md`
15. `tests/cron/run.tcs-2.test.ts` (edit, case 3b only): see Tests that must change.

## Tests that must change
- `tests/cron/run.tcs-2.test.ts`: case 3b pins `Object.keys(defaultRegistry)` to `["osv"]` and its name says "runtimes are out of scope". This ticket adds the runtime ingesters, so the expected list becomes `["osv", "node-runtime", "php-runtime"]` and the name drops "and runtimes". No other assertion in that file changes.

## Verify (run, not edited)
- `npm test` (all suites; regression risk: `tests/cron/run.tcs-2.test.ts`, `tests/ingest/osv.tcs-2.test.ts`, `tests/ingest/upsert.tcs-2.test.ts`, `tests/routes/check*.test.ts`)
- `npm run typecheck`

## Design

### Node (`src/ingest/node-runtime.ts`)
Config (`sources.config_json` of row `node-runtime`; code fallbacks, CLAUDE.md rule 5):
`feed_url` = `https://nodejs.org/en/feed/vulnerability.xml`, `dist_index_url` = `https://nodejs.org/dist/index.json`, `title_match` = `Security Release`, `backfill_days` = 120, `max_posts` = 5. Validation as in `osv.ts:readConfig` (throws on a bad type).

run():
1. `since` = KV `cursor:node-runtime`, else `now - backfill_days`.
2. Fetch feed. Items = `{title, link, pubDate}`. Keep items whose title contains `title_match` (case-insensitive) and whose pubDate >= since. Sort oldest first, then by link. Take `max_posts`. If none: return, 1 fetch total (0 posts, 0 index reads).
3. Fetch the dist index once. Build the set of versions.
4. For each post (oldest first): fetch it, parse sections:
   - CVE heading: `^(.+?) \((CVE-\d{4}-\d{4,})\) - \((critical|high|medium|low)\)$`.
   - lines: in that section body, `affects Node\.js (…)\.` → every `(\d+)\.x`.
   - fixed: section "Downloads and release details" → every `Node\.js v(\d+\.\d+\.\d+)` → map major → version.
   - Zero CVE headings → record error `"<link>: no CVE headings"` and treat the post as done (a permanent data issue, as in osv.ts).
   - A CVE line with no fixed version, or a fixed version not in the dist index → the post is incomplete (A12): record error, emit nothing for it, stop the loop. The cursor stays at the last complete post.
5. Upsert each doc with key `{source: "node-runtime", source_id: CVE}`. `InvalidAdvisoryError` → error, continue. Other errors throw out of the run (cursor not written for this post).
6. After every post with the same pubDate is complete, `kv.put(cursor, pubDate ISO)`.

Doc: `cve_ids: [CVE]`, `ecosystem: "node"`, `component: "node"`, `affected` per line ascending, `fixed_versions` per line ascending, `severity: {label}`, `exploited: false`, `summary`, `action` (A3), `references: [post link]`, `sources: [{source: "node-runtime", source_id: CVE, url: post link}]`.

### PHP (`src/ingest/php-runtime.ts`)
Config fallbacks: `news_url` = `https://www.php.net/index.php`, `releases_url` = `https://www.php.net/releases/feed.php`, `ghsa_api_base` = `https://api.github.com/repos/php/php-src/security-advisories`, `title_match` = `Security advisory`, `backfill_days` = 120, `max_posts` = 5.

run():
1. `since` as Node, key `cursor:php-runtime`.
2. Fetch news page. Entries = `<article class="newsentry">` blocks: `<time datetime>`, title link href + text, content. Keep entries whose title contains `title_match` and datetime >= since. Oldest first, cap `max_posts`. None → return after 1 fetch.
3. Per entry: pairs `(CVE, GHSA)` from each `<li>` that has both a CVE id and a `…/security/advisories/GHSA-…` link. No-fix line from `<strong>PHP (\d+\.\d+) and older</strong> no longer receive updates`. Zero pairs → error, entry done.
4. Per pair: dedup-before-spend (A9): `SELECT 1 FROM advisory_sources WHERE source = 'php-runtime' AND source_id = ?` (PK seek). Hit → `unchanged`, no GitHub call. Miss → `fetchGhsa`. Fetch the releases feed lazily once per run on the first miss.
5. Normalize: fixed = `patched_versions` split on `,`, trimmed, sorted ascending; one range per line `{introduced: "<maj>.<min>.0", fixed}`. A fixed version not in the releases feed → entry incomplete (A12). GHSA `state != "published"` or no patched version → error for that pair.
6. Upsert, key `{source: "php-runtime", source_id: CVE}`. Cursor rule as Node.

Doc: `cve_ids`, `ghsa_id`, `ecosystem: "php"`, `component: "php"`, severity (A5), summary (A6), action (A3), `references: [post link, GHSA html_url]`, `sources: [{source: "php-runtime", source_id, url: post link}]`.

## Tasks

T1. Shared text helpers `src/ingest/runtime-text.ts`.
VALIDATE: `npm test -- tests/ingest/node-runtime.tcs-6.test.ts -t "text"` (entity decode `&amp;`, `&#x27;`, CDATA titles, h1/h2 section split on the recorded post).
SATISFIES: "reads the Node.js security release posts (nodejs.org blog feed …)" and "reads php.net release announcements" (both parsers rest on it).

T2. Node seam `src/ingest/node-runtime-client.ts`.
VALIDATE: `npm test -- tests/ingest/node-runtime.tcs-6.test.ts -t "seam"` (non-2xx → `NodeHttpError` with status and URL; a fetch of an unmapped URL throws in the fake; 0 calls to `globalThis.fetch`).
SATISFIES: "reads … the release index https://nodejs.org/dist/index.json".

T3. Node parser + normalizer + run in `src/ingest/node-runtime.ts`.
VALIDATE: `npm test -- tests/ingest/node-runtime.tcs-6.test.ts`
SATISFIES: "CVE-2026-111497 is emitted with fixed_versions containing 22.23.4, 24.22.1 and 26.12.1; severity label high; affected has three ranges; the summary is one line under 200 chars."

T4. PHP seam `src/ingest/php-runtime-client.ts`.
VALIDATE: `npm test -- tests/ingest/php-runtime.tcs-6.test.ts -t "seam"` (GHSA request carries `User-Agent` and `Accept`; bearer header present only when `GITHUB_TOKEN` is set; 403 → `PhpHttpError`).
SATISFIES: "reads php.net release announcements (the releases feed) and the PHP security advisories".

T5. PHP parser + normalizer + run in `src/ingest/php-runtime.ts`, plus `GITHUB_TOKEN?` in `src/env.ts`.
VALIDATE: `npm test -- tests/ingest/php-runtime.tcs-6.test.ts`
SATISFIES: "CVE-2026-109618 and CVE-2026-109619 are emitted with fixed_versions containing 8.5.12, 8.4.27, 8.3.36, 8.2.35; severity score 9.2 and label critical; action mentions that 8.1 gets no fix."

T6. KV `last_seen` cursor in both run() functions.
VALIDATE: `npm test -- tests/ingest/node-runtime.tcs-6.test.ts tests/ingest/php-runtime.tcs-6.test.ts -t "cursor"`
SATISFIES: "Both read a last_seen cursor from KV and skip posts older than it."

T7. Idempotent re-run.
VALIDATE: `npm test -- tests/ingest/node-runtime.tcs-6.test.ts tests/ingest/php-runtime.tcs-6.test.ts -t "re-run"`
SATISFIES: "Re-running on the same fixtures yields unchanged for every advisory."

T8. Register both in `src/ingest/registry.ts`; update case 3b in `tests/cron/run.tcs-2.test.ts`; add `tests/cron/runtime-ingest.tcs-6.test.ts`.
VALIDATE: `npm test -- tests/cron/run.tcs-2.test.ts tests/cron/runtime-ingest.tcs-6.test.ts`
SATISFIES: "Register both in src/ingest/registry.ts."

T9. Build the repo fixtures from `fixtures-raw/` (see Fixture handoff) with README provenance (A11). No network call, no hand-written bytes. The README records the source URL, the record time 2026-10-22T15:34:43Z, the full-file sha256 from `fixtures-raw/SHA256SUMS` and the slice rule.
VALIDATE: `(cd /root/harness/builds/tocsin-TCS-6-202610221531/fixtures-raw && sha256sum -c SHA256SUMS)` exits 0; `cmp` of each whole-copied fixture against its raw file exits 0;  `sha256sum tests/fixtures/php-runtime/*.json tests/fixtures/php-runtime/releases.xml tests/fixtures/php-runtime/2026-10-21.html tests/fixtures/node-runtime/vulnerability.xml` matches the README lines, and `grep -c 'CVE-2026-111497' tests/fixtures/node-runtime/2026-10-21.html` ≥ 1.
SATISFIES: "tests/fixtures/node-runtime/2026-10-21.html and …/index.json recorded from the real 2026-10-21 security release" and "tests/fixtures/php-runtime/2026-10-21.html recorded from php.net".

T10. Full suite and typecheck.
VALIDATE: `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?` (unpiped exit codes, D6).
SATISFIES: ticket Verification contract (`npm test`, `npm run typecheck`).

## Acceptance tests
`tests/ingest/node-runtime.tcs-6.test.ts` (all I/O through `runtime-fake.tcs-6.ts`; `afterAll` asserts `globalThis.fetch` was called 0 times):
- N1 normalize: CVE-2026-111497 → `fixed_versions` equals `["22.23.4", "24.22.1", "26.12.1"]`; `severity.label` = `high`, no score; `affected` has length 3 and contains `{introduced: "24.0.0", fixed: "24.22.1"}`; `summary` matches `^[^\r\n]+$` and length < 200; `ecosystem` = `component` = `node`; `sources[0]` = `{source: "node-runtime", source_id: "CVE-2026-111497", url: <post link>}`; `validateAdvisory` ok.
- N2 every CVE heading in the fixture is emitted (10 CVEs) with the rating word as label; CVE-2026-106070 (26.x only) has 1 range and action `Upgrade node to 26.12.1 or later.`
- N3 action for CVE-2026-111497 = `Upgrade node to 22.23.4 (22.x), 24.22.1 (24.x) or 26.12.1 (26.x) or later.`
- N4 run through `nodeRuntime.run` on a fresh D1/KV: `upserted` = 10, `errors` = []; KV `cursor:node-runtime` = `2026-10-21T22:00:00Z`; the stored row for CVE-2026-111497 has `ecosystem = 'node'`, `severity_label = 'high'`.
- N5 re-run: second `run` → `unchanged` = 10, `upserted` = 0, no new `advisories` rows (count before = after), max cursor unchanged.
- N6 cursor: KV cursor set to `2026-10-22T00:00:00Z` → 1 fetch (feed only), 0 post fetches, 0 index fetches, 0 upserts.
- N7 cursor equal: KV cursor = the post pubDate → the post is re-read (A8) and yields `unchanged` = 10.
- N8 incomplete post: an index fixture without v24.22.1 → 0 upserts, 1 error naming `24.22.1`, cursor not written.
- N9 negative titles (classifier list below) → 0 post fetches.
- N10 seam: post answers 503 → `run` throws `NodeHttpError`, cursor not written.

`tests/ingest/php-runtime.tcs-6.test.ts`:
- P1 CVE-2026-109618 and CVE-2026-109619: each `fixed_versions` contains `8.5.12`, `8.4.27`, `8.3.36`, `8.2.35`; `severity` = `{score: 9.2, label: "critical"}`; `action` contains `8.1` and `no fix`; `ghsa_id` = GHSA-w8hw-w9fx-j79w / GHSA-6wmf-4rv5-p3rp; `affected` has 4 ranges incl. `{introduced: "8.2.0", fixed: "8.2.35"}`; summary = `RCE via OOM corruption` / `RCE via stale global state`; `validateAdvisory` ok.
- P2 run: `upserted` = 2, errors = []; fetch calls = news 1 + releases 1 + GHSA 2; KV `cursor:php-runtime` = `2026-10-21T00:35:26Z`.
- P3 re-run: `unchanged` = 2, GHSA calls on the second run = 0 (dedup, A9), no new rows.
- P4 no-fix sentence removed from the fixture copy in-test → action has no "no fix" sentence (pins "when the post says so").
- P5 a GHSA patched version absent from the releases fixture → 0 upserts for that entry, error names the version, cursor not written.
- P6 GHSA 403 → run throws `PhpHttpError`, cursor not written.
- P7 `GITHUB_TOKEN` set in env → GHSA request has `Authorization: Bearer <fixture token>`; unset → no Authorization header.
- P8 negative titles → 0 GHSA calls.

`tests/cron/runtime-ingest.tcs-6.test.ts` (production entry, D2):
- C1 `worker.scheduled` (src/index.ts) with only `node-runtime` and `php-runtime` enabled and `globalThis.fetch` mocked by the URL-map fake → `sources.last_ok_at` set for both, `last_error` null; `advisories` has rows with ecosystem `node` and `php`.
- C2 then `POST /v1/check` with runtimes `node 24.10.0` and `php 8.3.20` → affected list contains CVE-2026-111497 and CVE-2026-109618; `node 24.22.1` → CVE-2026-111497 absent.
- C3 deleting either registry entry makes C1 fail (mutation check, D1).

`tests/cron/run.tcs-2.test.ts` case 3b: `Object.keys(defaultRegistry)` = `["osv", "node-runtime", "php-runtime"]`, each `.id` equals its key.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| node-runtime reads security release posts, title contains "Security Release" | T1, T3 | N4, N9 |
| node reads dist index to confirm a fixed version exists | T2, T3 | N8 |
| one advisory per CVE, ecosystem/component = node | T3 | N1, N2 |
| affected ranges per release line | T3 | N1, N2 |
| fixed_versions per line | T3 | N1 |
| severity from the rating words | T3 | N1, N2 |
| action "Upgrade node to <fixed for your line> or later." | T3 | N2, N3 |
| source id = CVE id | T3, T5 | N1, P1 |
| post is source of truth for fixed versions | T3 | N1, N8 |
| php-runtime reads releases feed and PHP security advisories | T4, T5 | P2, P5 |
| php ranges per minor line 8.2–8.5, fixed per line | T5 | P1 |
| php action with "8.1 and older get no fix" only when the post says so | T5 | P1, P4 |
| severity score 9.2, label critical | T5 | P1 |
| KV last_seen cursor, skip older posts | T6 | N6, N7, P2 |
| register both in registry.ts | T8 | case 3b, C1, C3 |
| fixtures recorded from the real 2026-10-21 release | T9 | T9 VALIDATE |
| re-run yields unchanged | T7 | N5, P3 |
| npm test, npm run typecheck green | T10 | T10 VALIDATE |
| NEGATIVE: Go/Python/Rust/Deno/Bun out of scope | none (no task adds them) | case 3b pins the exact registry key list |
| NEGATIVE: no duplicate advisory on re-run (rule 3) | T7 | N5, P3 (row count unchanged) |

## Iron laws applied
- UI laws (sortable headers, list-over-cards, drill-down, loading.tsx): n/a. No screen.
- DB-driven config: every URL, title match, backfill window and cap is a `sources.config_json` key with a documented code fallback (rule 5).
- Schema, RLS, indexes: no migration, no new table (D1, not Supabase). New queries: the dedup read `SELECT 1 FROM advisory_sources WHERE source = ? AND source_id = ?` uses the PK of `advisory_sources` (the same seek as `UPSERT_SQL.findByPair`). The build adds an `EXPLAIN QUERY PLAN` assertion in P3 that the plan detail names the primary-key index (no `SCAN advisory_sources`).
- Retention: no new table. Two new KV keys, one per source, overwritten in place, fixed count. `docs/RETENTION.md` is per table and gets no edit.
- Correlated subquery: none added.
- De-AI: no LLM. Summary and action are deterministic text from source data (rules 6, 10).
- Dedup before spend: GitHub is rate-limited, not billed. A9 checks the persisted `advisory_sources` row before every GitHub call. nodejs.org and php.net are free CDN reads, bounded by `max_posts`.
- Model ids: none.
- Scalable tests: one seam per vendor (`node-runtime-client.ts` for nodejs.org, `php-runtime-client.ts` for php.net and api.github.com). Tests inject the URL-map fake (0 network calls, throws on an unmapped URL); a `globalThis.fetch` spy asserts 0 real calls. Each test uses its own isolated D1/KV storage (pool-workers per-test isolation, as in osv.tcs-2). No real-vendor contract suite in this PR: the repo has none for OSV either, and the [NOTE] stays for a follow-up.
- Performance: no screen or loader. The feed and check reads are unchanged. Steady-state cron cost is 4 subrequests per tick (A8).

## Build discipline rules that bite
- D1/D63 mutation: break the line-to-fixed map, the rating regex and the cursor write; a test must go red for each.
- D2: C1 goes through `worker.scheduled`.
- D4/D26: fixtures come only from the plan-stage recordings in `fixtures-raw/` (sha256 in SHA256SUMS and README); no fetch in execute, no hand-written HTML. Negative-title cases are in-test edits of a recorded feed copy, labelled as such.
- D6: unpiped exit codes for `npm test` and `npm run typecheck`.
- D9/D11/D12: incomplete post never moves the cursor; errors surface in `sources.last_error`; `max_posts` cap leaves the rest for the next tick (cursor oldest-first).
- D21: `max_posts` bounds posts per run; GHSA calls bounded by pairs in those posts.
- D25/D51: new files per ingester; registry gets one import and one entry per ingester.
- D56: tests assert owned fields, not whole docs.
- D65: per-ticket test file names; the only edit to another ticket's test is case 3b, listed above.

## System invariants
(a) Cross-run state: KV `cursor:node-runtime` and `cursor:php-runtime` (ISO UTC of the newest fully complete post). Dedup and idempotency rest on the `advisory_sources` PK `(source, source_id)` through `upsertAdvisory`, not on the cursor. A lost cursor costs a re-read inside `backfill_days` and produces `unchanged`, never a duplicate.
(b) Side effects. Success: advisory upserted (feed cursor bumps only when the doc changed), then the KV cursor moves after the whole same-date post group is complete. HTTP failure: the run throws, `sources.last_error` records it, cursor unchanged. Incomplete post (A12): no upsert for that post, error recorded, cursor unchanged. Bad doc (`InvalidAdvisoryError`): error recorded, other CVEs continue. Write order is always upsert first, cursor second, so "cursor moved without the advisory stored" is impossible.
(c) Negative list for the title classifier (must NOT start a post read): Node `Node.js v24.22.0 (LTS)`, `Node.js 26.12.0 (Current)`, `March 2026 HashDoS`. Positive near misses that MUST match (case-insensitive contains): `Wednesday, October 21, 2026 Security Releases` and a lowercase `security release` title. PHP negatives: `PHP 8.5.12 Released!`, `PHP 8.6.0 RC 3 available for testing`, `PHP 8.5.12 release announcement scheduled`. Post-level negatives: a heading without a rating suffix (`dns.resolve truncates names (CVE-2026-105482)`) and a dependency-update bullet (`OpenSSL on 24.x, 22.x`) emit nothing. All cases are in-test edits of a recorded feed or post copy, labelled `source: assumed` except the recorded titles.
(d) Neighbors. `runIngesters` runs sources one at a time in `id` order (`node-runtime` before `osv`, `php-runtime` last); a throw in one is caught per source (registry.ts) and never stops osv. Cron `*/10 * * * *` (wrangler.toml): steady-state adds 4 subrequests per tick; worst case 1 + 5 posts + 1 index (Node) and 1 + 1 + GHSA pairs (PHP). `upsertAdvisory` cross-source merge by CVE: OSV has no `node`/`php` runtime ecosystem, so these CVEs are created by the runtime source and own their base fields. A later NVD/KEV ingester (docs/tickets/04-enrich-nvd-kev-epss.md) only adds to them. The feed and `/v1/check` read the new rows through the existing indexes (`idx_advisories_component_ecosystem`).

## QA screens
None. No UI. Observable surfaces after deploy: `GET https://tocsin.sh/v1/events?ecosystem=node` and `?ecosystem=php` list the 2026-10-21 CVEs; `POST https://tocsin.sh/v1/check` with runtimes `node 24.10.0` flags CVE-2026-111497.

## Design collision check (BH-5791)

Checked 8 listed and 0 derived symbols against main 86ad46bc9ba2..86ad46bc9ba2 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 7
LINES: 600
DIFF_KB: 190

KIND: feature
SIZE: M
