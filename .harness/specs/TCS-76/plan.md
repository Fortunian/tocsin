# TCS-76 plan: Node parser reads the December 2025, March 2026 and June 2026 posts

Ticket: https://github.com/Fortunian/tocsin/issues/76 (Blocked-by #69: CLOSED, merged as 5f7e4bf).
Already on main? `git log origin/main --since=2026-10-23T13:20:55Z` shows only 5f7e4bf (TCS-69, the ledger this ticket builds on). No commit since the ticket was filed touches the parser wording. Nothing is done yet.

## Spec changes from comments
- 6365996503 liorwn (2026-10-23T13:28Z): no scope change. It adds a deadline: the ticket must land before 2027-01-13, when the December 2025 post leaves the 365-day coverage hold. All tasks below deliver the full scope, so the deadline needs no extra task.

## What the posts say (live probe, this session, 2026-10-23 ~13:40Z, all HTTP 200)
Recordings saved on this box in `/root/harness/builds/tocsin-TCS-76-202610231331/recordings/` (full pages, `SHA256SUMS`, `RECORDED_AT`). The build must cut fixtures from these files if it has no egress to nodejs.org.
- December 2025 post (full-page sha256 8207c4fe…, the same as the TCS-69 recording, so `tests/fixtures/node-runtime/2026-01-13-incomplete.html` is current). 8 rated CVE headings. Gaps:
  - "Downloads and release details" lists `Node.js 20.20.0` with NO "v". `parseNodeSecurityPost` (src/ingest/node-runtime.ts:125) only matches `Node\.js v…`, so `fixed` is empty → "no fixed version for 20.x, 22.x, 24.x" (and 25.x). (README.tcs-69.md says the heading "has no release under it"; that is wrong: the list is there, without the "v".)
  - "affects users of the permission model on Node.js 20.x, 22.x, 24.x, and 25.x" (CVE-2025-55130, CVE-2025-55132) and "The issue affects users of the Node.js permission model on Node.js 25.x" (CVE-2026-21636): AFFECTS (line 94) does not match.
  - CVE-2025-59464: "This vulnerability was already fixed on Node.js 24.12.0. It has no impact on other active release lines. This public CVE is only issued for the affected 24.x releases." → line 24, fixed 24.12.0 (a version the Downloads list does not name; the dist index has v24.12.0, date 2025-12-10).
  - CVE-2026-21637: "This vulnerability affects TLS servers using PSK or ALPN callbacks across Node.js versions where these callbacks throw without being safely wrapped." No line list. The post's "Security releases available" section says "Updates are now available for the 25.x, 24.x, 22.x, and 20.x Node.js release lines".
- March 2026 post (sha256 bedfe70a…, NOT recorded yet). 9 rated CVE headings; today 1 is emitted (CVE-2026-21711, "affects Node.js 25.x"), 8 are not. Wordings: "affects all Node.js versions that received the CVE-2026-21637 fix, including 20.x, 22.x, 24.x, and 25.x ,"; "affects all Node.js HTTP servers on 20.x, 22.x, 24.x, and v25.x"; "affects 24.x and 25.x ."; "affects 20.x, 22.x, 24.x, and 25.x ."; "affects 20.x, 22.x, 24.x, and 25.x processes using the Permission Model …"; "affects HTTP2 users on Node.js 20, 22, 24 and 25." Downloads: v20.20.2, v22.22.2, v24.14.1, v25.8.2.
- June 2026 post (sha256 4a9c6443…, same as `2026-06-18.html`). 12 rated headings, 0 emitted. Wordings: "affects all supported release lines: Node.js 22 , Node.js 24 , and Node.js 26 ."; "affects two supported release lines: Node.js 22 and Node.js 24 ."; "affects one supported release line: Node.js 26 .". Downloads: v22.23.0, v24.17.0, v26.3.1.
- None of the three posts has an HTML `<table>`. The "release-line table shape" of the ticket is the "Node.js 22 , Node.js 24 , and Node.js 26" list.
- Dist index (sha256 6c56f52f…, the same as the 2026-10-22 recording that `tests/fixtures/node-runtime/README.md` names): has every fixed version above (v20.20.0, v22.22.0, v24.12.0, v24.13.0, v25.3.0 on 2025-12-10/2026-01-12; v20.20.2, v22.22.2, v24.14.1, v25.8.2 on 2026-03-24; v22.23.0, v24.17.0, v26.3.1 on 2026-06-17).
- CVE-2026-21637 is a heading in BOTH the December post (fixed 20.20.0/22.22.0/24.13.0/25.3.0) and the March post ("Incomplete fix for CVE-2026-21637", fixed 20.20.2/22.22.2/24.14.1/25.8.2). Both emit source key (node-runtime, CVE-2026-21637). See task T3.

## Scope
1. Record the March 2026 post and a dist-index slice as fixtures, with a README (URL, sha256, rule). December and June are already recorded and unchanged.
2. Extend the parser, ADDITIVELY: every post the parser reads in full today reads the same after the change. New wordings apply only where the current regexes find nothing.
3. A parser revision bump ("3" → "4"), so the TCS-69 walk re-reads every ledger row once (this includes every failed row, every empty-with-note row and every ok row with unemitted > 0).
4. A newer-post guard for a CVE that two posts name, so an older post never overwrites the fixed versions of a newer post.
5. coverage_since for node then sets itself under the #69 rule (no code change in the coverage rule).

## Files to touch
- `src/ingest/node-runtime.ts` (product code: parser, normalize, NODE_PARSER_REV, storeDocs guard)
- `tests/fixtures/node-runtime/2026-03-24.html` (new: `<main>` byte slice of the March recording)
- `tests/fixtures/node-runtime/index-2025-12-to-2026-06.json` (new: dist-index slice, entries dated 2025-12-01..2026-06-30, lines unedited)
- `tests/fixtures/node-runtime/README.tcs-76.md` (new: table of the two new files, the confirmation that the December and June recordings are unchanged, and the correction of the README.tcs-69.md "no release under it" sentence as a fact of this session)
- `tests/ingest/node-runtime-posts-repro.tcs-76.test.ts` (new: the reproduction; imports only modules that exist at the merge base)
- `tests/ingest/node-runtime-posts-2025-2026.tcs-76.test.ts` (new: acceptance tests)
- `tests/ingest/node-runtime-ledger.tcs-69.test.ts` (TEST-CHANGE, see below)
- `tests/ingest/node-history.tcs-32.test.ts` (TEST-CHANGE, see below)
- `tests/ingest/node-runtime.tcs-30.test.ts` (TEST-CHANGE, see below)

## Tests that must change
- `tests/ingest/node-runtime-ledger.tcs-69.test.ts`: the case "coverage: the recorded June 2026 post is ok with unemitted 12 …" (line 447) uses the premise "the recorded June post has no affects line the parser reads". This ticket makes the parser read it (and with that test's dist index, which has no June versions, June is now an incomplete post, not ok). Change: keep the case's intent (an ok row with unemitted > 0 holds coverage back; a revision bump re-reads it and clears it). Write the June row's `unemitted = 12` in-test with an UPDATE after a read of a synthetic page, and move the recorded-June premise to the tcs-76 test, which pins its new outcome (12 advisories). Do not weaken any other assertion.
- `tests/ingest/node-history.tcs-32.test.ts`: line 103 pins the literal `parser_rev: "3"`. This ticket bumps the revision. Change the literal to `NODE_PARSER_REV` (import it). Line 104 (`"2"` on the not-yet-read row) stays.
- `tests/ingest/node-runtime.tcs-30.test.ts`: lines 330–331 pin the literal `parser_rev: "3"`. Change to `NODE_PARSER_REV`.

`tests/ingest/node-runtime-walk.tcs-69.test.ts` does NOT change: its dist index has no 2026-01-12 versions, so the recorded December post stays incomplete there ("… is not in the dist index"), and its March/June posts are synthetic. The build must run it and confirm it stays green unedited; if it does not, it is a defect of this build, not a test to edit.

## Changed symbols
- function `parseNodeSecurityPost`: adds (a) "Node.js X.Y.Z" without "v" in Downloads; (b) a second line extractor used only when AFFECTS finds no lines; (c) a per-CVE "already fixed on/in Node.js X.Y.Z" version; (d) the "Updates are now available for …" lines of the post as the lines of a CVE whose impact clause says "Node.js versions" and names no line. callers: `isNodePreAnnouncementParsed`, `normalizeNodePost`, `readOne` (all in node-runtime.ts), tests tcs-6/tcs-30/tcs-69; behavior for every input that parses today is unchanged.
- format `PostCve`: adds an optional `fixed?: Map<number, string>` (per-line fixed version named in the CVE's own section; it overrides the Downloads version for that line).
- function `normalizeNodePost`: uses `PostCve.fixed` before `ParsedPost.fixed` for a line; the dist-index check is unchanged.
- function `storeDocs` (internal): skips the upsert of a doc when the stored advisory of the same (node-runtime, CVE) key has a later `published_at` (a newer post owns it); counts it as unchanged and as emitted.
- function `NODE_PARSER_REV` (constant): "3" → "4".

## Tasks

### T1. Fixtures
Cut `tests/fixtures/node-runtime/2026-03-24.html` from `recordings/march-2026-security-releases.html` with the README.md rule (the one `<main …>…</main>` byte slice; 63,675 of 301,104 bytes per this session's measure). Cut `index-2025-12-to-2026-06.json` from `recordings/dist-index.json` with the index.json rule (one entry per line, keep lines whose `date` is 2025-12-01 through 2026-06-30, each line unedited, join back into a JSON array). If the build has egress, it may record again; it must then note the new recording sha256. Write `README.tcs-76.md` with URL, recorded-at (from `recordings/RECORDED_AT`), full-file sha256, slice sha256 and rule for each new file, and state that the December (8207c4fe…) and June (4a9c6443…) pages served today are byte-identical to the TCS-69 recordings. No byte of a fixture is written by hand.
VALIDATE: `sha256sum tests/fixtures/node-runtime/2026-03-24.html tests/fixtures/node-runtime/index-2025-12-to-2026-06.json` equals the values in README.tcs-76.md, and `node -e 'JSON.parse(require("fs").readFileSync("tests/fixtures/node-runtime/index-2025-12-to-2026-06.json","utf8"))'` exits 0.
SATISFIES: Scope 1 "Record the three real posts as fixtures (README with URL and sha256)".

### T2. Parser wordings (src/ingest/node-runtime.ts)
1. DOWNLOADS (line 125): `/Node\.js v?(\d+)\.(\d+)\.(\d+)\b/g`.
2. Second line extractor, called only when `AFFECTS.exec` gives no lines. Over `htmlText(s.body)`, for each match of `/\baffects?\b/gi`, take the clause from the match to the first of: "Thank you", a sentence end `\.\s+[A-Z]`, the next "affect" word, or the end of the text. No character cap (a cap would be a literal limit). Skip a clause that matches `/end-of-life|\bEOL\b/i`. Lines of a clause = the union of `\bv?(\d{1,2})\.x\b` and every number of `Node\.js\s+(\d{1,2}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)\d{1,2})*)(?![.\d])`. The first clause with at least one line wins.
3. Per-CVE fixed version: in the CVE's own section text, `/\bfixed\s+(?:on|in)\s+Node\.js\s+v?(\d+)\.(\d+)\.(\d+)\b/gi` gives `fixed.set(major, version)` (highest per major). Used only when steps AFFECTS and 2 gave no lines: then lines = the majors of those versions.
4. "Node.js versions" fallback: only when steps AFFECTS, 2 and 3 gave no lines AND a clause of step 2 matches `/\bNode\.js versions\b/i`: lines = the `(\d+)\.x` lines of the "Updates are now available for … release lines" sentence of the section whose heading matches `/security releases available/i`. If that section or sentence is absent: no lines (not emitted, as today).
Adversarial negatives (must give NO lines, each a test case): "This vulnerability affects all users in active release lines: none"; "This vulnerability affects all users"; "This vulnerability affects all End-of-Life release lines: 18.x"; "Present in active release lines: 24.x"; "This vulnerability is bad" in the July post (the tcs-30 summary case); "affects all Node.js versions" in a post with no "Security releases available" section; "fixed in undici 7.24.4". Near misses that must NOT add a line: "Node.js 24.12.0" (a version, not a line, unless step 3); "CVE-2026-21637 fix"; "HTTP/2"; "2³¹-1".
VALIDATE: `npx vitest run tests/ingest/node-runtime-posts-2025-2026.tcs-76.test.ts tests/ingest/node-runtime.tcs-30.test.ts tests/ingest/node-runtime.tcs-6.test.ts` exits 0.
SATISFIES: Scope 1 "extend the parser until each yields its full CVE list with per-line fixed versions: the 'Fixed in' wording variants, the release-line table shape, and the dist-index lookup".

### T3. Newer-post guard (storeDocs)
Before `upsertAdvisory`, read the stored doc with `UPSERT_SQL.findByPair` (exported, PK of advisory_sources then PK of advisories, 1 statement). If its `published_at` is later than the post's `published`, skip the write, count `unchanged`, count the doc as ok. This keeps the March "incomplete fix" versions of CVE-2026-21637 when December is read after March (a parser-bump walk spread over several runs, or a December retry).
VALIDATE: the tcs-76 test "CVE-2026-21637: March then December keeps fixed 20.20.2/22.22.2/24.14.1/25.8.2; December then March gives the same" passes: `npx vitest run tests/ingest/node-runtime-posts-2025-2026.tcs-76.test.ts -t 21637`.
SATISFIES: Scope 1 "each yields its full CVE list with per-line fixed versions" (December and March both emit CVE-2026-21637; the stored fixed versions must be the correct, newer ones) and repo iron rule 10.

### T4. Parser revision bump
`NODE_PARSER_REV = "4"`; extend the comment ("TCS-76: the December 2025, March and June 2026 wordings"). The existing `selectDue` (line 264) re-reads every feed row with another revision once; no change to the walk.
VALIDATE: tcs-76 test "rev bump: failed (December), empty-with-note, and ok-unemitted (March, June) rows at parser_rev 3 are each read once and become ok with unemitted 0" passes; `npx vitest run tests/ingest/node-history.tcs-32.test.ts tests/ingest/node-runtime-ledger.tcs-69.test.ts` exits 0.
SATISFIES: Scope 2 "A parser_revision bump re-reads every failed and empty-with-note post once".

### T5. Coverage and /v1/check through runIngesters
No code change. The test proves it (see Acceptance tests, A6).
VALIDATE: `npx vitest run tests/ingest/node-runtime-posts-2025-2026.tcs-76.test.ts -t coverage` exits 0.
SATISFIES: Scope 3 "coverage_since for node sets itself under the #69 rule" and acceptance "after the re-read, coverage_since is set and /v1/check?node=22.12.0 returns the December 2025 advisories".

### T6. Test changes of other tickets
Apply the three edits of "## Tests that must change".
VALIDATE: `npm test` exits 0 (unpiped exit code), and `npm run typecheck` exits 0.
SATISFIES: Scope 2 (the revision bump) without a weakened test.

## Reproduction
REPRO: `npx vitest run tests/ingest/node-runtime-posts-repro.tcs-76.test.ts` — the file imports only `normalizeNodePost` and the existing fixtures `2026-06-18.html` and `2026-01-13-incomplete.html`, plus a dist set built in-test from the versions the posts name (v22.23.0, v24.17.0, v26.3.1, v20.20.0, v22.22.0, v24.12.0, v24.13.0, v25.3.0; their presence in the 2026-10-22 dist recording is documented in README.tcs-76.md). It asserts June gives 12 docs and December gives 8 docs, `incomplete: false`. At the merge base June gives 0 docs (notEmitted 12) and December is `incomplete: true` ("no fixed version for 20.x; …"), so it fails.
OBSERVED: June 2026: 0 advisories, 12 not emitted. December 2025: incomplete, 0 advisories, failed row with backoff. March 2026: 1 advisory, 8 not emitted. The coverage hold (TCS-69) keeps node partial; the 28 CVEs are missing from the feed.
EXPECTED: June 12 advisories (lines 22/24/26 fixed 22.23.0/24.17.0/26.3.1, CVE-2026-48937 on 22/24 only, CVE-2026-48936 on 26 only); December 8 advisories (lines 20/22/24/25 fixed 20.20.0/22.22.0/24.13.0/25.3.0; CVE-2025-59464 on 24 only, fixed 24.12.0; CVE-2026-21636 on 25 only); March 9 advisories (fixed 20.20.2/22.22.2/24.14.1/25.8.2).
ROOT CAUSE: src/ingest/node-runtime.ts:125 (the Downloads regex requires "v", so December has no fixed version) and src/ingest/node-runtime.ts:94 with :120 (AFFECTS knows only three wordings, so the March and June "affects" clauses and the December "users of … on Node.js" clauses give no lines, and :164 drops the CVE).
BLAST RADIUS: `parseNodeSecurityPost` callers: `isNodePreAnnouncementParsed` (pre-announcement test, node-runtime.ts:144), `normalizeNodePost` (:153), `readOne` (:374); `normalizeNodePost` caller: `normalize` (:334). No caller outside src/ingest/node-runtime.ts (grep of src/, site/, packages/). Test dependents: tcs-6, tcs-30 (July/October fixtures and AFFECTS tables), tcs-32 history, tcs-69 ledger/walk/repro, launch-node-ledger.tcs-69. The /v1/check node lookup reads the stored advisories (src/routes/check.ts), not the parser.

## ASSUMPTIONS
- The ticket's "March 2026 yields 8": I read it as the 8 CVEs that are missing today. The post has 9 rated headings and CVE-2026-21711 is emitted today, so the test asserts 9 advisories that include the 8 missing ones. Other reading: exactly 8 docs, which would require dropping one real CVE.
- The ticket's "December 2025 … fixed versions for 20.x, 22.x and 24.x": the post also names 25.3.0 for 25.x and three CVEs affect 25.x, so the docs carry 25.x too (a superset). Other reading: drop 25.x, which would hide a real affected line.
- "dist-index lookup for lines whose fixed version appears only in the dist index": no line in the three posts lacks a fixed version in the post itself (CVE-2025-59464's 24.12.0 is in its own section, not in Downloads). I read the item as "a fixed version the post names outside Downloads is confirmed by the dist index", which the existing check does. I do NOT add a date-based guess of a fixed version from the dist index (that would publish a version no source states, repo iron rule 10). Other reading: pick the dist release nearest the post date for a line with no named version.
- "release-line table shape": the posts have no `<table>`; I read it as the "Node.js 22 , Node.js 24 , and Node.js 26" list. Other reading: an HTML table parser with no real input to test it on.
- CVE-2026-21637 in December ("across Node.js versions"): lines = the lines the post's own "Updates are now available for …" sentence names (20/22/24/25). The March "incomplete fix" post names the same four lines. Other reading: leave it not emitted; then December keeps unemitted 1 and coverage_since never sets, which fails the ticket's acceptance.
- Scope 2 "re-reads every failed and empty-with-note post once": the existing walk re-reads EVERY row of another revision once (48 posts, 20 per run, about 3 runs). That is a superset and it also re-reads the March and June rows, which are `ok` with unemitted > 0 (not failed, not empty) and must be re-read. Other reading: narrow the bump to failed/empty-with-note rows, which would miss March and June.
- The parser change is additive (new wordings apply only where today's regexes find no lines), so a post that reads in full today reads the same. Other reading: one rewritten extractor, which risks the July/October results.

## System invariants
(a) Cross-run state: the ledger `node_runtime_posts` (url PK) and `advisory_sources` (source, source_id PK) stay the only stores. No new table, no KV key, no migration. The revision is the constant `NODE_PARSER_REV` (parser identity, not a knob).
(b) Side effects: the only external calls are nodejs.org GETs (not metered). The advisory write happens before the ledger row (existing order in `storeDocs`); the T3 guard skips only the advisory write, never the ledger row, so a post cannot be stamped ok with a doc lost by error: a skipped doc is one a newer post already stored.
(c) Adversarial negatives: the list in T2 (7 inputs and 4 near misses), each an `it.each` case in the tcs-76 test; plus the July and October fixtures give exactly their current docs (deep-equal on cve, affected, fixed_versions).
(d) Neighbors: the bump makes the next ~3 hourly cron runs read up to `max_posts` (20, a DB knob) posts each, which TCS-32 already did at rev "3"; `result.deferred` keeps the rest due. The coverage hold (`hasUnreadRecent`) is not changed. The dist-index KV cache is not changed. No other ingester reads `parseNodeSecurityPost`. `upsertAdvisory` (shared) is not changed; T3 only adds one PK read before it in node-runtime.

## Performance
Cron path only, no screen. Per emitted doc: +1 statement (the T3 PK read: advisory_sources PK, advisories PK). Per post: unchanged otherwise. No new query on a new table, so no new EXPLAIN proof; the read is `UPSERT_SQL.findByPair`, already indexed by both primary keys.

## Iron laws
DB-driven config: no new limit; max_posts/backfill_days/retry knobs unchanged. Additive schema: no migration. Idempotent ingestion on (source, source_id): unchanged, second run `unchanged` (A5). Advisory text is a fact from a source with a link: every line and version comes from the post text; the dist index only confirms. Dedup before spend: no metered call. Sortable headers, list-over-cards, drill-down, RLS, De-AI: n/a (no UI, no LLM, D1 not Supabase). Retention: no new table.
Build-discipline rules that bite: D1 (mutation-check: drop each new wording and see a case go red), D2 (A6 goes through `runIngesters` and the `/v1/check` route), D4 (recorded fixtures, not invented pages, for the three posts), D6 (unpiped exit codes), D12/D13 (coverage never set while a recent post is unread), D25 (only node-runtime.ts in src), D26 (fixture bytes from the recordings only).

## Entry points
no user-facing entry point (an ingester change; the existing /v1/check and feed read the stored advisories).

## Requirements coverage
| Requirement (ticket line) | Task | Test |
|---|---|---|
| Record the three posts as fixtures, README with URL and sha256 | T1 | A1 (fixture sha check) |
| December yields its CVEs with fixed versions for 20.x, 22.x, 24.x | T2 | A2 |
| March yields 8 (the missing ones) | T2 | A3 |
| June yields 12 | T2 | A4 |
| "Fixed in" wording variants | T2.3 | A2 (CVE-2025-59464 → 24.12.0) |
| release-line table shape | T2.2 | A4 |
| dist-index lookup | T2 (existing check) | A2/A3/A4 run against the recorded dist slice; A7 a version absent from the slice is incomplete |
| October fixture still yields 10 | T2 (additive) | A5 |
| second run is `unchanged` | existing upsert | A5 |
| parser_revision bump re-reads failed and empty-with-note posts once | T4 | A6 |
| coverage_since set after the re-read | T5 | A6 |
| /v1/check?node=22.12.0 returns the December advisories | T5 | A6 |
| Out of scope: pre-2023 posts with no CVE id stay terminal empty | no task (negative) | A8 |
| Lior 6365996503: land before 2027-01-13 | whole plan | n/a (date) |
| No regression of July/older wordings, no false lines | T2 additive | A9 negatives, tcs-30 suite |

## Acceptance tests
File `tests/ingest/node-runtime-posts-2025-2026.tcs-76.test.ts` (vitest, workers pool; fetch through `createRuntimeFake`, a `globalThis.fetch` spy that throws on any real call):
- A1: the two new fixture files parse (HTML has 9 rated CVE headings; JSON is an array that contains v20.20.0, v24.12.0, v25.8.2, v26.3.1).
- A2: December (`2026-01-13-incomplete.html`) with the dist slice: `incomplete false`, 8 docs; CVE-2025-55131 affected `[20.0.0→20.20.0, 22.0.0→22.22.0, 24.0.0→24.13.0, 25.0.0→25.3.0]`; CVE-2025-59464 only `24.0.0→24.12.0`; CVE-2026-21636 only 25.x; CVE-2026-21637 on 20/22/24/25; notEmitted 0.
- A3: March (`2026-03-24.html`): 9 docs; the 8 CVEs that were not emitted at the merge base are present; CVE-2026-21714 ("Node.js 20, 22, 24 and 25") on 4 lines; CVE-2026-21712 on 24/25; fixed 20.20.2/22.22.2/24.14.1/25.8.2; notEmitted 0.
- A4: June (`2026-06-18.html`): 12 docs; CVE-2026-48937 on 22/24; CVE-2026-48936 on 26; others 22/24/26; notEmitted 0.
- A5: October (`2026-10-21.tcs-69.html`) still 10 docs and July (`2026-07-29.html`) the same docs as the tcs-30 JULY_CVES table; through `nodeRuntime.run` twice: the second run gives `upserted 0` and every doc `unchanged`.
- A6 (through `runIngesters`, the D2 entry point): seed the ledger for every feed post at parser_rev "3": December `failed` (attempts 1, next_check_at in the future), an empty-with-note row, March and June `ok` with unemitted 8 and 12, others `ok`; feed = recorded `vulnerability.xml`; December/March/June/July/October answer their recorded pages, others synthetic; dist = slice + index-since-2026-07 + node-eol index. Run until `deferred` is 0 (≤ 3 runs). Assert each row was fetched exactly once in the walk, every row is `parser_rev "4"`, December/March/June `ok` with unemitted 0, `sources.coverage_since` not null, and `GET /v1/check?node=22.12.0` lists CVE-2025-55131 (and the other December CVEs on 22.x) and reports node coverage as complete.
- A7: December against a dist set without v24.12.0: incomplete with "24.12.0 is not in the dist index" (the dist check still applies to a section-named version).
- A8: the 2019 no-updates post stays `empty` with no note after the bump (out-of-scope pin).
- A9: `it.each` over the T2 negatives and near misses: no lines.
- 21637 case: read March then December → stored fixed versions are March's; December then March → the same; outcome counts `unchanged` for the skipped write.
File `tests/ingest/node-runtime-posts-repro.tcs-76.test.ts`: the REPRO above.

Suites at regression risk: tests/ingest/node-runtime.tcs-6.test.ts, node-runtime.tcs-30.test.ts, node-runtime-repro.tcs-30.test.ts, node-history.tcs-32.test.ts, node-runtime-ledger.tcs-69.test.ts, node-runtime-walk.tcs-69.test.ts, node-runtime-ledger-repro.tcs-69.test.ts, tests/launch/launch-node-ledger.tcs-69.test.ts, tests/routes/check.tcs-9.test.ts.

## Verify (run, not edited)
- `npm test`
- `npm run typecheck`
- `tests/ingest/node-runtime-walk.tcs-69.test.ts` (must stay green unedited)

## QA screens
None in a browser. After deploy, a probe: `curl -s 'https://tocsin.sh/v1/check?node=22.12.0'` lists CVE-2025-55131 once the ~3 cron runs after deploy have walked the ledger (not verifiable from this box before merge).

## Sibling claims (not touched)
TCS-38 holds OSV/check/parsers/landing files. This plan edits none of them; the only src file is src/ingest/node-runtime.ts.

```pr-body-requires
TEST-CHANGE: `tests/ingest/node-runtime-ledger.tcs-69.test.ts` <- Tests that must change
TEST-CHANGE: `tests/ingest/node-history.tcs-32.test.ts` <- Tests that must change
TEST-CHANGE: `tests/ingest/node-runtime.tcs-30.test.ts` <- Tests that must change
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Design collision check (BH-5791)

Checked 5 listed and 0 derived symbols against main 5f7e4bffa6e4..5f7e4bffa6e4 and 3 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 1
LINES: 110
DIFF_KB: 140

KIND: bug
SIZE: M
