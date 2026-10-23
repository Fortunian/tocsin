# TCS-29 plan: PHP runtime lists GHSAs from the php-src advisories endpoint

Ticket: Fortunian/tocsin#29. Blocked-by #6 is CLOSED. The thread has 0 comments, so the issue body is the spec.
Already on main? No. `git log origin/main --since=2026-10-22T19:45:37Z -- src/ingest/php-runtime.ts` is empty. `-S security-advisories` finds only TCS-6/14/39/41, and none of them changes the php-runtime discovery path.
CodeGraph: NOT AVAILABLE on this box. I found callers with grep. `phpRuntime` is used only by `src/ingest/registry.ts:21`. `normalizePhpAdvisory`, `parsePhpPost` and `PhpHttpError` have no caller in `src/` outside the php-runtime files. Tests that use them: `tests/ingest/php-runtime.tcs-6.test.ts`.
Primer: `/root/harness/state/tocsin-context.md` was read. It has no verification map and no architecture doc.

## Spec changes from comments
none

## Scope

Today `phpRuntime.run` (src/ingest/php-runtime.ts:185-238) finds GHSAs only through php.net news posts titled "Security advisory". It then GETs each GHSA. After this change:

1. **Discovery:** the run lists `GET {ghsa_api_base}?state=published&sort=published&direction=desc&per_page={page_size}`, newest first, and follows the `Link rel="next"` URL. The next URL must be on the same origin, so `nextLink` from `src/ingest/github-advisories.ts` is reused. The list item has the same object shape as the single-GHSA answer, so the per-GHSA GET goes away.
2. **Cursor:** the KV key stays `cursor:php-runtime` (`PHP_CURSOR_KEY`). Its value is now the advisory `published_at`. Reading stops at the first advisory whose `published_at` is strictly older than the cursor. That advisory and all later ones are not read. An advisory equal to the cursor is read again, and dedup makes it `unchanged`. With no cursor, the start is now minus `backfill_days`, as before (`readSince`).
3. **Bound:** a new knob `max_advisories` (default 50) in `sources.config_json` of row `php-runtime`, with the fallback in `PHP_DEFAULTS`. If more than `max_advisories` advisories are newer than the cursor, the run throws. The error names the count and the knob. Nothing is written and the cursor does not move. Nothing is skipped silently. A second knob, `page_size` (default 100, the GitHub maximum per page), sets `per_page`. Both are read through `readRuntimeConfig`, so a bad value throws.
4. **Dedup before work:** `PHP_DEDUP_SQL` does not change. It runs for each listed advisory, keyed on its `cve_id` (`source_id` stays the CVE, so existing prod rows still match). A hit is `unchanged`, and the news and releases reads for that advisory are skipped.
5. **php.net news as the second source:** the news page is read lazily, once per run, and only when at least one listed advisory is not deduped. Each post whose title matches `title_match` (newest `max_posts`) is parsed into GHSA id → { entry, noFixLine, fixedVersions }. `fixedVersions` comes from a new pure parser, `parsePhpFixSentence`. It reads the "Update to PHP 8.5.12, 8.4.27, 8.3.36 or 8.2.35" sentence of the post. `normalizePhpAdvisory` uses these fixed versions ONLY when the GHSA has no `patched_versions`. When a post links the GHSA, the stored doc keeps today's output: the post link in `references` and as `sources[0].url`, and the "Unsupported lines" tail from `noFixLine`. When no post links it, `sources[0].url` and `references` are the GHSA `html_url`.
6. **GITHUB_TOKEN:** the list request sends `Authorization: Bearer` when the secret is set. With no secret it sends no auth header, which is the keyless limit. A non-OK list answer throws `PhpHttpError` with the status, the URL and the first 1000 chars of the answer body. `runIngesters` then marks the source failed with that text (`registry.ts:80,88`). Nothing is emitted and the cursor does not move.
7. **Releases check:** this does not change. A fixed version that is not in the php.net releases feed yet makes that advisory incomplete. It is an error, so the cursor does not move, and the advisory is read again next run.
8. **Cursor write:** only after a run with `errors.length === 0`. The new cursor is the newest `published_at` of the read items, and only if it is newer than the stored one. This is the same rule as `github-runtime.ts:335-338`.

Out of scope (ticket): other runtimes, and backfill older than the cursor.

## Files to touch
- `src/ingest/php-runtime.ts`: new run flow, `PHP_DEFAULTS` gets `max_advisories` and `page_size`, new `parsePhpFixSentence`, `normalizePhpAdvisory` gets an optional `entry` and an optional `fallbackFixed` argument, header comment.
- `src/ingest/php-runtime-client.ts`: new `fetchGhsaListPage`, and `PhpHttpError` gets an optional `body` field. `fetchGhsa` stays as it is.
- `tests/ingest/php-runtime.tcs-29.test.ts` (new): acceptance tests.
- `tests/fixtures/php-runtime/security-advisories.page1.json` (new): one recorded list page, `per_page=3`.
- `tests/fixtures/php-runtime/README.md`: one new row (URL, time, sha256) for the recorded page.
- `tests/ingest/php-runtime.tcs-6.test.ts`: only the run cases whose premise changes (see below).

## Tests that must change
- `tests/ingest/php-runtime.tcs-6.test.ts`: the run used to find GHSAs only through php.net "Security advisory" posts and GET each one, with the cursor on the post date. After TCS-29 the run lists the php-src advisories endpoint, with the cursor on the advisory `published_at`. Changes:
  - The `routes()` helper gets the list URL.
  - P2: the fetch counts change to 1 list + 1 news + 1 releases + 0 per-GHSA = 3. The cursor becomes the newest advisory `published_at`.
  - P6: the 403 goes to the list URL, not W8HW.
  - P7: the bearer check goes to the 1 list request, not 2 GHSA GETs.
  - P8: a post title that does not match now means that post is not used for the no-fix or fix sentence. The 2 advisories still come from the list.
  - The two `cursor:` cases use the advisory `published_at` values.
  - The text, seam, normalize, P3, P3b, P4 and P5 cases keep every assertion.

## Changed symbols
- function `phpRuntime.run` (src/ingest/php-runtime.ts): discovery moves from news posts plus per-GHSA GET to the paginated list endpoint. The cursor value becomes the advisory `published_at`. Callers: `defaultRegistry` (registry.ts:21) does not change.
- function `normalizePhpAdvisory`: `entry` may be undefined, and there is a new optional 6th argument `fallbackFixed`. callers: left alone: the tcs-6 normalize tests pass 5 args with an entry, and their output does not change.
- function `parsePhpFixSentence` (new, src/ingest/php-runtime.ts).
- format `PHP_DEFAULTS` / `sources.config_json` of row `php-runtime`: new keys `max_advisories` (50) and `page_size` (100).
- format KV `cursor:php-runtime`: the value's meaning changes from the post date to the advisory `published_at` (still ISO UTC).
- function `fetchGhsaListPage` (new, src/ingest/php-runtime-client.ts).
- function `PhpHttpError` constructor: a new optional `body` argument, added to the message. callers: left alone: `getText` and `fetchGhsa` pass no body, so their messages do not change.

```pr-body-requires
TEST-CHANGE: tests/ingest/php-runtime.tcs-6.test.ts <- Tests that must change
## ASSUMPTIONS <- ASSUMPTIONS section (copied verbatim)
```

## Verify (run, not edited)
- `npm test` (all suites; regression risk: `tests/ingest/php-runtime.tcs-6.test.ts`, `tests/ingest/deno-runtime.tcs-41.test.ts`, `tests/ingest/bun-runtime.tcs-41.test.ts` (they share `github-advisories.ts`, which this build only imports from), `tests/cron/*`, and every suite that runs `runIngesters` with `defaultRegistry`).
- `npm run typecheck`

## Tasks

### T1: seam: list page read with body-carrying error
In `src/ingest/php-runtime-client.ts`:
- Add `fetchGhsaListPage(fetchFn, url, token, allowedOrigin): Promise<{ body: unknown[]; next?: string }>`. It uses the same headers as `fetchGhsa`: Accept, User-Agent, X-GitHub-Api-Version, and Bearer only when the token is not blank. It throws when the answer is not a JSON array. It gets `next` from `nextLink(res.headers.get("Link"), allowedOrigin)`, imported from `./github-advisories`.
- On `!res.ok`, it throws `new PhpHttpError(res.status, url, (await res.text()).slice(0, 1000))`.
- `PhpHttpError` gets a third optional constructor argument, `body`. When `body` is present, the message adds `: <body>`. `fetchGhsa`, `fetchNews` and `fetchReleases` do not pass a body, so their messages do not change.
VALIDATE: npm test -- tests/ingest/php-runtime.tcs-29.test.ts -t "seam"
SATISFIES: Scope 4 "Use GITHUB_TOKEN when set … mark the source failed with the GitHub rate-limit body when 403"; Scope 1 "List advisories from the php-src GitHub security advisories endpoint directly … paginated, newest first".

### T2: pure parts: fix sentence parser and normalize fallback
In `src/ingest/php-runtime.ts`:
- Add `parsePhpFixSentence(content: string): string[]`. It runs on `htmlText(content)` and matches `Update to PHP <v>(, <v>)*( or|and <v>)` with X.Y.Z versions only. It returns the versions in source order, or `[]`.
- `normalizePhpAdvisory(entry | undefined, pair, raw, noFixLine, released, fallbackFixed?: string[])`:
  - When the patched set is empty and `fallbackFixed` is not empty, use `fallbackFixed` as the fixed set. The `rangeOf` map stays empty, so every line starts at `<line>.0`.
  - When both are empty, keep the "GHSA has no patched version" failure, now with `incomplete: true` (see ASSUMPTIONS).
  - When `entry` is undefined: `published_at` must come from the GHSA (else fail); the summary falls back to the CVE; `references` = [html_url]; `sources[0].url` = html_url (fail when html_url is missing).
  - Existing callers pass 5 args with an entry, and their output does not change.
VALIDATE: npm test -- tests/ingest/php-runtime.tcs-29.test.ts -t "normalize|sentence" && npm test -- tests/ingest/php-runtime.tcs-6.test.ts -t "normalize|text"
SATISFIES: Scope 1 "Keep the php.net news read as the second source of the fixed-version sentence when the advisory has no `patched_versions`."

### T3: run: list-driven discovery, cursor on published_at, max_advisories
Rewrite `run` in `src/ingest/php-runtime.ts` as in Scope steps 1 to 8.
- `PHP_DEFAULTS` gets `max_advisories: 50` and `page_size: 100`. Each has a comment that names `sources.config_json` row `php-runtime` as the knob.
- The URL is built with `advisoriesPageUrl(cfg.ghsa_api_base, cfg.page_size)` from `./github-advisories`.
- `ghsa_api_base` is also the list base. The default does not change.
- An advisory with no `cve_id` is an error (`<ghsa>: no CVE id yet`). It is not emitted and the cursor holds.
- Items are processed oldest first.
VALIDATE: npm test -- tests/ingest/php-runtime.tcs-29.test.ts
SATISFIES: Ticket acceptance 1 "a recorded `security-advisories` page with 3 advisories … yields 2 advisories with the right `fixed_in`, and the third is not read; a second run yields `unchanged` for both"; Scope 2 "Cursor on the advisory `published_at` … `max_advisories` … throws when exceeded"; Scope 3 "a stored CVE is never re-read".

### T4: fixture: record one live list page
- Run `curl -s -D headers.txt 'https://api.github.com/repos/php/php-src/security-advisories?state=published&sort=published&direction=desc&per_page=3' -o tests/fixtures/php-runtime/security-advisories.page1.json`. Send no token, and add the same Accept and API-version headers.
- Add the URL, the UTC time and the sha256 to the fixtures README. Write no byte of the fixture by hand.
- The "one without patched_versions" case is an in-test edit of the parsed page. Mark it `source: assumed, in-test edit`, as tcs-6 does. Pick the item that the 2026-10-21 news fixture links (w8hw or 6wmf), so its fix comes from the recorded "Update to PHP …" sentence.
- If the live page's newest 3 items do not include one of those GHSAs, record a later page that does, or the single page that holds them. Write the real URL in the README.
VALIDATE: sha256sum tests/fixtures/php-runtime/security-advisories.page1.json matches the README row; node -e "JSON.parse(require('fs').readFileSync('tests/fixtures/php-runtime/security-advisories.page1.json','utf8')).length===3||process.exit(1)"
SATISFIES: Ticket acceptance 1 "a recorded `security-advisories` page with 3 advisories".

### T5: acceptance tests for TCS-29
Write `tests/ingest/php-runtime.tcs-29.test.ts` (cases under Acceptance tests). Use `createGhFake` from `tests/ingest/github-fake.tcs-41.ts`, because it supports the Link `next` header. Use the source config `{ page_size: 3 }` so the list URL matches the recorded one. Clean the php-runtime rows and set the cursor in `beforeEach`, as tcs-6 does. Use unique ids for every seeded row. `afterAll` asserts that the real `fetch` spy was called 0 times.
VALIDATE: npm test -- tests/ingest/php-runtime.tcs-29.test.ts
SATISFIES: Ticket "Acceptance tests" (all three bullets).

### T6: re-point the tcs-6 run cases whose premise changed
Make the edits listed under "Tests that must change", and only those. Do not delete or skip any case. Every output assertion (rows, severity, action text, cursor-held-on-error, PhpHttpError on 403, bearer header) stays.
VALIDATE: npm test -- tests/ingest/php-runtime.tcs-6.test.ts
SATISFIES: Ticket acceptance 3 "The existing `php-runtime.tcs-6.test.ts` cases still pass."

### T7: full contract
VALIDATE: npm test && npm run typecheck (record the true exit codes, unpiped)
SATISFIES: Repo verification contract (CLAUDE.md) "A ticket is done when its acceptance tests fail before the change and pass after it."

## Acceptance tests
File: `tests/ingest/php-runtime.tcs-29.test.ts`
- **A1 (ticket acceptance 1):**
  - Setup: the recorded 3-item page. Item X keeps its `patched_versions`. Item Y has `patched_versions` removed in-test, and the news fixture post links it. Item Z's `published_at` is older than the cursor (the cursor is set between Y and Z).
  - After one run: `upserted === 2`, and X and Y are stored with `fixed_versions` / `affected[].fixed` equal to their expected values. Y's values come from the "Update to PHP …" sentence: 8.2.35, 8.3.36, 8.4.27, 8.5.12.
  - Z's CVE has no `advisory_sources` row, and Z is not counted in `fetched`.
  - The cursor equals the newest `published_at` of X and Y.
  - The fake shows exactly 1 list call, 1 news call, 1 releases call, and 0 per-GHSA GETs.
- **A2 (ticket acceptance 1, second run):** the same page again gives `unchanged === 2`, `upserted === 0`, the same row count, and 0 news and 0 releases calls (dedup before work).
- **A3 (ticket acceptance 2):**
  - Setup: the list answers 403 with the body `{"message":"API rate limit exceeded for 1.2.3.4. …"}`. The run goes through `runIngesters(env, { "php-runtime": phpRuntime }, now)`.
  - Expected: the outcome is `failed`, `sources.last_error` contains the body text and its length is ≤ 1000, there are 0 php-runtime rows, and the cursor does not change.
  - A second case uses a 1500-char body: `last_error` contains `body.slice(0, 500)` and its length is ≤ 1000.
- **A4 (max_advisories):** with `{ page_size: 3, max_advisories: 1 }` and 2 items newer than the cursor, the run throws an error that names `max_advisories`. There are 0 rows and the cursor does not change.
- **A5 (pagination, next link):** a page of 1 item with `next` pointing to a second page. Both pages are read in order. A next link on another origin throws `GithubLinkError` and makes 0 calls to that host.
- **A6 (token):** with `GITHUB_TOKEN` set, the list request carries `Bearer <token>`, and the news and releases requests carry no auth header. With the token unset, no request carries an Authorization header.
- **A7 (incomplete holds the cursor):** item Y without `patched_versions` and with no news post that links it gives an error that names the GHSA. X is still stored and the cursor does not move. On the next run with the news post present, Y is stored and the cursor moves.
- **A8 (sentence parser negatives):** `parsePhpFixSentence` returns `[]` for each of these:
  - "PHP 8.5.12 Released!"
  - "Update to PHP 8.6.0RC3"
  - "update your PHP install"
  - a page with no "Update to" sentence
  It returns the 4 versions for the recorded post.
- **A9 (no CVE):** an item with `cve_id: null` gives an error `<ghsa>: no CVE id yet`, it is not stored, and the cursor holds.

Mutation checks the build must run (D1): remove the `fallbackFixed` use (A1 goes red); remove the older-than-cursor stop (A1 Z goes red); remove the dedup seek (A2 goes red); drop the body from PhpHttpError (A3 goes red).

## QA screens
None. This is an ingester with no UI. The visible effect is `GET /v1/check?php=8.2.34` and `/v1/events` showing php advisories after a cron run. A browser QA pass is not useful here.

## Iron laws applied
- DB-driven knobs: `max_advisories` and `page_size` are keys of `sources.config_json` (row `php-runtime`), with code fallbacks in `PHP_DEFAULTS`. This is the existing php and deno pattern (`readRuntimeConfig`). No literal limit without a knob read.
- Dedup before spend (repo rule 7): the list page is the only metered GitHub read. The per-advisory GHSA GET is removed, so a run spends 1 page call (fewer calls than today's 1 per new GHSA). A stored CVE is never re-normalized (`PHP_DEDUP_SQL`, a PK seek, EXPLAIN-proven in tcs-6 P3b).
- Idempotent on (source, source_id) (repo rule 3): `source_id` stays the CVE.
- No new table, migration, index or retention rule: no schema change. KV keeps one key.
- Deterministic, no LLM, and no De-AI surface. Published text is a fact from a source with a link (repo rule 10). A fix version comes only from `patched_versions` or the php.net sentence, never a guess.
- Scalable tests: the vendor seam is `php-runtime-client.ts` (php.net and the php-src GitHub reads). The fake is `github-fake.tcs-41.ts` (0 network calls, throws on an unmapped URL). The contract test does not exist for php in this repo, so this build adds none (see ASSUMPTIONS). Each test seeds its own state in `beforeEach`. A real-fetch spy asserts 0 vendor calls.
- UI laws (sortable headers, list over cards, drill-down, mobile): n/a, there is no UI.
- Performance: no screen or loader. Ingest statements per run: 1 dedup seek per listed item (≤ max_advisories), plus the upserts.

## System invariants
- (a) Cross-run state: the KV `cursor:php-runtime` (one ISO timestamp) and `advisory_sources` (PK `(source, source_id)`) for dedup. The cursor moves only after a run with no error, so a capped, failed or incomplete run never skips an advisory. The cursor is never pruned.
- (b) Side effects:
  - GitHub list read: success gives items. A failure throws `PhpHttpError` with the body, and the source is marked failed. "Not configured" (no token) runs keyless.
  - D1 upsert: on success it counts upserted or unchanged. `InvalidAdvisoryError` is a record error. Any other error throws.
  - KV cursor write: last, only when errors are 0. "Cursor moved without the rows stored" is impossible, because every upsert is awaited before the write.
- (c) Matcher negatives: `parsePhpFixSentence` gates which fix versions are published. A1 and A8 include release-title text, RC versions, a lowercase "update your PHP", and a page with no sentence. None of them may yield versions. A GHSA whose post has no sentence and no `patched_versions` is never emitted.
- (d) Neighbours:
  - Cron ingest (`runIngesters`) runs sources in sequence. A php throw is caught per source (registry.ts:79) and does not stop deno or bun.
  - The keyless GitHub limit (60/h) is shared with python, deno and bun. This change lowers php's use from N per new GHSA to 1 page per run.
  - `github-advisories.ts` is imported only for `advisoriesPageUrl` and `nextLink`. It is not edited, so deno and bun do not change.
  - The existing KV cursor value (a post date) is a valid ISO timestamp under the new meaning. The first prod run re-reads from it, and dedup makes known CVEs `unchanged`.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| List from the php-src `security-advisories` endpoint, paginated, newest first | T1, T3 | A1, A5 |
| Not only php.net posts: a GHSA with no news post is still emitted | T2, T3 | A1 (X is not linked by a post, or its link is not used) and tcs-6 P8 (re-pointed) |
| Keep the news read as the second source of the fixed-version sentence when there are no `patched_versions` | T2, T3 | A1 (Y), A7, A8 |
| Cursor on `published_at`; stop at the first older advisory | T3 | A1 (Z not read), tcs-6 `cursor:` cases |
| `max_advisories` knob, default 50, throws when exceeded, nothing skipped | T3 | A4 |
| Dedup before the metered read stays (`PHP_DEDUP_SQL`) | T3 | A2, tcs-6 P3, P3b |
| GITHUB_TOKEN when set; keyless otherwise | T1, T3 | A6, tcs-6 P7 |
| 403 marks the source failed with the rate-limit body (first 1000 chars), emits nothing | T1, T3 | A3 |
| A second run gives `unchanged` for both | T3 | A2 |
| The existing tcs-6 cases still pass | T6 | `npm test -- tests/ingest/php-runtime.tcs-6.test.ts` |
| NEGATIVE: other runtimes do not change | none (no edit to github-advisories.ts or github-runtime.ts) | deno and bun tcs-41 suites stay green |
| NEGATIVE: no backfill older than the cursor | T3 | A1 (Z not read) |

## ASSUMPTIONS
- Ambiguous: the ticket says the tcs-6 cases "still pass", but those run cases pin news-driven discovery (fetch counts, a per-GHSA 403, the post-date cursor). Assumed: their output assertions stay, and only the routing, fetch-count and cursor-value lines move to the list endpoint (listed under Tests that must change; no case is deleted or skipped). Other reading: keep the news-driven discovery as a second, unchanged discovery path. I did not choose it, because it keeps a per-GHSA metered GET and two cursors for one source.
- Ambiguous: which cursor key to use. Assumed: the same KV key `cursor:php-runtime`, so the deploy starts from the last post date and does no backfill (the ticket puts backfill out of scope). Other reading: a new key, which would read `backfill_days` (120) of advisories on the first run.
- Ambiguous: an advisory with no `patched_versions` and no php.net fix sentence. Assumed: it is an error (incomplete). It is not emitted and the cursor holds, so it is retried each run and shows in `last_error` (D12: never skip silently). Other reading: a warning with the cursor moving past it, as github-runtime does for `no_fix`. That loses the advisory if the php.net post comes later.
- Ambiguous: an advisory with no `cve_id`. Assumed: an error with the cursor held, because `source_id` must stay the CVE for existing rows and dedup. Other reading: `source_id` = GHSA, which would make a duplicate row when the CVE is assigned later.
- `max_advisories` and `page_size` are `sources.config_json` keys with code fallbacks. There is no seed migration, which follows the TCS-41 deno and bun precedent (config_json `'{}'`). Other reading: a migration that does `json_insert` of the keys into the row.
- "Marks the source failed with that body (first 1000 chars)": the body goes into the `PhpHttpError` message (body cut to 1000 chars). `registry.ts` then stores `PhpHttpError: PHP source HTTP 403 for <url>: <body>`, cut to 1000 chars. Other reading: `last_error` equal to the bare body. I did not choose it, because it needs a registry change that touches every source.
- `fetchGhsa` stays exported and unchanged. After this change it has no production caller, and the tcs-6 seam cases pin it. Removing it is a cleanup [NOTE], not part of this ticket.
- No php contract suite (scalable-tests rule 4) exists today. Adding one is not in the ticket, so this build adds none.
- The news page is read only when a listed advisory is not deduped. Other reading: read it every run. That costs one php.net call per run for nothing.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty, so there are no live sibling claims.

KIND: feature

## Design collision check (BH-5791)

Checked 7 listed and 0 derived symbols against main a281180b5257..a281180b5257 and 1 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 2
LINES: 160
DIFF_KB: 90

SIZE: M
