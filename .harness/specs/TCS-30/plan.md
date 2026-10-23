# Plan: TCS-30 — Node runtime: pre-announcement post is not a failure; cache the dist index; July wording

Ticket: Fortunian/tocsin#30 (open, `ai-build`). Blocked-by #6: CLOSED. No TCS-30 PR or branch exists.
ALREADY ON MAIN? No. `git log origin/main --since=2026-10-22T19:45:38Z -- src/ingest/node-runtime.ts src/ingest/node-runtime-client.ts` is empty. The last change to these files is e344048 (TCS-6). `AFFECTS` at `src/ingest/node-runtime.ts:55` is still the old regex.
CodeGraph: NOT AVAILABLE on this box. I found the callers with grep instead: `nodeRuntime` → `src/ingest/registry.ts:18` only. `fetchDistIndex` → `src/ingest/node-runtime.ts:159` only. `normalizeNodePost` → node-runtime.ts plus `tests/ingest/node-runtime.tcs-6.test.ts`. `RunResult` → every ingester, but they only read the new field as optional. `runIngesters` error text → `src/cron/run.ts`.

## Evidence gathered in this planning session (2026-10-22 ~23:55Z)
- `GET https://tocsin.sh/v1/status`: node-runtime `last_error: null` at 23:50Z.
- `https://tocsin.sh/cve/CVE-2026-56846` (a July CVE) → 404. `/cve/CVE-2026-105482` (an October CVE) → 200. **The July CVEs are missing in prod.** The prod cursor is past the July post, so fixing the regex alone never re-reads July (see T5).
- The July post (`https://nodejs.org/en/blog/vulnerability/july-2026-security-releases`, HTTP 200) has 11 rated CVE headings. Its wording is "affects all users in active release lines: 24.x, 22.x" and once "affects all users of the Permission Model in active release lines: 26.x, 24.x, 22.x". Downloads: v22.23.2, v24.18.1, v26.5.1.
- The 2026-10-14 pre-announcement is the same URL as the October release post (Node edits the post in place). The Wayback capture `https://web.archive.org/web/20261014143758id_/https://nodejs.org/en/blog/vulnerability/october-2026-security-releases` is gzip, HTTP 200. Its headings are "Summary / Impact / Release timing / Contact and future updates", with 0 CVE headings. **It does NOT contain "pre-announcement" or "will be released".** It says "The Node.js project will release new versions of the 26.x, 24.x, 22.x releases lines" and "Releases will be available on, or shortly after". See ASSUMPTIONS A1.
- `https://nodejs.org/dist/index.json`: 334,935 bytes, `etag: "45b4cc5ffeb4ba28564a5872331d3d40"`. The same GET with `If-None-Match` set to that ETag → `304`, 0 bytes.

## Spec changes from comments
- 6350130006 liorwn (2026-10-22T20:04Z): adds the July wording ("affects all users in active release lines: …", and "all active release lines" with the lines after a colon). The recorded July post must yield 11 advisories with the right lines, and the October fixture must still yield 10 → T2, T6. It also adds a per-post count prefix ("july: 11 not emitted; october: 10 ok") at the start of `sources.last_error`, before the detail → T4. Implied by the same comment: the July CVEs must reach prod, and the prod cursor is past July → T5.

## ASSUMPTIONS
- A1: The ticket names the pre-announcement markers "pre-announcement" or "will be released". The real recorded 2026-10-14 post has neither. **Assumed:** the marker regex accepts the ticket's two phrases AND the two phrases the real post uses ("will release new versions", "releases will be available"). Each phrase counts only when the post has 0 CVE headings. Other reading: use only the ticket's literal two phrases. Then the ticket's own acceptance test (the recorded 2026-10-14 post) fails.
- A2: "TTL 1 hour, keyed with the response ETag". **Assumed:** the TTL is a freshness window, checked in code with `fetched_at` against `ctx.now()`. The window is the knob `dist_cache_seconds` (default 3600) in `sources.config_json`. After the window, the run sends a conditional GET with `If-None-Match: <stored etag>`. A 304 refreshes `fetched_at` and downloads no body. The KV key gets no `expirationTtl`, so the ETag outlives the window. It is one fixed key, overwritten in place, so it does not grow. Other reading: a KV `expirationTtl` of 3600. Then the ETag dies with the entry and the conditional GET is never used. Miniflare KV expiry also runs on the real clock, so the "after the TTL" test could not control time.
- A3: The pre-announcement "is read again on the next run". **Assumed:** a skipped post does NOT write the cursor, and the run stops at it, the same as an incomplete post (`break`). Posts are sorted oldest first, so a pre-announcement is in practice the newest post. Other reading: write cursor = post.published (a post at the cursor date is re-read anyway). I rejected it because a later post in the same run would move the cursor past the skipped post.
- A4: The July CVEs must land in prod. The prod cursor is past July. **Assumed:** add a small, self-healing parser revision. KV key `cursor:node-runtime:parser` holds `"2"`. While it is missing or different, the run ignores the stored cursor and reads the `backfill_days` window (120 days → the July and October posts). It writes the revision when the run completes without throwing. Upserts are idempotent on (source, source_id), so October re-reads as `unchanged`. Other reading: no code; the PR body asks an operator to delete KV `cursor:node-runtime` once in prod. I rejected that because nothing in this harness waits on a human step.
- A5: The per-post count prefix. **Assumed:** new optional field `RunResult.summary` (string). `runIngesters` puts it first in the failed error text: `<summary> | <n> record error(s): <detail>`, still cut to 1000 chars. The post label is the last path segment of the post link (for example `july-2026-security-releases: 11 not emitted; october-2026-security-releases: 10 ok`). Other ingesters do not set it, so their text does not change. Other reading: push the summary as `errors[0]`. I rejected it because the "N record error(s)" count would then be wrong (D13).
- A6: The dist cache is read lazily. A run whose posts have no CVE headings (a pre-announcement) does not read the dist index at all. The ticket says "read it from origin only when the cached entry is missing or a post needs a version the cache does not have", and this follows that.
- A7: The July `normalizeNodePost` test needs a dist set that holds v22.23.2, v24.18.1 and v26.5.1. The existing `index.json` fixture keeps only entries dated 2026-10-01 or later. **Assumed:** add a NEW fixture `index-since-2026-07.json` (same recording rule, cut at 2026-07-01). The existing `index.json` stays unchanged, because the tcs-6 cases pin it.

## Scope
1. A pre-announcement post (0 CVE headings, 0 unparsed CVE headings, and the body matches the marker regex) is a skip, not an error. The run adds no error, does not write the cursor, and stops (A3). `runIngesters` then writes MARK_OK: `last_run_at` and `last_ok_at` advance and `last_error` = NULL. A post with no CVE headings and no marker still gives `no CVE headings` (unchanged).
2. `AFFECTS` accepts "affects Node.js X.x, Y.x", "affects all users [of <thing>] in active release lines: X.x, Y.x" and "affects all active release lines: X.x, Y.x".
3. The dist index is cached in KV `CURSORS`, key `node-dist-index`, value `{"etag"?: string, "fetched_at": ISO, "versions": string[]}`, fresh for `dist_cache_seconds` (A2). Origin is read when there is no entry, when the entry is stale (a conditional GET), or when a post needs a version the cached set lacks (one forced conditional re-read per run, and only when the set came from the cache).
4. A per-post summary goes before the detail in `sources.last_error` (A5).
5. A parser revision re-reads the backfill window once after deploy (A4).
6. `GET /v1/status` is unchanged in shape. No change to `src/routes/status.ts`.

## Files to touch
- `src/ingest/node-runtime.ts` (modify)
- `src/ingest/node-runtime-client.ts` (modify: conditional `fetchDistIndex`)
- `src/ingest/node-runtime-dist.ts` (new: the KV dist cache)
- `src/ingest/types.ts` (modify: `summary?: string`)
- `src/ingest/registry.ts` (modify: summary prefix in the failed error text)
- `docs/RETENTION.md` (modify: two KV key paragraphs)
- `tests/ingest/node-runtime.tcs-30.test.ts` (new)
- `tests/ingest/node-runtime.tcs-6.test.ts` (modify `beforeEach` only, see Tests that must change)
- `tests/fixtures/node-runtime/2026-07-29.html` (new)
- `tests/fixtures/node-runtime/2026-10-14-pre.html` (new)
- `tests/fixtures/node-runtime/index-since-2026-07.json` (new)
- `tests/fixtures/node-runtime/README.md` (modify: three new rows and sha256s)

## Tests that must change
- `tests/ingest/node-runtime.tcs-6.test.ts`: this ticket changes two premises. (1) The stored cursor alone no longer sets the read window: a missing parser revision now forces a backfill, which breaks N6. (2) The dist index is no longer read from origin on every run: KV storage is shared across tests in a file (tcs-39 deletes its KV keys in `beforeEach` for the same reason), so a cached full index breaks N8. The change: add two lines to `beforeEach`, `await env.CURSORS.delete(NODE_DIST_KEY)` and `await env.CURSORS.put(NODE_PARSER_KEY, NODE_PARSER_REV)`, plus the import. No assertion changes.

```pr-body-requires
TEST-CHANGE: `tests/ingest/node-runtime.tcs-6.test.ts` <- Tests that must change
## ASSUMPTIONS <- plan ASSUMPTIONS A1-A7
```

## Changed symbols
- format `AFFECTS` regex (node-runtime.ts:55): accepts the July wordings.
- function `isNodePreAnnouncement` (new, node-runtime.ts): pure. `(html) => boolean`.
- function `normalizeNodePost`: a pre-announcement gives `{docs: [], errors: [], incomplete: false, preAnnouncement: true}` and no `no CVE headings` error. New field `needsDist: boolean` = some fixed version is missing from the given dist set. New field `notEmitted: number`. Existing fields keep their meaning. Callers: run (changed), tcs-6 tests (left alone: they read `docs`, `errors` and `incomplete` only).
- function `fetchDistIndex` (client): `(fetchFn, url, etag?) → {notModified: true} | {notModified: false, versions: Set<string>, etag?: string}`. It sends `If-None-Match` when it has an etag and the `User-Agent: tocsin.sh` header as before. Its only caller is node-runtime.ts, which this plan changes.
- function `loadNodeDistIndex` (new, node-runtime-dist.ts): `(fetchFn, kv, url, ttlSeconds, now, force) → {versions, fromCache}`.
- format KV `node-dist-index` (new): `{etag?, fetched_at, versions[]}`.
- format KV `cursor:node-runtime:parser` (new): the string `"2"`.
- format `NODE_DEFAULTS.dist_cache_seconds` (new knob, default 3600, overridable in `sources.config_json` of row `node-runtime`).
- format `RunResult.summary` (new, optional).
- function `runIngesters`: the failed error text is `<summary> | ` + the old text when `summary` is set. Callers: `src/cron/run.ts` (left alone: it passes the outcome through unchanged).

## Tasks

T1 — Pre-announcement is a skip.
In node-runtime.ts, add `PRE_ANNOUNCE = /pre-announcement|will be released|will release new versions|releases will be available/i` and `isNodePreAnnouncement(html)`, which returns true when `parseNodeSecurityPost` finds 0 CVE and 0 unparsed headings AND `PRE_ANNOUNCE` matches `htmlText(html)`. `normalizeNodePost` returns early with `preAnnouncement: true` and no errors. In `run`, call `isNodePreAnnouncement(html)` BEFORE the dist index is needed. On a pre-announcement, add the summary line `<slug>: pre-announcement, read again next run`, write no cursor, and `break`.
VALIDATE: `npx vitest run tests/ingest/node-runtime.tcs-30.test.ts -t "pre-announcement"` passes. On the base commit it fails.
SATISFIES: Scope 1, "A pre-announcement post … is a `skipped` outcome, not a failure: last_run_at advances, last_ok_at advances, last_error stays NULL, and the post is read again on the next run".

T2 — July wording in AFFECTS.
Replace line 55 with:
`/affects\s+(?:Node\.js|(?:all\s+users(?:\s+of\s+[^:.]{1,80}?)?\s+in\s+)?(?:all\s+)?active\s+release\s+lines:)\s+((?:\d+\.x(?:\s*,\s*and\s+|\s*,\s*|\s+and\s+)?)+)/i`
The line extraction on line 78 stays as it is.
VALIDATE: `npx vitest run tests/ingest/node-runtime.tcs-30.test.ts -t "July"` passes: 11 docs, the lines per CVE as in the table below. `npx vitest run tests/ingest/node-runtime.tcs-6.test.ts` still passes (October = 10).
SATISFIES: comment 6350130006, "accept both wordings (and 'all active release lines' with the lines listed after a colon)… a recorded copy of the July 2026 post yields 11 advisories with the right lines; the existing October fixture still yields 10".

T3 — Dist index KV cache.
Client: make `fetchDistIndex` conditional (see Changed symbols). New `node-runtime-dist.ts` exports `NODE_DIST_KEY = "node-dist-index"` and `loadNodeDistIndex`. It reads KV and parses the value; an unreadable value counts as a miss. If the entry is fresh (`now - fetched_at < ttl*1000`) and `force` is false → `{versions, fromCache: true}`. Otherwise it fetches with the stored etag. On 304 with an entry, it re-puts the entry with `fetched_at = now` and returns `fromCache: false`. On 304 with no entry, it throws an Error ("304 with no cached dist index"). On 200, it puts `{etag, fetched_at, versions}`, without the `etag` field when the header is absent. No `expirationTtl` (A2).
In `run`: `NODE_DEFAULTS.dist_cache_seconds = 3600`, with the comment "fallback for sources.config_json.dist_cache_seconds". Load lazily on the first post that is not a pre-announcement. If `norm.needsDist && dist.fromCache`, reload once with `force = true` and normalize again. Remove the eager fetch at line 159.
VALIDATE: `npx vitest run tests/ingest/node-runtime.tcs-30.test.ts -t "dist index"` passes: 2 runs 30 min apart → INDEX count 1; a third run at +61 min → count 2, and that call carries `if-none-match`; a fresh cache that lacks a needed version → re-read in the same run.
SATISFIES: Scope 2, "Cache the dist index in KV (CURSORS binding, key node-dist-index, TTL 1 hour, keyed with the response ETag). Read it from origin only when the cached entry is missing or a post needs a version the cache does not have."

T4 — Per-post summary before the detail.
types.ts: add `summary?: string`, with a comment. In node-runtime `run`, collect one line per post read: `<slug>: <n> ok` with `, <m> not emitted` added when m > 0; `<slug>: incomplete, read again next run`; `<slug>: not read` for a NodeLinkError; and the T1 skip line. `<slug>` = the last non-empty path segment of the link. Set `result.summary = lines.join("; ")` when there is at least one line. registry.ts: failed `error = (summary ? `${summary} | ` : "") + "<n> record error(s): …"`, cut to 1000 chars as now.
VALIDATE: `npx vitest run tests/ingest/node-runtime.tcs-30.test.ts -t "summary"` passes: through `runIngesters`, `sources.last_error` starts with `july-2026-security-releases: 10 ok, 1 not emitted; october-2026-security-releases: 10 ok | 1 record error(s):`. `npx vitest run tests/cron` stays green.
SATISFIES: comment 6350130006, "prefix the error with a count per post ('july: 11 not emitted; october: 10 ok') before the detail".

T5 — Parser revision re-reads the window once.
Export `NODE_PARSER_KEY = "cursor:node-runtime:parser"` and `NODE_PARSER_REV = "2"` (the parser identity, not a limit). In `run`, if `kv.get(NODE_PARSER_KEY) !== NODE_PARSER_REV`, use `sinceMs = now - backfill_days` and ignore the stored cursor. After the loop (and on the `posts.length === 0` return), put the revision. A throw leaves the key unwritten, so the next run tries again.
VALIDATE: `npx vitest run tests/ingest/node-runtime.tcs-30.test.ts -t "parser revision"` passes: cursor = October pubDate and no revision key → the July post is read and 11 July advisories are stored; the revision key is written; the next run reads only October.
SATISFIES: comment 6350130006, "all 11 CVEs in that post report 'no affected release lines, not emitted'". The July CVEs must reach the prod feed, where CVE-2026-56846 is 404 today.

T6 — Fixtures, recorded, not hand-written.
Record into a scratch dir outside the repo, then copy the byte slice in:
(a) `2026-07-29.html` = the `<main …>…</main>` slice of `https://nodejs.org/en/blog/vulnerability/july-2026-security-releases`.
(b) `2026-10-14-pre.html` = the `<main …>…</main>` slice of `https://web.archive.org/web/20261014143758id_/https://nodejs.org/en/blog/vulnerability/october-2026-security-releases`. It is gzip: gunzip it first.
(c) `index-since-2026-07.json` = `https://nodejs.org/dist/index.json`, the lines whose `date` ≥ `2026-07-01`, each line unedited, joined into a JSON array. This uses the same rule as the existing `index.json`.
Add README rows with the source URL, the recording time, the full-file sha256 and the slice rule.
VALIDATE: `sha256sum tests/fixtures/node-runtime/*` matches the README. `grep -c 'CVE-2026-' tests/fixtures/node-runtime/2026-10-14-pre.html` → 0. `grep -c 'v26.5.1' tests/fixtures/node-runtime/index-since-2026-07.json` ≥ 1.
SATISFIES: "the recorded 2026-10-14 pre-announcement post" and "a recorded copy of the July 2026 post".

T7 — Existing tcs-6 suite and docs.
Make the two-line `beforeEach` change in tcs-6 (see Tests that must change). In RETENTION.md, add two paragraphs under the KV sections: `node-dist-index` (one key, overwritten in place, no growth, no delete job) and `cursor:node-runtime:parser` (one key).
VALIDATE: `npx vitest run tests/ingest/node-runtime.tcs-6.test.ts` passes. `npm test` and `npm run typecheck` exit 0, with the unpiped exit code recorded.
SATISFIES: "The existing node-runtime.tcs-6.test.ts cases still pass."

T8 — Status shape unchanged.
No code change. A test pins it.
VALIDATE: `npx vitest run tests/ingest/node-runtime.tcs-30.test.ts -t "status shape"` passes: after the pre-announcement run, `loadStatus(env)` (the loader behind `GET /v1/status`, as in `tests/routes/status-ledger.tcs-50.test.ts`) gives the node-runtime entry the keys `id, kind, last_run_at, last_ok_at, last_error, last_warning`, and `last_error === null`.
SATISFIES: Scope 3, "GET /v1/status is unchanged in shape".

## Decision rule tables (asserted case by case in tcs-30)
AFFECTS: match → lines
| text | expect | source |
|---|---|---|
| "affects Node.js 24.x, 22.x" | [22,24] | October fixture |
| "affects all users in active release lines: 24.x, 22.x" | [22,24] | July fixture, CVE-2026-56846 |
| "affects all users of the Permission Model in active release lines: 26.x, 24.x, 22.x" | [22,24,26] | July fixture |
| "affects all active release lines: 24.x, 22.x, 20.x" | [20,22,24] | assumed (comment) |
| "affects all users in active release lines: none" | no match | assumed |
| "affects all users" (no lines) | no match | assumed |
| "affects all End-of-Life release lines: 18.x" | no match | assumed |
| "active release lines: 24.x" (no "affects") | no match | assumed |

Pre-announcement: skip vs error
| post | expect |
|---|---|
| recorded 2026-10-14 pre-announcement | skip |
| in-test: "Summary" section with "This is a pre-announcement" | skip (assumed) |
| in-test: "Releases will be released on …" body, no CVE heading | skip (assumed) |
| recorded October release post (holds "Release timing" text AND CVE headings) | not skip, 10 docs |
| recorded July post (holds "Release timing" sections AND CVE headings) | not skip, 11 docs |
| in-test: no CVE headings, no marker | error `no CVE headings` |
| in-test: a marker phrase plus one unrated CVE heading | error, not skip |

## System invariants
- (a) Cross-run state: KV `CURSORS` holds three node keys. `cursor:node-runtime` (existing) = the last complete post. `cursor:node-runtime:parser` = the parser revision. `node-dist-index` = a cache only: losing it costs one download and never changes data. No D1 table is added. A dedup or watermark here is the advisory upsert key (source, source_id), which is unchanged.
- (b) Side effects: the nodejs.org reads are not billed. Order in each run: the feed, then each post, then the dist index (lazy). The cursor is written only after the post's upserts succeed (unchanged). A pre-announcement and an incomplete post write no cursor. The parser revision is written only after the loop completes. The dist cache is written only after a 200 or 304 parse succeeds. A failed parse throws and writes nothing.
- (c) Adversarial negatives for the skip (it hides a post from `last_error`): the final October and July posts both hold "Release timing" text and must NOT skip (tested). A post with an unrated CVE heading and a marker must NOT skip. A no-heading post with no marker stays an error.
- (d) Neighbors: the cron runs ingesters in sequence (`runIngesters`). The `summary` field is optional, so osv, nvd, kev, epss, php and python are unchanged (tests/cron stays green). The KV namespace is shared with `rl:`, `nvd:` and `python:` keys, and the new key names are unique. `max_posts` (5) caps the T5 backfill. The 120-day window holds 2 matching posts today.

## Requirements coverage
| Requirement | Task | Test (tests/ingest/node-runtime.tcs-30.test.ts) |
|---|---|---|
| A pre-announcement is skipped, not a failure | T1 | "pre-announcement: recorded 2026-10-14 post → 0 advisories, errors [], cursor unchanged, 0 INDEX calls" |
| last_run_at and last_ok_at advance, last_error NULL | T1 | "pre-announcement through runIngesters: sources row last_ok_at = now, last_error null" |
| Read again until it carries CVE headings; then the 2026-10-21 post yields 10 | T1 | "pre-announcement then release: run 2 with the October fixture upserts 10" |
| Stop marking failed every 10 minutes (NEGATIVE: no error for a pre-announcement) | T1 | the same test asserts `errors` is `[]` |
| Dist index in KV `node-dist-index`, TTL 1 h, ETag | T3 | "dist index: 2 runs in 1 h → 1 fetch; +61 min → 2nd fetch with if-none-match; 304 reuses the cache" |
| Read origin when a post needs a version the cache lacks | T3 | "dist index: fresh cache without v24.22.1 → forced re-read, 10 stored" |
| Dist index no longer downloaded every run (NEGATIVE) | T3 | the INDEX count assertions above |
| /v1/status unchanged in shape | T8 | "status shape" |
| July wordings accepted; July yields 11 with the right lines | T2 | "July: normalizeNodePost on the recorded July post → 11 docs, lines per table" plus the AFFECTS table cases |
| October still yields 10 | T2 | tcs-6 N2 and N4 (unchanged) plus the tcs-30 July+October run |
| Per-post count prefix before the detail | T4 | "summary: last_error starts with the per-post line" |
| The July CVEs reach the feed (prod cursor past July) | T5 | "parser revision" |
| Existing tcs-6 cases pass | T7 | `tests/ingest/node-runtime.tcs-6.test.ts` |

## Acceptance tests
File: `tests/ingest/node-runtime.tcs-30.test.ts` (vitest, the api project, `cloudflare:workers` env). It has the same `beforeEach` shape as tcs-6, and it also deletes `node-dist-index` and puts the parser revision except in the T5 cases. `afterAll` asserts 0 real `globalThis.fetch` calls, except in the runIngesters cases, where `globalThis.fetch` is spied with `mockImplementation(fake.fetch)`, so the test still makes 0 network calls. INDEX uses an in-test wrapper around `createRuntimeFake`: it answers 200 with an `ETag` header, or 304 with a null body when `if-none-match` matches. Imported only; `runtime-fake.tcs-6.ts` is not edited.
1. AFFECTS table: each row, through `parseNodeSecurityPost` on a minimal in-test h2 section.
2. July: `normalizeNodePost({link: JULY, published: "2026-07-29T00:00:00Z"}, julyHtml, DIST_JULY)` gives 11 docs and errors []. Lines: CVE-2026-56846 → [22,24]; CVE-2026-56850 → [24,26]; the other 9 → [22,24,26]. CVE-2026-58043 (Permission Model wording) → [22,24,26]. Fixed versions are 22.23.2, 24.18.1 and 26.5.1.
3. pre-announcement unit: `isNodePreAnnouncement(preHtml)` is true. It is false for the October and July fixtures. The skip-table rows.
4. pre-announcement run: POST → preHtml gives `errors` [], 0 upserted, cursor still `2026-10-01T00:00:00Z`, INDEX count 0, and the summary names the skip.
5. Then POST → the October fixture gives 10 upserted and the cursor = PUB.
6. Through `runIngesters(env, {"node-runtime": nodeRuntime}, now)` with the pre-announcement: the `sources` row has last_error NULL and last_ok_at = last_run_at = now. Then `loadStatus` gives the key set (T8).
7. dist index: run at NOW, then at NOW+30 min (cursor = PUB, re-read) → INDEX count 1. Then at NOW+61 min → count 2, and the 2nd call has `if-none-match`. The wrapper answers 304, and the run still has 10 unchanged.
8. dist index force: pre-put a fresh cache whose versions lack v24.22.1 → INDEX count 1 in this run, 10 upserted, and the cache now has v24.22.1.
9. summary: the July post with one "affects …" sentence removed in-test, plus October, through runIngesters → `last_error` starts with `july-2026-security-releases: 10 ok, 1 not emitted; october-2026-security-releases: 10 ok | 1 record error(s):`.
10. parser revision: cursor = `2026-10-21T22:00:00Z` and no revision key, with feed + July + October + DIST_JULY → 21 advisories (11 inserted, 10 inserted), and the revision key = "2". Next run: the July post is not fetched (count 1 for JULY over both runs).
Mutation checks (D1): revert AFFECTS → test 2 red. Make the skip return an error → tests 4 and 6 red. Remove the cache read → test 7 red. Remove the force path → test 8 red. Remove the summary prefix → test 9 red. Remove the revision check → test 10 red.
Regression risk: `tests/ingest/node-runtime.tcs-6.test.ts` (direct), `tests/cron/*` (registry error text), `tests/cron/warnings.tcs-50.test.ts`, `tests/routes/status-ledger.tcs-50.test.ts`.

## Verify (run, not edited)
- `npm test` (all suites), `npm run typecheck`.
- `tests/cron/run.tcs-2.test.ts`, `tests/cron/warnings.tcs-50.test.ts`, `tests/routes/status-ledger.tcs-50.test.ts`.

## Iron laws as they apply
- DB-driven config: the new TTL is the knob `dist_cache_seconds` in `sources.config_json`, with the code fallback in NODE_DEFAULTS. This is the same pattern as `backfill_days`. Regexes and the parser revision are parser identity, not limits.
- Indexes / EXPLAIN: no new table, no new query. Retention: the two KV keys are single, overwritten keys, documented in RETENTION.md (T7).
- Idempotency: ingestion stays idempotent on (source, source_id). The T5 re-read gives `unchanged` for October.
- Dedup before spend: no metered call (nodejs.org is free). The cache cuts the 335 KB download to a 304.
- Scalable tests: the vendor seam stays `node-runtime-client.ts`. Tests use the fake, 0 network calls, and their own keys. A contract suite is n/a (no new vendor).
- No LLM, no UI, no model id, no secrets, no migration. Sortable headers, list-over-cards, drill-down, De-AI and RLS: n/a (no screen).
- Performance: no screen or loader changed. Cron cost goes down: a 335 KB fetch every 10 min becomes ≤1 conditional GET per hour.
- Build discipline that bites: D1 (mutation checks, listed above), D2 (runIngesters cases), D4 (recorded fixtures only, in-test edits marked "source: assumed"), D6 (unpiped exit codes), D9 (a skip is not a success for a post with CVE headings), D12 (an incomplete post still stops the run), D13 (the summary count stays true; A5), D26 (fixtures recorded, not fabricated).

## QA screens
None in a browser. After deploy, probe `curl -s https://tocsin.sh/v1/status` (node-runtime `last_error` null) and `curl -s -o /dev/null -w '%{http_code}' https://tocsin.sh/cve/CVE-2026-56846` (expect 200 after the first cron run past deploy).

## Reproduction
REPRO: `npx vitest run tests/ingest/node-runtime.tcs-30.test.ts` (with the T6 fixtures and the new test file applied on the merge base ff7bd9b)
OBSERVED: the recorded 2026-10-14 post gives the error `…/october-2026-security-releases: no CVE headings`, which marks node-runtime failed. The July post gives 11 errors "no affected release lines, not emitted" and 0 docs. Every run downloads `dist/index.json` (INDEX count = runs). In prod, CVE-2026-56846 is 404.
EXPECTED: the pre-announcement is a skip with no error. July gives 11 docs. The dist index is read once per hour (or on a missing version). July CVEs are in the feed.
ROOT CAUSE: `src/ingest/node-runtime.ts:105` (every no-heading post is an error), `src/ingest/node-runtime.ts:55` (`AFFECTS` knows only "affects Node.js"), `src/ingest/node-runtime.ts:159` (an eager, uncached `fetchDistIndex` on every run that has a post in the window).
BLAST RADIUS: `nodeRuntime.run` ← `src/ingest/registry.ts` `runIngesters` ← `src/cron/run.ts` (scheduled). `normalizeNodePost` and `parseNodeSecurityPost` ← tcs-6 tests. `runIngesters` error text → `sources.last_error` → `/v1/status`, `loadStatus` (site status page). No other ingester shares the node parser.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty. Open PR #31 (TCS-14) touches none of these files.

## Design collision check (BH-5791)

Checked 10 listed and 0 derived symbols against main ff7bd9b9db98..ff7bd9b9db98 and 1 open PRs.
- `AFFECTS` (function, listed): PR #31 106d954670e2, (text match). Resolution: combine.
- `normalizeNodePost` (function, listed): PR #31 106d954670e2, body or signature changed. Resolution: combine.
- `fetchDistIndex` (function, listed): PR #31 106d954670e2, body or signature changed. Resolution: combine.

## Size
FILES: 5
LINES: 140
DIFF_KB: 210

KIND: bug
SIZE: M

## Design collisions
Checked 2026-10-22. Commit 106d954 is the first, pre-merge TCS-6 commit, and it is part of the history of PR #31 (`ticket/tcs-14`, OPEN, CONFLICTING). PR #31's head ee2b0cf has merge-base e344048 (TCS-6 #25, merged). `git diff origin/main ee2b0cf -- src/ingest/node-runtime.ts src/ingest/node-runtime-client.ts` is empty. PR #31 does not change these two files against main.
- `AFFECTS`: combine — 106d954 has the same old regex as main (`node-runtime.ts:55`), and PR #31's head does not change it. T2 widens that regex on main, and PR #31 never touches it.
- `normalizeNodePost`: combine — 106d954 has the same body and signature as main. Its only difference is that the `run` caller reads the post with no origin check, which e344048 replaced. T1/T3 add `preAnnouncement`, `needsDist` and `notEmitted` on top of main. PR #31's head keeps main's version, so the two do not overlap.
- `fetchDistIndex`: combine — 106d954 and main have the same `(fetchFn, url)` body. Only the neighbouring `fetchPost`/`NodeLinkError` code differs, and main keeps the origin check. T3 makes `fetchDistIndex` conditional (etag, `{notModified}`) on main's version. PR #31's head does not change `node-runtime-client.ts`.
