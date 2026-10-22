# TCS-6 plan (r3): runtime ingesters for Node.js and PHP

Ticket: Fortunian/tocsin#6 "Runtime ingesters: Node.js and PHP". `Blocked-by: #2` is CLOSED (merged as 4c2f645).
Thread: 0 comments (re-read 2026-10-22T17:2xZ). The issue body is the whole spec. Nothing in the thread says hold, manual or shipped.

## History (why r3)
- r1 (tocsin-TCS-6-202610221451): EXECUTE_EMPTY. The execute egress fence refused nodejs.org, www.php.net and api.github.com.
- r2 (tocsin-TCS-6-202610221531): the plan stage recorded all sources into `/root/harness/builds/tocsin-TCS-6-202610221531/fixtures-raw/` (sha256 in `SHA256SUMS`). Execute produced commit `918c024` on `origin/ticket/tcs-6-r2` (base `86ad46b` = current origin/main). Gates: repro RED at base and GREEN at head, scope in-scope (22/22 planned), tamper 0, `npm test` 466/466 passed, `npm run typecheck` exit 0 (after `npm ci`; see D-ENV below).
- r2 ended REVIEW_BLOCKED, but its `review.md` holds only `TIER: 2` / `VERDICT: BLOCK` (91 bytes). `review-run.txt`, `review2-run.txt` and `fix-run.txt` are 0 bytes, and their `.ctxmeter.err` files say "the run produced no API response (killed or refused before its first turn)". The fix round changed 0 lines. So the BLOCK carries no finding. It is a dead review, not a code verdict.
- This plan reads the r2 diff itself as a reviewer would. It found two real defects (F1, F2 below). r3 = the r2 commit, plus fixes for F1 and F2, plus tests that pin them.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-22T00:26:47Z -- src/ingest` lists only 4c2f645 (TCS-2, the framework this ticket depends on). `git log origin/main -S"node-runtime"` finds only the seed migration and the TCS-1 migration test. `defaultRegistry` on main is `{ osv }`. `src/ingest/node-runtime.ts` and `src/ingest/php-runtime.ts` do not exist on main.

CODEGRAPH: not available on this box. The file set comes from grep and reads: `defaultRegistry` is read by `src/cron/run.ts` (`runCron` default argument) and pinned by `tests/cron/run.tcs-2.test.ts` case 3b. `Env` is read by every route; the new field is optional. `matchAdvisory` (`src/check/match/index.ts`) maps `node` to `semverComparator` and `php` to `composerComparator`; `src/check/match/range.ts:9` reads `introduced: "0"` as "from the beginning", which F1 uses.

## Spec changes from comments
none

## Reuse of r2 (first execute step)
1. Start branch `ticket/tcs-6-r3` at origin/main `86ad46b` (it already is).
2. `git cherry-pick 918c024` (the r2 product commit; NOT `e59899c`, which is the old spec copy). The merge base of r2 is `86ad46b`, so the pick applies clean. If it does not apply clean, stop and report: do not rebuild by hand.
3. Then apply F1 and F2 and their tests.
No network call is needed. Every fixture is already in the r2 commit and was built from the r2 plan-stage recordings (each README carries the URL, the record time 2026-10-22T15:34:43Z and the sha256).

## Findings in the r2 diff that r3 fixes
- F1 (wrong-data). `src/ingest/php-runtime.ts` `normalizePhpAdvisory` emits `{introduced: "8.2.0", fixed: "8.2.35"}` for the lowest line. The GHSA source says `vulnerable_version_range: "< 8.2.35"`, and the php.net post says PHP 8.1 and older get no update. So `/v1/check` with `php 8.1.30` answers "not affected" while the stored action says "Unsupported lines (8.1 and older) get no fix". The shown value contradicts the source (CLAUDE.md rule 10). Fix: read each GHSA `vulnerabilities[]` entry's `vulnerable_version_range`. If the range of the LOWEST line has no lower bound (only `<` or `<=`, no `>`/`>=`), that line's range is `{introduced: "0", fixed}`. Every other line stays `{introduced: "<maj>.<min>.0", fixed}`. A range with a lower bound keeps the per-line start.
- F2 (auth-bypass class: request to an attacker-chosen URL). `src/ingest/node-runtime.ts` `run` fetches `post.link` from the RSS feed as-is. A feed item with a link on another host makes the worker fetch that host. Fix: in the seam `src/ingest/node-runtime-client.ts`, `fetchPost(fetchFn, url, allowedOrigin)` throws `NodeLinkError` when `new URL(url).origin !== allowedOrigin`. `allowedOrigin` = `new URL(cfg.feed_url).origin` (DB-driven: it follows the configured feed). `run` catches `NodeLinkError` only: it records `"<link>: post link is not on <origin>, not read"` as an error and treats the post as done (a permanent data problem, as `no CVE headings`), so the cursor still moves past it. Any other error still throws.

## Scope
1. `node-runtime` ingester: vulnerability feed → "Security Release" posts → one advisory per CVE, fixed versions confirmed against the dist index (from r2, plus F2).
2. `php-runtime` ingester: php.net news page → "Security advisory" posts → one advisory per CVE from the php-src GitHub advisory, patched versions confirmed against the php.net releases feed (from r2, plus F1).
3. Both use a KV `last_seen` cursor and skip posts older than it.
4. Both registered in `src/ingest/registry.ts`. The `sources` rows `node-runtime` and `php-runtime` already exist and are enabled (`migrations/0002_seed_sources.sql`). No migration.

Out of scope (ticket): Go, Python, Rust, Deno, Bun runtimes.

## ASSUMPTIONS
- A1. Node feed URL. The ticket says "the nodejs.org blog feed, posts whose title contains 'Security Release'". Assumed: default `feed_url` = `https://nodejs.org/en/feed/vulnerability.xml` (the security subset of the blog), and the "Security Release" title filter still applies. Other reading: `https://nodejs.org/en/feed/blog.xml`. The URL is a `sources.config_json` key, so an operator can switch it without a deploy.
- A2. Node affected ranges are per release line exactly as the ticket says: `{introduced: "<major>.0.0", fixed}`, 3 ranges for CVE-2026-111497. End-of-life lines (20.x, 23.x, 25.x) get no range. The post says "affects Node.js 26.x, 24.x, and 22.x" and gives no per-CVE fact about EOL lines, so a range for them would be a guess (rule 10). Other reading: open the lowest line from "0" because the post's boilerplate says "End-of-Life versions are always affected". Not taken: for a CVE that affects only 26.x, a "0" start would mark supported 24.x as affected, which is wrong.
- A3. PHP lowest line opens from "0" only when the GHSA range for it has no lower bound (F1). This is the GHSA fact, not a guess. Other reading: per-line starts only (r2). Not taken: it makes `/v1/check` say 8.1 is safe while the source says it is vulnerable.
- A4. Action wording. Several lines: `Upgrade node to 22.23.4 (22.x), 24.22.1 (24.x) or 26.12.1 (26.x) or later.`; one line: `Upgrade node to 24.22.1 or later.` PHP: `Upgrade php to 8.2.35 (8.2), 8.3.36 (8.3), 8.4.27 (8.4) or 8.5.12 (8.5) or later. Unsupported lines (8.1 and older) get no fix.` The second sentence appears only when the post has the `<strong>PHP X.Y and older</strong> no longer receive updates` sentence. Over 200 chars, the text falls back to the lowest fixed version.
- A5. Source id = the CVE id for both sources. PHP severity: label = GHSA `severity` (`moderate` → `medium`), score = `cvss_v4.score`, else `cvss_v3.score`, else none. Node: label from the heading rating word, no score.
- A6. Summary: Node = heading text before ` (CVE-…)`; PHP = GHSA `summary` (verbatim source text).
- A7. Timestamps come from the sources (feed pubDate; GHSA `published_at`/`updated_at`), never `now()`, so a re-run yields `unchanged`.
- A8. A post dated EQUAL to the cursor is read again (Node edits a release post in place). Other reading: skip equal posts.
- A9. GitHub dedup before the call: the PHP ingester reads `advisory_sources` for `('php-runtime', <CVE>)` (primary-key seek) before it calls the GitHub advisory API. A hit counts `unchanged` and makes no call. A later GHSA score edit is not picked up here; enrichment belongs to docs/tickets/04-enrich-nvd-kev-epss.md. Optional `GITHUB_TOKEN` is sent as a bearer token when set.
- A10. Test file names carry the ticket key (`tests/ingest/node-runtime.tcs-6.test.ts`, `tests/ingest/php-runtime.tcs-6.test.ts`) per the harness per-ticket rule and repo precedent `tests/ingest/osv.tcs-2.test.ts`. Other reading: the exact names in the ticket.
- A11. Fixtures are exact byte slices of the recorded pages where the page is large (Node post = the `<main>` element; dist index = entries with `date >= 2026-10-01`). Each README states the slice rule. This is already in the r2 commit.
- A12. A post with a CVE line that has no fixed version, or a fixed version not yet in the dist index / releases feed, is incomplete: it emits nothing, records an error, and the cursor stays before it. The next tick reads it again.
- A13. F2 treats an off-origin post link as a permanent data problem (error recorded, cursor moves). Other reading: throw and hold the cursor, which would stop all Node ingestion behind one bad feed item.

## Changed symbols
- function `nodeRuntime` (`Ingester`, new, src/ingest/node-runtime.ts): run() reads feed, posts, dist index; upserts one advisory per CVE; skips an off-origin post link (F2).
- function `parseNodeFeed`, `parseNodeSecurityPost`, `normalizeNodePost` (new, src/ingest/node-runtime.ts): pure parsers and normalizer.
- function `fetchFeed`, `fetchPost`, `fetchDistIndex`, class `NodeHttpError`, `NodeLinkError` (new, src/ingest/node-runtime-client.ts): the nodejs.org seam; `fetchPost` takes an `allowedOrigin` (F2).
- function `phpRuntime` (`Ingester`, new, src/ingest/php-runtime.ts): run() reads news page, GHSA per CVE (after the dedup read), releases feed; upserts one advisory per CVE.
- function `parsePhpNews`, `parsePhpPost`, `parsePhpReleases`, `normalizePhpAdvisory` (new, src/ingest/php-runtime.ts): pure parsers and normalizer; `normalizePhpAdvisory` reads `vulnerable_version_range` (F1).
- function `fetchNews`, `fetchReleases`, `fetchGhsa`, class `PhpHttpError` (new, src/ingest/php-runtime-client.ts): the php.net and api.github.com seam.
- function `htmlSections`, `htmlText`, `decodeEntities`, `xmlBlocks`, `xmlText`, `isoUtc`, `oneLine`, `readRuntimeConfig`, `readSince` (new, src/ingest/runtime-text.ts): shared pure helpers.
- format `cursor:node-runtime`, `cursor:php-runtime` KV keys (new): value = ISO UTC timestamp of the newest fully processed post.
- function `defaultRegistry` (src/ingest/registry.ts): adds `"node-runtime"` and `"php-runtime"`. callers: left alone: `runCron` and `runIngesters` read it by key and need no change.
- format `Env` (src/env.ts): adds optional `GITHUB_TOKEN?: string`. callers: left alone: every existing reader ignores the new optional field.

## Design collisions
None. The only open PR is #24 (TCS-10, site). Its files do not include `src/ingest/**`, `src/env.ts` or `tests/cron/run.tcs-2.test.ts`, and it does not change `defaultRegistry` or `Env`. Main has no commit after `86ad46b`.
- `Env`: combine — PR #24 (ba7e81780924) does not edit `src/env.ts`; it only imports `type { Env }` in `src/routes/site.ts`, `src/routes/status.ts` and `src/site/data.ts` and reads existing bindings (`Hono<{ Bindings: Env }>`, `loadLatest(env: Env)`). This plan adds the optional `GITHUB_TOKEN?: string` field, which those new readers ignore, so both changes apply in either merge order with no conflict in `src/env.ts`.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty at plan time. PR #24 (TCS-10) is open; this plan edits none of its files.

## Files to touch
Product code (all new unless noted; all from r2 commit 918c024, F1/F2 edits on top):
1. `src/ingest/runtime-text.ts` (new, from r2, unchanged)
2. `src/ingest/node-runtime-client.ts` (new, from r2, + F2 `NodeLinkError` and `allowedOrigin`)
3. `src/ingest/node-runtime.ts` (new, from r2, + F2 catch)
4. `src/ingest/php-runtime-client.ts` (new, from r2, unchanged)
5. `src/ingest/php-runtime.ts` (new, from r2, + F1)
6. `src/ingest/registry.ts` (edit, from r2)
7. `src/env.ts` (edit, from r2)

Tests and fixtures (from r2 unless noted):
8. `tests/ingest/runtime-fake.tcs-6.ts`
9. `tests/ingest/node-runtime.tcs-6.test.ts` (+ N11 for F2)
10. `tests/ingest/php-runtime.tcs-6.test.ts` (P1 range assertion changes for F1, + P9, P10)
11. `tests/cron/runtime-ingest.tcs-6.test.ts` (+ C4 for F1 through `/v1/check`)
12. `tests/raw-modules.tcs-6.d.ts`
13. `tests/fixtures/node-runtime/2026-10-21.html`, `tests/fixtures/node-runtime/index.json`, `tests/fixtures/node-runtime/vulnerability.xml`, `tests/fixtures/node-runtime/README.md`
14. `tests/fixtures/php-runtime/2026-10-21.html`, `tests/fixtures/php-runtime/releases.xml`, `tests/fixtures/php-runtime/GHSA-w8hw-w9fx-j79w.json`, `tests/fixtures/php-runtime/GHSA-6wmf-4rv5-p3rp.json`, `tests/fixtures/php-runtime/README.md`
15. `tests/cron/run.tcs-2.test.ts` (edit, case 3b only, from r2)

## Tests that must change
- `tests/cron/run.tcs-2.test.ts`: case 3b pins `Object.keys(defaultRegistry)` to `["osv"]` and says "runtimes are out of scope"; this ticket adds the runtime ingesters, so the list becomes `["osv", "node-runtime", "php-runtime"]`.

```pr-body-requires
TEST-CHANGE: <- Tests that must change (tests/cron/run.tcs-2.test.ts case 3b)
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Verify (run, not edited)
- `npm ci` before the suite if `node_modules/@types/node` is absent (D-ENV: r2's first typecheck failed on a stale install, not on code).
- `npm test` (regression risk: `tests/cron/run.tcs-2.test.ts`, `tests/ingest/osv.tcs-2.test.ts`, `tests/ingest/upsert.tcs-2.test.ts`, the `tests/routes/check*` suites, `tests/worker/migrations.tcs-1.test.ts`)
- `npm run typecheck`

## Tasks

T1. Cherry-pick r2 commit `918c024` onto `86ad46b`.
VALIDATE: `git cherry-pick 918c024` exits 0; `git diff --stat origin/main` lists the 22 non-spec r2 paths; `npm test -- tests/ingest/node-runtime.tcs-6.test.ts tests/ingest/php-runtime.tcs-6.test.ts tests/cron/runtime-ingest.tcs-6.test.ts tests/cron/run.tcs-2.test.ts` exits 0 before F1/F2.
SATISFIES: ticket Scope bullets 1 to 4 (node-runtime, php-runtime, KV last_seen cursor, registry), as built and gated in r2.

T2. F1: PHP lowest-line range from `vulnerable_version_range` in `src/ingest/php-runtime.ts`.
VALIDATE: `npm test -- tests/ingest/php-runtime.tcs-6.test.ts -t "F1"` (P1 range, P9, P10) and `npm test -- tests/cron/runtime-ingest.tcs-6.test.ts -t "C4"`.
SATISFIES: "Unsupported lines (8.1 and older) get no fix." when the post says so, and "affected ranges per minor line (8.2, 8.3, 8.4, 8.5)" without a value that contradicts the source (CLAUDE.md rule 10).

T3. F2: Node post-link origin check in `src/ingest/node-runtime-client.ts` and `src/ingest/node-runtime.ts`.
VALIDATE: `npm test -- tests/ingest/node-runtime.tcs-6.test.ts -t "F2"` (N11).
SATISFIES: "reads the Node.js security release posts (nodejs.org blog feed …)" — posts are read from nodejs.org only.

T4. Full suite and typecheck, unpiped exit codes.
VALIDATE: `npm test; echo rc=$?` prints `rc=0` and `npm run typecheck; echo rc=$?` prints `rc=0`.
SATISFIES: ticket Verification contract (`npm test`, `npm run typecheck`).

## Acceptance tests
`tests/ingest/node-runtime.tcs-6.test.ts` (from r2; all I/O through `runtime-fake.tcs-6.ts`; `globalThis.fetch` called 0 times):
- N1 CVE-2026-111497: `fixed_versions` = `["22.23.4", "24.22.1", "26.12.1"]`; `severity.label` = `high`; `affected` length 3, contains `{introduced: "24.0.0", fixed: "24.22.1"}`; summary is one line, length < 200; `ecosystem` = `component` = `node`; source id = the CVE.
- N2 every CVE heading in the fixture is emitted with its rating word.
- N3 action for CVE-2026-111497 = `Upgrade node to 22.23.4 (22.x), 24.22.1 (24.x) or 26.12.1 (26.x) or later.`
- N4 run on fresh D1/KV: errors = [], KV `cursor:node-runtime` = `2026-10-21T22:00:00Z`.
- N5 re-run: `unchanged` = every advisory, `upserted` = 0, row count unchanged.
- N6 cursor after the post → feed fetch only, 0 post and 0 index fetches.
- N7 cursor equal to the post date → post re-read, all `unchanged`.
- N8 index without v24.22.1 → 0 upserts, error names `24.22.1`, cursor not written.
- N9 negative titles → 0 post fetches.
- N10 post 503 → run throws `NodeHttpError`, cursor not written.
- N11 (new, F2) a feed item whose link is `https://evil.example/post` with a "Security Releases" title, next to the real item → the fake records 0 calls to `evil.example`; `errors` has one line naming the link and `nodejs.org`; the real post's advisories are still upserted; cursor reaches the newest post date. A link on `https://nodejs.org/...` with a query string is still read (near miss).

`tests/ingest/php-runtime.tcs-6.test.ts` (from r2):
- P1 CVE-2026-109618 and CVE-2026-109619: `fixed_versions` contains `8.5.12`, `8.4.27`, `8.3.36`, `8.2.35`; `severity` = `{score: 9.2, label: "critical"}`; `action` contains `8.1` and `no fix`; `affected` has 4 ranges. CHANGED for F1: contains `{introduced: "0", fixed: "8.2.35"}` and `{introduced: "8.3.0", fixed: "8.3.36"}`, and does NOT contain `{introduced: "8.2.0", fixed: "8.2.35"}`.
- P2 run: errors = [], fetch calls = news 1 + releases 1 + GHSA 2; cursor `2026-10-21T00:35:26Z`.
- P3 re-run: `unchanged` = 2, GHSA calls = 0 (dedup), no new rows; `EXPLAIN QUERY PLAN` of `PHP_DEDUP_SQL` names the primary-key index, no `SCAN advisory_sources`.
- P4 no-fix sentence removed → action has no "no fix" sentence.
- P5 a patched version absent from the releases feed → 0 upserts for that post, error names the version, cursor not written.
- P6 GHSA 403 → run throws `PhpHttpError`, cursor not written.
- P7 `GITHUB_TOKEN` set → bearer header; unset → none.
- P8 negative titles → 0 GHSA calls.
- P9 (new, F1) an in-test copy of the GHSA whose lowest entry has `vulnerable_version_range: ">= 8.2.0, < 8.2.35"` → the lowest range is `{introduced: "8.2.0", fixed: "8.2.35"}` (a lower bound keeps the per-line start). Labelled `source: assumed`.
- P10 (new, F1) an in-test copy where the `< X` range sits on 8.3 only (8.2 entry removed) → the lowest emitted line 8.3 opens from "0"; the result has 3 ranges. Labelled `source: assumed`.

`tests/cron/runtime-ingest.tcs-6.test.ts` (from r2, production entry `worker.scheduled`):
- C1 both sources run: `last_ok_at` set, `last_error` null, rows with ecosystem `node` and `php`.
- C2 `POST /v1/check` with `node 24.10.0` and `php 8.3.20` → affected contains CVE-2026-111497 and CVE-2026-109618; `node 24.22.1` → CVE-2026-111497 absent.
- C3 deleting either registry entry makes C1 fail.
- C4 (new, F1) `POST /v1/check` with `php 8.1.30` → affected contains CVE-2026-109618 with `fixed_in` `8.2.35`; `php 8.2.35` → CVE-2026-109618 absent (near miss).

`tests/cron/run.tcs-2.test.ts` case 3b: `Object.keys(defaultRegistry)` = `["osv", "node-runtime", "php-runtime"]`, each `.id` equals its key.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| node-runtime reads security release posts, title contains "Security Release" | T1, T3 | N4, N9, N11 |
| node reads dist index to confirm a fixed version exists | T1 | N8 |
| one advisory per CVE, ecosystem/component = node | T1 | N1, N2 |
| affected ranges per release line, e.g. `>=24.0.0 <24.22.1` | T1 | N1 |
| fixed_versions per line | T1 | N1 |
| severity from the rating words | T1 | N1, N2 |
| action "Upgrade node to <fixed for your line> or later." | T1 | N3 |
| source id = CVE id | T1 | N1, P1 |
| post is the source of truth for fixed versions | T1 | N1, N8 |
| php-runtime reads releases feed and the PHP security advisories | T1 | P2, P5 |
| php ranges per minor line 8.2–8.5, fixed per line | T1, T2 | P1, P9, P10, C4 |
| php action "8.1 and older get no fix" only when the post says so | T1, T2 | P1, P4, C4 |
| severity score 9.2, label critical | T1 | P1 |
| KV last_seen cursor, skip older posts | T1 | N6, N7, P2 |
| register both in registry.ts | T1 | case 3b, C1, C3 |
| fixtures recorded from the real 2026-10-21 release | T1 | fixture READMEs (URL, time, sha256) |
| re-run yields unchanged for every advisory | T1 | N5, P3 |
| npm test, npm run typecheck green | T4 | T4 VALIDATE |
| NEGATIVE: Go/Python/Rust/Deno/Bun out of scope | none adds them | case 3b pins the exact key list |
| NEGATIVE: no duplicate advisory on re-run (rule 3) | T1 | N5, P3 row count |
| NEGATIVE: no fetch of a host other than the feed's origin | T3 | N11 |

## Iron laws applied
- UI laws (sortable headers, list-over-cards, drill-down, loading.tsx): n/a. No screen.
- DB-driven config: every URL, title match, backfill window and post cap is a `sources.config_json` key with a code fallback (rule 5). F2's allowed origin follows the configured `feed_url`.
- Schema, RLS, indexes: no migration, no new table (D1). The one new query, `SELECT 1 AS hit FROM advisory_sources WHERE source = ? AND source_id = ?`, is a primary-key seek; P3 asserts it with `EXPLAIN QUERY PLAN` on the seeded run.
- Retention: no new table. Two KV keys, one per source, overwritten in place.
- Correlated subquery: none.
- De-AI / model ids: no LLM, no model string. Summary and action are deterministic source text (rules 6, 10).
- Dedup before spend: GitHub is rate-limited (60/h unauthenticated), not billed. A9 reads the persisted `advisory_sources` row before every GitHub call. nodejs.org and php.net reads are bounded by `max_posts`.
- Scalable tests: one seam per vendor (`node-runtime-client.ts`; `php-runtime-client.ts` for php.net and api.github.com). Tests inject the URL-map fake (throws on an unmapped URL); 0 real network calls asserted. Each test has its own isolated D1/KV storage. No real-vendor contract suite: the repo has none for OSV either; [NOTE] for a later ticket.
- Performance: no screen or loader. Steady-state cron cost is 4 subrequests per tick (Node 3, PHP 1).

## Build discipline rules that bite
- Mutation: break the PHP lower-bound read (F1), the origin check (F2), the line-to-fixed map and the cursor write; a test must go red for each.
- Production entry: C1/C4 go through `worker.scheduled` and `/v1/check`.
- Fixtures: no fetch in execute and no hand-written page bytes; P9/P10/N11 are in-test edits of recorded copies, labelled as such.
- Unpiped exit codes for `npm test` and `npm run typecheck`.
- Per-ticket test files; the only edit to another ticket's test is case 3b.

## System invariants
(a) Cross-run state: KV `cursor:node-runtime`, `cursor:php-runtime` (ISO UTC of the newest complete post). Idempotency rests on the `advisory_sources` PK `(source, source_id)` through `upsertAdvisory`, not on the cursor. A lost cursor costs a re-read inside `backfill_days` and yields `unchanged`, never a duplicate.
(b) Side effects. Success: upsert first, cursor second, so "cursor moved without the advisory stored" cannot happen. HTTP failure: run throws, `sources.last_error` records it, cursor unchanged. Incomplete post: no upsert, error, cursor unchanged. Off-origin link (F2): no fetch, error, post counted done. Bad doc: error, other CVEs continue. GitHub call only after a dedup miss.
(c) Negative lists. Title classifier must NOT start a post read for: `Node.js v24.22.0 (LTS)`, `Node.js 26.12.0 (Current)`, `PHP 8.5.12 Released!`, `PHP 8.6.0 RC 3 available for testing`. Must match: `Wednesday, October 21, 2026 Security Releases`, a lowercase `security release`. Post level: a heading without a rating suffix and a dependency-update bullet emit nothing. F2: `https://evil.example/…` and `http://nodejs.org/…` (scheme differs from an https feed) are refused; `https://nodejs.org/en/blog/…?x=1` is read. F1: `>= 8.2.0, < 8.2.35` keeps the per-line start; `< 8.2.35` opens from "0"; a non-lowest line never opens from "0".
(d) Neighbors. `runIngesters` runs sources one at a time in id order and catches a throw per source, so a runtime failure never stops osv. Cron `*/10 * * * *`. OSV has no `node`/`php` runtime ecosystem, so these CVEs are owned by the runtime sources; a later NVD/KEV ingester only adds to them. `/v1/check` and the feed read the rows through existing indexes. PR #24 (TCS-10) touches none of these files.

## QA screens
None. No UI. Observable after deploy: `GET https://tocsin.sh/v1/events?ecosystem=node` and `?ecosystem=php` list the 2026-10-21 CVEs; `POST https://tocsin.sh/v1/check` with runtime `node 24.10.0` flags CVE-2026-111497 and `php 8.1.30` flags CVE-2026-109618.

## Design collision check (BH-5791)

Checked 10 listed and 0 derived symbols against main 86ad46bc9ba2..86ad46bc9ba2 and 1 open PRs.
- `Env` (function, listed): PR #24 ba7e81780924, (text match). Resolution: combine.

## Size
FILES: 7
LINES: 620
DIFF_KB: 195

KIND: feature
SIZE: M
