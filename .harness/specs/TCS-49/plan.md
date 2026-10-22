# TCS-49 plan: Action own-comment identity for GitHub App tokens, full href encoding

Ticket: Fortunian/tocsin#49. Blocked-by #33 is CLOSED (merged as fa79408). Thread has 0 comments; the issue body is the spec.

## Already on main?
No. `git log origin/main --since=2026-10-22T21:37:33Z` shows a627f29, 7d04d9a, b015b70 (none touch `action/check.mjs`'s identity code). `git log origin/main -S"tocsin-check by:"` finds nothing. No PR for TCS-49 exists (`gh pr list --search TCS-49` returns only unrelated #26, #23).

## Spec changes from comments
none

## Scope
1. When `GET /user` fails, the Action learns its identity from its own comments:
   - It adopts an existing comment whose marker line names the comment's own author (`<!-- tocsin-check by:<login> -->`, author `user.login === <login>`, `user.type === "Bot"`).
   - If none exists and the run is not clean, it POSTs, reads `user.login` from the POST response and PATCHes that new comment once so the marker carries the login.
   - Later runs match that comment without `GET /user`.
2. The rule stays: the Action never edits a comment whose author is not the identity it matched (the `GET /user` login, or the login in the comment's own marker).
3. `advisoryHref` percent-encodes (UTF-8) every character outside the unreserved set `A-Z a-z 0-9 - . _ ~` and `/ : ? = & % #`.

## Design (all in `action/check.mjs`)
- New `markerFor(login)`: returns the bare `MARKER` (`<!-- tocsin-check -->`) when `login` is null or `github-actions[bot]`; else `<!-- tocsin-check by:<login> -->`. The default bot keeps the bare v1.0.0 marker, so default-token comments already on PRs and the tcs-33 tests stay valid.
- New `parseMarker(body)`: anchored on the FIRST line, regex `^<!-- tocsin-check(?: by:([A-Za-z0-9-]+(?:\[bot\])?))? -->(?:\n|$)`. Returns `{ by: string | null }` or null when the body has no marker. (Today `includes(MARKER)` matches anywhere; every comment the Action writes starts with the marker, so anchoring only drops comments the Action never wrote.)
- `viewer()` returns `{ login: string } | null` (null when `GET /user` fails or has no login). The `bot` flag goes away; its job moves into the match rule below.
- `findMarkerComment()` returns `{ id, login } | null`. A comment `c` with marker `m` is ours when:
  - viewer known (login L): `c.user.login === L` AND (`m.by === null` OR `m.by === L`). If L is `github-actions[bot]`, also `c.user.type === "Bot"` (unchanged rule).
  - viewer unknown: `c.user.type === "Bot"` AND (`m.by === c.user.login` OR (`m.by === null` AND `c.user.login === "github-actions[bot]"`)).
  - First match in list order (oldest first), same paging cap `COMMENT_PAGES`.
- `upsertComment()`:
  - match found: PATCH it with `markerFor(match.login)` + markdown.
  - no match, clean: nothing (unchanged).
  - no match, not clean: POST with `markerFor(viewer?.login ?? null)`. If viewer was unknown, read the POST response `user.login`. If it passes the login regex and is not `github-actions[bot]`, PATCH that comment id with `markerFor(login)`. If the login is missing or invalid, annotate a warning ("posted the PR comment, but GitHub returned no author login; the next run will post a new one") and do not PATCH. If that PATCH throws, annotate a warning that names it ("posted the PR comment but could not tag its owner: ...") instead of the generic "could not post" message (D13: the comment WAS posted).
- `advisoryHref(url)` (now exported for a unit table): guard becomes `/^https?:\/\//.test(url)` (a space or quote inside is encoded, not rejected, per acceptance test 2); body is `url.replace(/[^A-Za-z0-9\-._~\/:?=&%#]/gu, c => utf8 bytes as %XX uppercase)`.

## Files to touch
- `action/check.mjs` (edit: `viewer`, `findMarkerComment`, `upsertComment`, `advisoryHref`, new `markerFor`, `parseMarker`)
- `tests/action/identity.tcs-49.test.ts` (new)
- `tests/action/advisory-href.tcs-49.test.ts` (new)

## Tests that must change
None. Checked against the tcs-33 premises:
- `tests/action/check.tcs-33.test.ts:58,129` assert `toContain(MARKER)` on default-bot comments: `markerFor("github-actions[bot]")` stays the bare MARKER.
- `tests/action/security.tcs-33.test.ts:90-100` expects writes `["POST"]` with viewer null: the fake POST answers author `github-actions[bot]`, so no tagging PATCH runs.
- `tests/action/security.tcs-33.test.ts:83` expects `%7Cb`: still true.

## Changed symbols
- function `viewer`: returns `{ login } | null` instead of a `{ login, bot }` fallback to github-actions[bot]. callers: only `findMarkerComment`/`upsertComment` in the same file.
- function `findMarkerComment`: new match rule (by-marker), returns `{ id, login } | null`.
- function `upsertComment`: tags the first POST with the returned login when `GET /user` failed.
- function `advisoryHref`: encodes every char outside unreserved + `/:?=&%#`; accepts whitespace inside the url; now exported.
- function `markerFor` (new), function `parseMarker` (new).
- format `PR comment marker line`: adds `<!-- tocsin-check by:<login> -->`; the bare `<!-- tocsin-check -->` stays for github-actions[bot].

## Tasks

### T1. Identity from the Action's own comment
Edit `viewer`, `findMarkerComment`, `upsertComment`; add `markerFor`, `parseMarker` as in Design.
VALIDATE: npx vitest run --project action tests/action/identity.tcs-49.test.ts
SATISFIES: "When GET /user fails, take the identity from the first comment the Action itself posts (the user.login in the POST response) and store it in the marker (`<!-- tocsin-check by:<login> -->`), so later runs match their own comment without GET /user."

### T2. Keep the never-edit-a-foreign-comment rule
Covered by the match rule in T1; pinned by negative cases in the T1 test file and by the unchanged tcs-33 security suite.
VALIDATE: npx vitest run --project action tests/action/identity.tcs-49.test.ts tests/action/security.tcs-33.test.ts
SATISFIES: "Keep the rule: never edit a comment whose author is not that identity."

### T3. Full percent-encoding in advisoryHref
VALIDATE: npx vitest run --project action tests/action/advisory-href.tcs-49.test.ts
SATISFIES: "`advisoryHref` percent-encodes every character outside the unreserved set and `/:?=&%#`" and "A url with `|`, a space and a quote renders as one table cell with a working percent-encoded link."

### T4. Whole action suite and typecheck stay green
VALIDATE: npm test && npm run typecheck
SATISFIES: Verification contract in CLAUDE.md ("A ticket is done when its acceptance tests fail before the change and pass after it").

## Verify (run, not edited)
- `npm test` (all suites; the `action` vitest project is the one at risk)
- `npm run typecheck` (includes `tsc --noEmit -p action`, which checks the JSDoc types in check.mjs)
- `tests/action/check.tcs-33.test.ts`, `tests/action/security.tcs-33.test.ts`, `tests/action/action-yml.tcs-33.test.ts`, `tests/action/lockfiles.tcs-33.test.ts`

## Edge cases
- POST response with no `user` or a login that fails `^[A-Za-z0-9-]+(\[bot\])?$` (e.g. contains `-->`): no tag PATCH, warning annotation. The login is never written into the HTML comment unvalidated.
- Tagging PATCH fails (e.g. 403): warning that says the comment was posted; exit code unchanged (comment errors never change the exit code today).
- A clean first run with an App token: nothing is posted (unchanged: a clean run only updates).
- A Bot comment with `by:tocsin-app[bot]` authored by `other-app[bot]`: ignored (by != author).
- A User comment `<!-- tocsin-check by:mallory -->` authored by `mallory`: ignored when viewer unknown (type must be Bot). With a known viewer `mallory`... only if the token IS mallory, which is the existing rule.
- A marker that is not on the first line (quoted in a reply): ignored.
- `advisoryHref`: non-ASCII `é` -> `%C3%A9`; an existing `%41` stays; `?a=1&b=2#f` stays; `+`, `,`, `;`, `@`, `!`, `$`, `*`, `'`, `(`, `)` are encoded; `javascript:` and `ftp://` still return null.

## Iron laws
- Sortable headers, list-over-cards, drill-down, mobile: n/a (no app UI; the PR comment table is unchanged in shape).
- DB-driven config / hardcoded-knob: no new limit, rate, threshold or timeout. The login regex and the encode set are format rules, not knobs. `COMMENT_PAGES` is unchanged.
- RLS, indexes, EXPLAIN, retention: n/a (no table, no query, no migration).
- De-AI: n/a (no LLM call). Warning text is plain STE.
- Dedup before spend: n/a (no metered call; GitHub API calls are +1 PATCH on the first App-token run only).
- Model ids: none.
- Scalable tests: the tests use the existing fake world in `tests/action/helpers.tcs-33.ts` (fetch throws on any unrouted URL), 0 network calls, each test builds its own temp world. No vendor seam changes.
- Build discipline rules that bite: D1 (mutation: drop the tag PATCH -> second-run test goes red; drop the `by === author` check -> foreign-comment test goes red; drop a char from the encode set -> href table goes red), D2 (tests go through `run()`), D9/D13 (warning copy true when the comment was posted but not tagged), D17 (login compared exactly, GitHub logins are case-insensitive but the API returns one canonical case; we compare the API's own strings on both sides), D25 (surgical: only check.mjs).

## Performance
No screen or loader. Request count per run: unchanged for user tokens and the default token; +1 PATCH on the first posting run with an App token; later App-token runs use the same GET /user + list + PATCH as today.

## ASSUMPTIONS
- The marker for `github-actions[bot]` stays the bare `<!-- tocsin-check -->` (no `by:`). Reason: v1.0.0 comments on open PRs keep matching, and no tcs-33 test changes. Other reading: write `by:github-actions[bot]` too; that would need a migration rule for old comments and changes two tcs-33 assertions.
- The tag is added by a second call (PATCH) right after the first POST, because the login is only known from the POST response. Other reading: none possible without `GET /user`; GitHub App installation tokens cannot call `GET /app`.
- With an unknown viewer, if two Bot identities each have a Tocsin comment on the same PR (for example a default-token workflow and an App-token workflow), the Action adopts the oldest one. It cannot tell which Bot it is without `GET /user`. The author still equals the marker's login, so the rule in scope item 2 holds. Other reading: refuse to edit and post a new comment; that brings back the duplicate-comment bug for the common case.
- The marker is matched on the first line only, not anywhere in the body. Every comment the Action writes starts with it.
- A url with whitespace is now encoded and linked instead of shown as plain text, because acceptance test 2 asks for a working link with a space in it.

## System invariants
None beyond the iron laws. One file, no stored state: the comment marker is the only cross-run state, and its writer (`upsertComment` via `markerFor`) and reader (`parseMarker`) live in one file and round-trip in the identity test. Side-effect order: POST first, then the tag PATCH; a failed PATCH leaves a posted comment and a true warning, never a claim that nothing was posted. Adversarial negatives (must NOT be edited): a User comment with a valid by-marker naming itself; a Bot comment whose by-login is another Bot; a `github-actions[bot]` login with type User; a marker on line 2; a bare marker by a non-default Bot when the viewer is unknown.

## Requirements coverage
| Requirement (ticket) | Task | Test |
| --- | --- | --- |
| GET /user fails -> take identity from POST response, store in marker | T1 | identity.tcs-49: "app token, no prior comment: first run POSTs, then tags marker with returned login" |
| Later runs match own comment without GET /user | T1 | identity.tcs-49: "second run PATCHes that comment and POSTs nothing" |
| Never edit a comment not by that identity (negative) | T2 | identity.tcs-49: "foreign comment with the same marker text but another author is ignored" (User author and other-Bot author); security.tcs-33 marker ownership suite unchanged |
| advisoryHref encodes all outside unreserved + `/:?=&%#` | T3 | advisory-href.tcs-49: decision table |
| url with `\|`, space, quote -> one cell, working link | T3 | advisory-href.tcs-49: run() row has 9 split parts and `%7C`, `%20`, `%22` |
| Out of scope: reactions, check-run annotations | none | no code added for them |

## Acceptance tests
`tests/action/identity.tcs-49.test.ts` (vitest project `action`; uses `world()` from `helpers.tcs-33.ts`, wraps `w.fetch` so a POSTed comment's author is `{ login: "tocsin-app[bot]", type: "Bot" }`; `w.viewer = null` so GET /user is 403):
1. First run, DIRTY, no prior comment: GitHub writes are exactly `POST .../issues/42/comments` then `PATCH .../issues/comments/<new id>`; the stored comment's first line is `<!-- tocsin-check by:tocsin-app[bot] -->`.
2. Second run on the same world: writes are exactly one `PATCH .../comments/<same id>`; 0 POSTs; comment count unchanged; body shows the new run's data.
3. Foreign comments: a User `mallory` comment `<!-- tocsin-check by:mallory -->` and a Bot `other-app[bot]` comment `<!-- tocsin-check by:tocsin-app[bot] -->` exist; the run POSTs its own, never PATCHes ids of the foreign ones, and their bodies are byte-identical after.
4. Marker on line 2 of a `tocsin-app[bot]` comment: not adopted.
5. POST response without `user.login`: no tag PATCH, one warning naming it, exit code same as without comment.
6. Tag PATCH answers 403: warning says the comment was posted; comment exists with the bare marker.
7. Known viewer `tocsin-bot` (User): POST body first line is `<!-- tocsin-check by:tocsin-bot -->`, and no tag PATCH.
8. Default token (fake POST author github-actions[bot]): one POST, no PATCH, first line is the bare MARKER (pins the back-compat assumption).

`tests/action/advisory-href.tcs-49.test.ts`:
1. Table on exported `advisoryHref`: `https://e.example/a|b c"d` -> `https://e.example/a%7Cb%20c%22d`; `https://e.example/x?a=1&b=2#f` unchanged; `https://e.example/%41` unchanged; `https://e.example/é` -> `https://e.example/%C3%A9`; `https://e.example/(a)[b]<c>'d'*!$,;@+` -> each char encoded; `javascript:alert(1)` -> null; `ftp://x` -> null; `""`/undefined -> null.
2. Through `run()`: an affected row with url `https://e.example/a|b c"d`; in both the comment and the summary the row splits on unescaped `|` into 9 parts and contains `(https://e.example/a%7Cb%20c%22d)`.

Fail-before proof: tests 1-2, 3 (other-app case), 5, 6, 7 of identity and both href tests fail on main (main never PATCHes after POST, never writes `by:`, and rejects the space url).

## QA screens
None in a browser. The Action runs in GitHub Actions; this repo runs it on its own PRs (b015b70). After merge, the next PR's Tocsin comment shows the marker; [NOTE] not verified here: a real GitHub App token run.

## Sibling claims (not touched)
TCS-28 and TCS-29 claim CLI, docs, README and php-runtime files. This plan touches none of them; README is left alone on purpose.

## Design collision check (BH-5791)

Checked 6 listed and 0 derived symbols against main a627f293b6a2..a627f293b6a2 and 1 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 1
LINES: 80
DIFF_KB: 14

## Reproduction
REPRO: npx vitest run --project action tests/action/identity.tcs-49.test.ts
OBSERVED: with GET /user -> 403 and an App-token author `tocsin-app[bot]`, every run POSTs a new comment; the second run's writes are `["POST"]` and the PR holds 2 Tocsin comments. A url with a space renders as plain text, not a link.
EXPECTED: the second run PATCHes the first comment and POSTs nothing; the space url is a percent-encoded link.
ROOT CAUSE: action/check.mjs:369 (`viewer()` falls back to `github-actions[bot]`, so `ours()` at action/check.mjs:380 never matches a `<app>[bot]` author) and action/check.mjs:272-273 (`advisoryHref` rejects whitespace and encodes a fixed char list).
BLAST RADIUS: `upsertComment` <- `finish` <- `check` <- `run` (the only entry point, called from the script guard at action/check.mjs:505); `advisoryHref` <- `row` <- `report`, which feeds both the job summary and the PR comment. No other module imports these (grep: only tests/action/*.tcs-33 import check.mjs).

KIND: bug
SIZE: S
