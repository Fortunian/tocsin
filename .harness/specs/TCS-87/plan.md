# Plan: TCS-87 — llms.txt still offers dpkg -l; document the 200-property POM cap

## Scope
The ticket asks for two things:
1. `src/routes/discovery.ts:74` (llms.txt) offers "dpkg -l or dpkg-query" as the Debian input. Since #38, every `dpkg -l` row is skipped as `binary_package_name`. llms.txt must offer only `apk list --installed` and the `dpkg-query -W -f='${source:Package} ${Version}\n'` form.
2. docs/API.md must state that a POM past 200 property expansions has the rest skipped as `unresolved_property`.

Part 2 is ALREADY ON MAIN. Commit d5b6d96 (TCS-38, 2026-10-23 20:42:17Z) added this sentence at docs/API.md:57: "A `${property}` value that resolves to more than 256 characters, or a file that needs more than 200 property expansions, is in `skipped` with the reason `unresolved_property`." The ticket was filed 4 seconds later (20:42:21Z), from the pre-merge round. This plan does not touch docs/API.md. It builds only part 1.

`git log origin/main --since=2026-10-23T20:42:21Z`: no commits. Part 1 is not on main (`grep -n "dpkg -l" src/routes/discovery.ts` → line 74).

#38 (the Blocked-by) is CLOSED.

## Spec changes from comments
none

## ASSUMPTIONS
- The docs part: docs/API.md:57 already states the 200-expansion cap (d5b6d96). I assume that sentence satisfies the ticket and leave docs/API.md alone. Other reading: rephrase it to say "the dependencies after the 200th expansion". I did not, because the current text is accurate, and a sibling build (TCS-82) holds docs/API.md.
- "CHANGELOG/release notes": the repo has no CHANGELOG file (`ls` at the root shows none). I assume the release note is the PR body, and I do not create a CHANGELOG. Other reading: create CHANGELOG.md. That adds a new convention the repo never agreed to.
- `src/routes/check.ts:174` (a comment) and `src/routes/check.ts:188` (a 400 error string) also name `dpkg -l`. The ticket scopes the fix to discovery.ts and llms.txt. The 400 string is correct in a narrow sense: the parser does accept `dpkg -l` text (it reads it and skips each row). I leave check.ts alone. Other reading: also change the 400 message to name only `dpkg-query -W`. That touches a validated error contract with its own tests.
- The new llms.txt text keeps the reader's path: it states the `dpkg-query` form and does not mention `dpkg -l` at all, because the acceptance test says "llms.txt no longer contains dpkg -l".

## Files to touch
- `src/routes/discovery.ts` (edit line 73-74 of the LLMS_TXT template)
- `tests/routes/discovery.tcs-87.test.ts` (new)

## Verify (run, not edited)
- `tests/routes/discovery.tcs-12.test.ts`, `tests/routes/discovery.tcs-3.test.ts` (other llms.txt pins; they assert the MCP section and `order=desc`, not the dpkg line)
- `npm run typecheck`, `npm test`

## Tests that must change
None

## Changed symbols
- format `LLMS_TXT` (llms.txt body in src/routes/discovery.ts): the OS package line lists `apk list --installed` or the `dpkg-query -W` form only; `dpkg -l` is removed.

## Sibling claims (not touched)
TCS-82 holds docs/API.md and others. This plan does not edit docs/API.md (part 2 is already on main), so there is no overlap.

## Tasks

### T1: Remove `dpkg -l` from llms.txt
Edit `src/routes/discovery.ts:73-74` to:
```
An OS package list (Alpine or Debian): the release plus the list text, from apk list --installed
(Alpine) or dpkg-query -W -f='\${source:Package} \${Version}\\n' (Debian, source package names):
```
Keep the escapes exactly as the existing template has them, so the rendered text keeps `${source:Package}` and `\n` literal. The curl example on the next line does not change.
VALIDATE: `npm test -- tests/routes/discovery.tcs-87.test.ts` passes, and `grep -c "dpkg -l" src/routes/discovery.ts` prints 0.
SATISFIES: "Test: llms.txt no longer contains \"dpkg -l\"" and "One-line fix in discovery.ts".

### T2: Acceptance test
New file `tests/routes/discovery.tcs-87.test.ts`, using `get` from `./seed.tcs-3` like discovery.tcs-12:
- GET `/llms.txt` → 200; text does not contain `dpkg -l`.
- text contains `dpkg-query -W -f='${source:Package} ${Version}\n'` (the rendered literal) and `apk list --installed`.
It fails before T1 (line 74 contains `dpkg -l`) and passes after.
VALIDATE: `npm test -- tests/routes/discovery.tcs-87.test.ts` fails on the `dpkg -l` assertion before T1 and passes after T1.
SATISFIES: "Test: llms.txt no longer contains \"dpkg -l\"".

## Iron laws
No schema, no table, no knob, no metered call, no UI table, no LLM text. The 200 cap (`MAX_EXPANSIONS` in src/check/parsers/pom-xml.ts) is not changed here. Build-discipline rules that bite: surgical change (only the template line), per-ticket test file, and an honest PR body that says part 2 was already on main by d5b6d96.

## Performance
No loader or screen change. llms.txt is a static string; no reads.

## Entry points
no user-facing entry point (a static text file read by agents at /llms.txt; no nav, picker or builder involved).

## System invariants
None beyond the iron laws: this is a one-line edit of a static text template with no state, no side effect and no matcher.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| llms.txt no longer offers `dpkg -l` (negative) | T1 | discovery.tcs-87: text not containing `dpkg -l` |
| llms.txt still gives a working Debian input | T1 | discovery.tcs-87: contains the `dpkg-query -W` form |
| docs/API.md states the 200-property POM cap as `unresolved_property` | already on main, d5b6d96 (docs/API.md:57) | none new; `grep -n "200 property expansions" docs/API.md` |
| CHANGELOG/release note | PR body (no CHANGELOG in repo; see ASSUMPTIONS) | n/a |

```pr-body-requires
## ASSUMPTIONS <- ASSUMPTIONS section
d5b6d96 <- ticket part 2 (POM cap) already on main
```

## Acceptance tests
- `tests/routes/discovery.tcs-87.test.ts`:
  - `GET /llms.txt` status 200, `text` not.toContain(`dpkg -l`).
  - `text` toContain(`dpkg-query -W -f='${source:Package} ${Version}\n'`) and toContain(`apk list --installed`).
- Regression risk: `tests/routes/discovery.tcs-12.test.ts`, `tests/routes/discovery.tcs-3.test.ts`, `tests/routes/site.tcs-10.test.ts` (other `/llms.txt` readers). None pins the dpkg line.

## QA screens
- https://tocsin.sh/llms.txt: the "Check your dependencies" section names `apk list --installed` and the `dpkg-query -W` form, and no `dpkg -l`.

## Design collision check (BH-5791)

Checked 1 listed and 0 derived symbols against main d5b6d96ed9bc..d5b6d96ed9bc and 1 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 1
LINES: 4
DIFF_KB: 2

KIND: copy
SIZE: S
