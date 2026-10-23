# TCS-28 plan: skills for Codex and Cursor, Claude Code SessionStart hook, AGENTS.md block

Ticket: Fortunian/tocsin#28. Blocked-by #13 is CLOSED. The thread has 0 comments, so the issue body is the spec.

Base: origin/main 3bf40e1 (TCS-36). The worktree is at e223873, one commit behind. TCS-36 changed
`packages/cli/src/connect.ts`, `packages/cli/src/mcp-config.ts`, `site/docs.ts` and `README.md`.
The build MUST rebase on origin/main before it edits (`git rebase origin/main`).

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-22T19:17:19Z -- packages/cli skills scripts .github/workflows/ci.yml package.json docs/API.md README.md`
shows only TCS-36 (MCP registry and install links) and older work. No commit adds a Codex skill,
a Cursor rule, a hook or `gen:skills` (`git log origin/main -S"gen:skills"` is empty).

CodeGraph: NOT AVAILABLE on this box. Files and callers come from grep and reads.
Verification map: absent in this repo.

## Spec changes from comments

none

## Scope

The CLI verb `tocsin connect` (packages/cli) gets four additions. The skill text gets one generator.

1. Codex skill target: `~/.codex/skills/tocsin/SKILL.md`, flag `--codex`, detected when `~/.codex` exists.
2. Cursor rule target: `~/.cursor/rules/tocsin.mdc`, flag `--cursor`, detected when `~/.cursor` exists.
3. Claude Code SessionStart hook in `~/.claude/settings.json`, only with `--hook`.
4. `connect --print-agents-md`: prints a 6-line block, writes nothing.
5. `scripts/gen-skills.mjs` + `npm run gen:skills [-- --check]`: generates the Cursor rule and the Codex copy from `skills/tocsin/SKILL.md`. CI runs `--check`.
6. Docs: `docs/API.md` (regenerated into `site/docs.generated.ts`), `README.md`, `packages/cli/README.md` gain a "Codex" section.

## Design

### Generated skill files (T1)
- Source of truth: `skills/tocsin/SKILL.md` (unchanged).
- `scripts/gen-skills.mjs` writes two files:
  - `skills/codex/tocsin/SKILL.md`: byte-identical copy of the source.
  - `skills/cursor/tocsin.mdc`: frontmatter `---\ndescription: <the source frontmatter description>\nalwaysApply: false\n---\n` + the source body (everything after the source frontmatter).
- `--check`: exit 1 with `<path> is stale. Run: npm run gen:skills` when either file differs or is missing; exit 0 with `skills are up to date`.
- `--root <dir>` (default: repo root from the script path) so the test can run it on a temp copy. Same shape as `scripts/gen-docs.mjs`.
- `render(skillText) -> { codex, cursor }` is exported; the main block runs only when the script is the entry (`import.meta.url === pathToFileURL(process.argv[1]).href`), so a test import has no side effect.
- If the source has no frontmatter or no `description:`, the script exits 1 with a message (never writes a rule without a description).

### Packaging (T1)
- `packages/cli/package.json` `prepack` today copies only `skills/tocsin/SKILL.md`. Change it to copy the whole `../../skills` tree (`fs.cpSync('../../skills','skills',{recursive:true})`). `postpack` already removes `skills`.
- `skillSource()` in `connect.ts` becomes `skillSource(rel = "tocsin/SKILL.md")`: it looks for `skills/<rel>` in the published package, else in the repo checkout. The only caller is `planSkill` in the same file (grep: `skillSource` appears only in `packages/cli/src/connect.ts`). The default argument keeps the current behavior.

### New connect targets (T2)
`targets()` gets three new entries, in this order after the existing ones of the same flag:
- `{ name: "Codex skill", flag: "codex", kind: "skill-copy", path: ~/.codex/skills/tocsin/SKILL.md, detected: exists(~/.codex), src: "codex/tocsin/SKILL.md" }`
- `{ name: "Cursor rule", flag: "cursor", kind: "skill-copy", path: ~/.cursor/rules/tocsin.mdc, detected: exists(~/.cursor), src: "cursor/tocsin.mdc" }`
- `{ name: "Claude Code hook", flag: "claude-code", kind: "hook", path: ~/.claude/settings.json, detected: claudeDetected }`. It is in the chosen list only when `values.hook === true`. Without `--hook` it is filtered out before the loop, so settings.json is never read or written.

New `Kind` value `"skill-copy"` and plan function `planSkillCopy(current, src)`:
- source missing -> `failed` ("the packaged skill is missing").
- file absent -> `connected` with the source bytes.
- bytes equal -> `already`. Output: `<name>: already installed (<path>)`.
- bytes differ -> `different`. Output: `<name>: <path> differs from ours (edited?), left as is`. Nothing is written. It is not a failure (exit code unchanged), same as a different MCP entry today.
- Success output: `<name>: installed (<path>)`.

The existing Claude Code skill target (kind `skill`) keeps its current behavior: it overwrites a different file. This ticket does not change it (see ASSUMPTIONS).

The final line `already connected, nothing changed` keeps its rule: it prints when every chosen target is `already`. New targets count in `already`.

### Hook (T3)
- Entry added to `settings.hooks.SessionStart` (array, created when absent):
  `{ "matcher": "startup", "hooks": [ { "type": "command", "command": "npx -y tocsin check --summary" } ] }`
  The command string is one exported const `HOOK_COMMAND` in `connect.ts`.
- `planHook(current)`:
  - file absent -> `connected`, new file `{ "hooks": { "SessionStart": [entry] } }` + `\n`.
  - JSON parse fails, or root is not an object, or `hooks` is not an object, or `hooks.SessionStart` is not an array -> `failed` "could not parse"; file byte-identical; output prints the hook block (`{"hooks":{"SessionStart":[entry]}}` pretty-printed) so the user can add it by hand. Exit 1, same as a malformed `.claude.json`.
  - some entry in `SessionStart` has a hook whose `command` equals `HOOK_COMMAND` -> `already`.
  - some hook command contains `tocsin check` but is not equal -> `different`, left as is, ours printed.
  - else append the entry, keep every other key and order, keep the trailing newline (same code as `planJson`).
- `--dry-run` prints `would write <path>` and the hook block.
- Writes go through the existing `atomicWrite` (temp file + rename, mode kept).

### `check --summary` (T3)
The hook must print one line and never block. A shell pipeline over `--json` is not portable (no jq on Windows/macOS by default), so the check verb gets a `--summary` flag:
- It runs the same check as `--json` (same `runCheck` path; only the output step changes).
- Output, one line on stdout, always exit 0:
  - exit-0 result: `tocsin: 0 affected of <checked> checked (exit 0)`.
  - exit-1 result: `tocsin: <n> affected of <checked> checked, <e> exploited (exit 1). Run npx tocsin check --json for details.`
  - skipped > 0 adds `, <s> skipped`.
  - exit-2 (nothing to check): `tocsin: nothing to check here (exit 2)`.
  - exit-3: `tocsin: check failed (network)`.
- Implementation: `runCheck` keeps its body. A thin wrapper in `cli.ts` VERBS (or a branch at the top of `runCheck`) calls the core with an io whose `out`/`err` are captured, then prints the summary line from the parsed JSON and the code, and returns 0. To keep it small: factor the part of `runCheck` after the answers into `checkResult(io): Promise<{ code, data? }>` and let `runCheck` and the summary use it. `runCheck` output and exit codes for `--json` and the table stay byte-identical (existing `tests/cli/check.tcs-13.test.ts` pins them).

### `--print-agents-md` (T4)
Handled before the HOME check, like `--print`. Prints exactly 6 lines, writes nothing, exit 0:
```
## Security advisories (Tocsin)

At session start and before a deploy, run `npx tocsin check --json`.
Exit 1: a dependency has an advisory. Read `affected[]` and upgrade to `fixed_in`.
Exit 3: the check failed. Do not report the project as safe.
Docs: https://tocsin.sh/docs
```
One exported const `AGENTS_MD_BLOCK` in `connect.ts`.

### CLI flags (T2-T4)
`cli.ts` VERBS.connect options gain `hook: boolean` and `"print-agents-md": boolean`; VERBS.check gains `summary: boolean`. USAGE gains three lines.

### Docs (T5)
- `docs/API.md` "## Connect command": add `--hook` and `--print-agents-md` bullets, the Codex skill and Cursor rule paths, and a new `### Codex` subsection with a fenced `npx tocsin connect --codex` block and the fenced AGENTS.md block. The existing fenced `npx tocsin connect` block stays exactly as is (`site/docs.ts` CONNECT_BLOCK anchors the install links to it).
- `npm run gen:docs` regenerates `site/docs.generated.ts`.
- `README.md`: a `## Codex` section after "Quick start" with the same command and block.
- `packages/cli/README.md`: document `--hook`, `--print-agents-md`, `check --summary`, the two new files.

## Files to touch

- `scripts/gen-skills.mjs` (new)
- `skills/codex/tocsin/SKILL.md` (new, generated)
- `skills/cursor/tocsin.mdc` (new, generated)
- `package.json` (add `gen:skills` script)
- `.github/workflows/ci.yml` (add `npm run gen:skills -- --check` step)
- `packages/cli/package.json` (prepack copies the whole skills tree)
- `packages/cli/src/connect.ts`
- `packages/cli/src/cli.ts`
- `packages/cli/src/check.ts`
- `packages/cli/README.md`
- `docs/API.md`
- `site/docs.generated.ts` (generated)
- `README.md`
- `tests/cli/connect-codex.tcs-28.test.ts` (new)
- `tests/cli/connect-cursor-rule.tcs-28.test.ts` (new)
- `tests/cli/connect-hook.tcs-28.test.ts` (new)
- `tests/cli/print-agents-md.tcs-28.test.ts` (new)
- `tests/cli/gen-skills.tcs-28.test.ts` (new)
- `tests/cli/check-summary.tcs-28.test.ts` (new)
- `tests/routes/docs-codex.tcs-28.test.ts` (new)
- `tests/e2e/site-codex.tcs-28.spec.ts` (new)

## Tests that must change

- `tests/cli/connect.tcs-13.test.ts`: only if an assertion breaks because a Cursor-detected home now also gets `~/.cursor/rules/tocsin.mdc`. Read of the file: "second run" compares snapshots and the last line (still holds, the rule is `already` on run 2); "--dry-run writes nothing" compares snapshots (still holds); "--cursor touches only cursor" asserts the Claude skill is absent (still holds). Expected: None. If a case does break, the edit is limited to that case and the PR body carries a TEST-CHANGE line.

None expected.

## Verify (run, not edited)

- `npm run typecheck`
- `npm test`
- `npm run gen:docs -- --check`
- `npm run gen:schema -- --check`
- `npm run gen:skills -- --check`
- `tests/cli/connect.tcs-13.test.ts`, `tests/cli/check.tcs-13.test.ts`, `tests/cli/skill.tcs-13.test.ts`, `tests/cli/connect-print.tcs-36.test.ts`, `tests/routes/site-install-links.tcs-36.test.ts` (regression risk)

## Tasks

### T1. Generator, generated files, packaging
Write `scripts/gen-skills.mjs`, run it to create `skills/codex/tocsin/SKILL.md` and `skills/cursor/tocsin.mdc`, add `"gen:skills": "node scripts/gen-skills.mjs"` to `package.json`, add the `--check` step to `.github/workflows/ci.yml` after `gen:docs -- --check`, make `prepack` copy the whole skills tree, and make `skillSource(rel)` take a relative path.
VALIDATE: npm test -- tests/cli/gen-skills.tcs-28.test.ts && npm run gen:skills -- --check
SATISFIES: Scope 5, "The Cursor rule and the Codex copy are generated from it at build (`npm run gen:skills -- --check` in CI, same pattern as `gen:docs`)"; acceptance "`npm run gen:skills -- --check` fails when the Cursor rule is stale, passes after `npm run gen:skills`".

### T2. Codex skill and Cursor rule targets in connect
Add kind `skill-copy`, `planSkillCopy`, the two targets, and the `installed` / `already installed` / `differs ... left as is` outputs.
VALIDATE: npm test -- tests/cli/connect-codex.tcs-28.test.ts tests/cli/connect-cursor-rule.tcs-28.test.ts tests/cli/connect.tcs-13.test.ts
SATISFIES: Scope 1, "`connect --codex` (and the auto-detect path when `~/.codex` exists) copies `skills/tocsin/SKILL.md` to `~/.codex/skills/tocsin/SKILL.md`. Idempotent ... Never overwrite a user-edited skill file"; Scope 2, "`~/.cursor/rules/tocsin.mdc` with ... `description`, `alwaysApply: false`. Same idempotency rules."

### T3. SessionStart hook and `check --summary`
Add the hook target (only with `--hook`), `planHook`, `HOOK_COMMAND`, the `--hook` flag, and `check --summary` (one line, always exit 0, exit-3 line `tocsin: check failed (network)`).
VALIDATE: npm test -- tests/cli/connect-hook.tcs-28.test.ts tests/cli/check-summary.tcs-28.test.ts tests/cli/check.tcs-13.test.ts
SATISFIES: Scope 3, "`connect --claude-code --hook` adds a `SessionStart` hook ... prints a one-line summary (affected count, exit code). The hook never blocks the session: on exit 3 it prints "tocsin: check failed (network)" and exits 0. Without `--hook` nothing changes in settings.json. `--dry-run` prints the edit. A malformed settings.json is left byte-identical and the block is printed."

### T4. `--print-agents-md`
Add `AGENTS_MD_BLOCK`, the flag, the early return before HOME.
VALIDATE: npm test -- tests/cli/print-agents-md.tcs-28.test.ts
SATISFIES: Scope 4, "`connect --print-agents-md` prints a 6-line block for a repo's `AGENTS.md` ... run `npx tocsin check --json` at session start and before a deploy."

### T5. Docs: Codex section on /docs and in the README
Edit `docs/API.md`, run `npm run gen:docs`, edit `README.md` and `packages/cli/README.md`, update `USAGE` in `cli.ts`.
VALIDATE: npm run gen:docs -- --check && npm test -- tests/routes/docs-codex.tcs-28.test.ts tests/routes/site-install-links.tcs-36.test.ts && grep -n "## Codex" README.md
SATISFIES: Scope 4, "The site docs page and README gain a "Codex" section that shows `npx tocsin connect --codex` and the `AGENTS.md` block"; acceptance "`/docs` shows the "Codex" heading and the `--codex` command".

### T6. Browser check for /docs
New Playwright spec: `/docs` shows a visible "Codex" heading and the `npx tocsin connect --codex` command.
VALIDATE: npx playwright test tests/e2e/site-codex.tcs-28.spec.ts (needs chromium; if it cannot run here, record NOT RUN with the reason)
SATISFIES: acceptance "Docs: `tests/e2e/site.spec.ts` gains one check that `/docs` shows the "Codex" heading and the `--codex` command."

## Edge cases

- `~/.codex` exists but `~/.codex/skills` does not: `atomicWrite` creates the directories.
- `--codex` on a machine with no `~/.codex`: explicit flag wins, the skill and config.toml are written (same as today for config.toml).
- User-edited Codex skill or Cursor rule (one byte differs, or CRLF line endings): left byte-identical, mtime unchanged, the output names the path.
- Codex skill path exists as a directory or is unreadable: `failed` with the reason, exit 1, other targets still run.
- settings.json shapes: absent; `{}`; other keys (`permissions`, `env`, `model`) kept; `hooks` with other events (`PreToolUse`) kept; `SessionStart` with another user hook kept and ours appended; our entry already present (any matcher) -> already; a near-miss command (`npx tocsin check --json`) -> different, not appended; BOM at the start (stripped like `planJson`); `hooks` is an array or a string -> failed, byte-identical; trailing text after JSON -> failed.
- `--hook` with only `--cursor`: hook flag is ignored because the Claude Code group is not chosen. The output says nothing about the hook. (Edge accepted; see ASSUMPTIONS.)
- `--dry-run --hook`: prints the hook block, settings.json unchanged.
- `--print-agents-md` with no HOME: still prints, exit 0.
- `check --summary` with `TOCSIN_BASE_URL` unreachable: one line, exit 0; nothing on stderr from the summary path except what `runCheck` already writes is captured, not printed twice.
- `gen-skills --check` with the generated file missing: stale, exit 1.
- SKILL.md body contains `---` later in the text: only the first frontmatter block is split off (regex anchored at the start, same as `skill.tcs-13.test.ts`).

## Iron laws

- Sortable headers, list-over-cards, drill-down, mobile: the only UI change is text on `/docs` and the README. No table, no list page. The Codex code blocks are `<pre>` blocks, which the site already scrolls inside their own box (`/docs` 375 px no-scroll test in `tests/e2e/site.spec.ts` stays the guard).
- DB-driven config / every limit is a knob: no new limit, rate, threshold, timeout or cap. The hook command, the matcher `startup` and the AGENTS.md text are fixed strings of a local CLI, not business parameters. The CLI has no database. No literal added is a limit.
- Schema, RLS, indexes, retention, EXPLAIN: no table, no migration, no query. n/a.
- Dedup before spend: the hook runs `tocsin check` once per Claude Code session start. That is a call to Tocsin's own free API, not a metered vendor call. Nothing new is billed.
- De-AI voice: no LLM call. The skill text is unchanged. Docs copy is plain STE.
- No secrets: connect never writes the API key (existing rule). The hook command carries no key; `TOCSIN_API_KEY` stays in the user's env.
- Scalable tests: the CLI tests use the existing fake Io (`tests/cli/helpers.tcs-13.ts`): fetch throws on an unrouted URL, exec throws on an unlisted command. The `check --summary` tests route `/v1/check` to fixture answers. 0 network calls. Each test has its own temp HOME and cwd (mkdtemp), so no shared data and no order dependence. The gen-skills test uses its own temp root. No vendor is touched, so no seam, fake or contract test is needed.
- Performance by default: no screen loader changes. `/docs` stays one static string from `site/docs.generated.ts`, 0 DB statements, no new reads. n/a.
- build-discipline rules that bite: surgical changes (do not refactor `planJson`/`planToml`); a new test file per ticket; a generated file is committed with its generator and checked in CI (same as gen:docs).

## Changed symbols

- function `skillSource`: takes an optional relative path (`rel = "tocsin/SKILL.md"`). callers: `planSkill` in the same file keeps the default.
- function `targets` (connect.ts): adds the Codex skill, Cursor rule and Claude Code hook targets.
- function `runConnect`: handles `--print-agents-md`, filters the hook target on `--hook`, dispatches the two new kinds, prints `installed`/`already installed`.
- function `planSkillCopy` (new), function `planHook` (new), const `HOOK_COMMAND` (new), const `AGENTS_MD_BLOCK` (new).
- function `runCheck`: the result step is factored so `--summary` can reuse it; `--json` and table output unchanged.
- verb `tocsin connect`: new flags `--hook`, `--print-agents-md`.
- verb `tocsin check`: new flag `--summary`.
- format `~/.claude/settings.json` `hooks.SessionStart` entry written by connect.
- format `skills/cursor/tocsin.mdc` (new generated file) and `skills/codex/tocsin/SKILL.md` (new generated copy).
- format `docs/API.md` "Connect command" section: new `### Codex` subsection.
- format `package.json` scripts: new `gen:skills` key.

## Design collisions

- `package.json`: combine. Open PR #31 (TCS-14) adds two `devDependencies` lines (`esbuild`, `miniflare`). This plan adds one `scripts` key (`gen:skills`). Different keys and hunks; the second PR to merge takes a clean rebase. Main 3bf40e1 (TCS-36) does not edit `package.json`; its new `tests/cli/server-json.tcs-36.test.ts` reads the root `version`, which this plan does not change.
- `targets`: combine. Main 3bf40e1 (TCS-36) changed only the Claude Code `json` entry to `entry: mcpServerConfig(mcpUrl)` and moved `DEFAULT_MCP_URL` to `mcp-config.ts`. This plan appends three new entries and leaves the existing entries as main has them, so the build rebases on 3bf40e1 and adds its entries after main's lines.
- `runConnect`: combine. Main 3bf40e1 changed only `generic` to `mcpServerConfig(mcpUrl)` (the `--print` block). This plan adds the `--print-agents-md` early return beside `--print`, the `--hook` filter and the two new kinds, and keeps main's `generic` line and `--print` output unchanged (`tests/cli/connect-print.tcs-36.test.ts` is already in the regression list).
- `tocsin connect`: combine. Main 3bf40e1 matches on text only: docs/landing link placement after `npx tocsin connect` and a README "Directories" section. PR #31 matches on text only: README "Quick start" (net diff to main is zero after 3dcc73d) and `scripts/launch-check.sh`, which runs `connect --dry-run` with an empty HOME and wants the `"mcpServers"` or `[mcp_servers.tocsin]` block. This plan adds flags and targets but keeps the dry-run MCP block output, and with an empty HOME and no `--hook` it prints no hook and no skill-copy target, so the launch check still passes.
- `tocsin check`: combine. PR #31 matches on text only: README and launch-post copy show `npx tocsin check`; the launch script calls the HTTP API `/v1/check`, not the CLI verb. This plan adds an opt-in `--summary` flag and keeps the table and `--json` output and exit codes byte-identical, so the copy stays true.
- `runCheck`: combine. The `runCheck` in PR #31 (e5b40d6) is a different function: a test-local helper in `tests/launch/launch-check.tcs-14.test.ts` that spawns `scripts/launch-check.sh`. It does not touch `packages/cli/src/check.ts`. This plan's refactor of the CLI `runCheck` and PR #31's helper share only the name; no file overlaps.
- `docs/API.md`: combine. Neither main 3bf40e1 nor PR #31 edits `docs/API.md` (PR #31 net diff to its merge base is empty for it; TCS-36 matches on the text `npx tocsin connect`). TCS-36's `site/docs.ts` anchors the install links to the fenced `npx tocsin connect` block, and this plan already keeps that block byte-identical and adds `### Codex` after it.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at plan time. No sibling build is running.

## ASSUMPTIONS

- Test file names: the ticket names `tests/cli/*.tcs-16.test.ts` and asks to extend `tests/e2e/site.spec.ts`. The harness rule says new tests go in per-ticket files. I assume `tcs-28` names and a new `tests/e2e/site-codex.tcs-28.spec.ts`. Other reading: use the ticket's names and edit `site.spec.ts`.
- Hook command: the ticket says the hook "runs `npx tocsin check --json` and prints a one-line summary". A portable one-liner that parses JSON needs jq or node -e, which is fragile on Windows. I assume a new `tocsin check --summary` flag that runs the same check and prints the one line, always exit 0. The hook command is `npx -y tocsin check --summary`. Other reading: a shell pipeline over `--json`.
- Hook matcher: I assume `"matcher": "startup"`, so the check runs on a new session and not on every resume or compact. Other reading: no matcher (runs on every SessionStart source).
- Hook exit code on exit 1 (affected): the hook exits 0 for every result, and the summary line carries the real exit code. The ticket only states exit 3; "never blocks the session" covers the rest.
- A user-edited Codex skill or Cursor rule counts as `different` (not a failure): exit code 0, path printed. This matches how connect treats a different MCP entry today. Other reading: exit 1.
- The existing Claude Code skill target keeps its current overwrite behavior. The ticket's "never overwrite" rule is written for Codex (and Cursor by "same idempotency rules"). Changing the Claude Code skill is out of scope. Other reading: apply "never overwrite" to the Claude Code skill too.
- Generated file locations: `skills/codex/tocsin/SKILL.md` and `skills/cursor/tocsin.mdc` in the repo, shipped in the npm package by `prepack`. Other reading: generate them only at pack time and not commit them (then `--check` would have nothing to check).
- Cursor rule path: the ticket says `~/.cursor/rules/tocsin.mdc`. Cursor documents project rules in `<repo>/.cursor/rules/`; a home-level rules directory may not be read by Cursor. I follow the ticket's path and flag it here. Other reading: write the rule into the current project's `.cursor/rules/`.
- `--hook` without the Claude Code group chosen (for example `--cursor --hook`) does nothing for the hook. Other reading: `--hook` implies `--claude-code`.

## Failure modes

This plan changes no path under `bin/` or `worker/`. Section not required.

## System invariants

(a) Cross-run state: none. Idempotency comes from reading the target file each run (bytes equal / our command present). No ledger, no store.
(b) External side effects: the only side effects are local file writes through `atomicWrite` (temp + rename). Success prints `installed`/`connected`; a failed write prints `failed` with the path and the manual block, exit 1. A file that differs is never written. `--dry-run` writes nothing by construction (the write is inside `if (!dryRun)`). The hook's network call fails closed to a one-line message, exit 0.
(c) Adversarial negatives for the "is this our hook" matcher, which gates a write to the user's settings.json: must NOT count as ours and must NOT be replaced: `npx tocsin check --json` (near-miss, `different`), `npx -y tocsin check --summary --json` (`different`), a hook in `PreToolUse` with our exact command (not SessionStart: ours is appended to SessionStart), `"command": "echo tocsin"` (not ours, append). Must count as ours: our exact command under matcher `startup`, and under no matcher. The skill-copy matcher is a byte comparison: a CRLF copy or a trailing-space copy is `different`. Tests include these.
(d) Neighbors: Claude Code itself writes `~/.claude/settings.json` (the existing README warns to close Claude Code before connect for `.claude.json`; extend the warning to settings.json). No cron, lock or scheduler in this repo touches the CLI. CI gains one step (`gen:skills -- --check`) beside `gen:docs -- --check`.

## Requirements coverage

| Requirement | Task | Test |
|---|---|---|
| `connect --codex` writes `~/.codex/skills/tocsin/SKILL.md` byte-identical to the source | T1, T2 | connect-codex.tcs-28 "writes the skill" |
| Auto-detect path when `~/.codex` exists installs the Codex skill | T2 | connect-codex.tcs-28 "auto-detect" |
| Second run: "already installed", writes nothing, mtime unchanged | T2 | connect-codex.tcs-28 "second run" |
| Never overwrite a user-edited skill; print the path and skip | T2 | connect-codex.tcs-28 "user-edited" |
| Cursor rule at `~/.cursor/rules/tocsin.mdc` with `description` + `alwaysApply: false` + skill body | T1, T2 | connect-cursor-rule.tcs-28 "writes the rule" |
| Cursor rule idempotent, user edit kept | T2 | connect-cursor-rule.tcs-28 "second run", "user-edited" |
| `--claude-code --hook` adds exactly one SessionStart entry, keeps other keys | T3 | connect-hook.tcs-28 "adds one entry" |
| Second hook run adds nothing | T3 | connect-hook.tcs-28 "second run" |
| NEGATIVE: without `--hook`, settings.json byte-identical | T3 | connect-hook.tcs-28 "no --hook" |
| Malformed settings.json byte-identical, output contains the block | T3 | connect-hook.tcs-28 "malformed" |
| `--dry-run` prints the edit | T3 | connect-hook.tcs-28 "dry-run" |
| Hook prints one-line summary with affected count and exit code | T3 | check-summary.tcs-28 "affected", "clean" |
| Hook never blocks: exit 3 -> "tocsin: check failed (network)", exit 0 | T3 | check-summary.tcs-28 "network failure" |
| `--print-agents-md` prints a 6-line block with `npx tocsin check --json` | T4 | print-agents-md.tcs-28 |
| NEGATIVE: `--print-agents-md` writes nothing to disk | T4 | print-agents-md.tcs-28 "snapshot unchanged" |
| Docs page and README gain a "Codex" section with `--codex` and the AGENTS.md block | T5 | docs-codex.tcs-28 (route), grep README in T5 VALIDATE |
| `/docs` shows the "Codex" heading and the `--codex` command (browser) | T6 | site-codex.tcs-28.spec.ts |
| One source of truth: Cursor rule and Codex copy generated from SKILL.md | T1 | gen-skills.tcs-28 "render" |
| `gen:skills -- --check` fails when stale, passes after gen; runs in CI | T1 | gen-skills.tcs-28 "check stale/fresh"; ci.yml step |
| Out of scope: Codex hook, Windsurf, Zed, Gemini CLI, npm publish | none | none (not built) |

## Acceptance tests

All in the vitest `cli` project (plain Node) unless named otherwise. Each uses `fakeIo` from `tests/cli/helpers.tcs-13.ts` with its own temp HOME.

- `tests/cli/connect-codex.tcs-28.test.ts`
  - "writes the skill": HOME has `.codex/config.toml`; `connect --codex` exits 0; `~/.codex/skills/tocsin/SKILL.md` bytes equal `skills/tocsin/SKILL.md`; output has `Codex skill: installed (<path>)`.
  - "auto-detect": HOME has only `.codex/`; `connect` (no flag) writes the skill.
  - "second run": snapshot of HOME before and after the second run is equal (bytes and mtime); output contains `already installed`.
  - "user-edited": the skill file holds edited text; after `connect --codex` it is byte-identical with the same mtime; output contains the path; exit 0.
  - "CRLF copy is different": a CRLF version of the skill is not replaced.
- `tests/cli/connect-cursor-rule.tcs-28.test.ts`
  - "writes the rule": HOME has `.cursor/`; `connect --cursor`; `~/.cursor/rules/tocsin.mdc` starts with `---\n`, its frontmatter has `description: ` equal to the SKILL.md description and `alwaysApply: false`; its body equals the SKILL.md body.
  - "second run": HOME snapshot unchanged; `already installed`.
  - "user-edited": byte-identical, path printed.
- `tests/cli/connect-hook.tcs-28.test.ts`
  - "adds one entry": settings.json `{"permissions":{"allow":["Bash(ls)"]},"hooks":{"PreToolUse":[...]}}`; `connect --claude-code --hook`; `hooks.SessionStart` has length 1 and its command is `HOOK_COMMAND`; `permissions` and `hooks.PreToolUse` deep-equal the input.
  - "keeps a user SessionStart hook": an existing user entry stays first; ours is appended; length 2.
  - "second run": settings.json bytes and mtime unchanged.
  - "no --hook": `connect --claude-code`; settings.json bytes and mtime unchanged; also absent settings.json stays absent.
  - "malformed": settings.json `{"hooks": {`; exit 1; bytes and mtime unchanged; output contains `SessionStart` and `HOOK_COMMAND`.
  - "hooks not an object": `{"hooks":[]}` byte-identical, exit 1.
  - "near-miss command": an entry with `npx tocsin check --json` gives `different`; nothing appended.
  - "dry-run": `--claude-code --hook --dry-run`; HOME snapshot unchanged; output has `would write <settings path>` and the block.
- `tests/cli/check-summary.tcs-28.test.ts`
  - "affected": cwd has a `package-lock.json`; route `/v1/check` returns 2 affected (1 exploited) of 10; `check --summary` returns 0; stdout is exactly one line containing `2 affected` and `exit 1`.
  - "clean": 0 affected; one line with `0 affected` and `exit 0`; return 0.
  - "network failure": the route throws; return 0; stdout is exactly `tocsin: check failed (network)`.
  - "nothing to check": empty cwd, all runtimes absent; return 0; one line with `exit 2`.
  - "--json unchanged": `check --json` on the same fixture still returns 1 and prints the JSON document (guard on the refactor).
- `tests/cli/print-agents-md.tcs-28.test.ts`
  - prints exactly 6 lines; contains `npx tocsin check --json`, `session start` and `deploy`; HOME and cwd snapshots unchanged; exit 0; works with `HOME` unset.
- `tests/cli/gen-skills.tcs-28.test.ts`
  - "render": `render(skill).codex === skill`; `render(skill).cursor` frontmatter has the description and `alwaysApply: false`; body equals the skill body.
  - "repo is fresh": `node scripts/gen-skills.mjs --check` exits 0 on the repo.
  - "stale fails, gen fixes": copy `skills/` to a temp root, append a line to `skills/cursor/tocsin.mdc`; `--check --root <tmp>` exits 1 and names the file; run without `--check`; `--check` exits 0.
  - "edit the source": change the source SKILL.md in the temp root; `--check` exits 1.
- `tests/routes/docs-codex.tcs-28.test.ts` (vitest `api` project, through the production entry with `get` from `tests/routes/seed.tcs-3`)
  - GET `/docs` returns 200; HTML has an `<h3 id="codex">Codex</h3>`; contains `npx tocsin connect --codex` and `npx tocsin check --json`; the install links still follow the `npx tocsin connect` block.
- `tests/e2e/site-codex.tcs-28.spec.ts` (Playwright, not in `npm test`)
  - `/docs`: `getByRole('heading', { name: 'Codex' })` toBeVisible; `getByText('npx tocsin connect --codex')` toBeVisible.

Regression risk suites: `tests/cli/connect.tcs-13.test.ts` (connect outputs, snapshot equality with Cursor detected), `tests/cli/check.tcs-13.test.ts` (check output and codes after the refactor), `tests/cli/skill.tcs-13.test.ts` (package `files` has `skills`), `tests/cli/connect-print.tcs-36.test.ts`, `tests/routes/site-install-links.tcs-36.test.ts` (CONNECT_BLOCK anchor on /docs), `tests/e2e/site.spec.ts` (/docs at 375 px).

## QA screens

- `/docs` at 1440 px and 375 px: scroll to "Connect command", see the "Codex" heading, the `npx tocsin connect --codex` block and the AGENTS.md block. No horizontal body scroll at 375 px. The "Add to Cursor" and "Add to VS Code" links still sit after the `npx tocsin connect` block.
- CLI (terminal, not a browser): in a temp HOME with `~/.codex` and `~/.cursor`, run `node packages/cli/bin/tocsin.js connect --dry-run --hook`, then `connect --claude-code --codex --cursor --hook`, then the same again (expect `already` on every line).

## Verification checklist

1. `git rebase origin/main` before the first edit.
2. `npm run gen:skills` then `npm run gen:skills -- --check` (exit 0).
3. `npm run gen:docs` then `npm run gen:docs -- --check` (exit 0).
4. `npm run typecheck` (covers `packages/cli`).
5. `npm test` (all four vitest projects).
6. `cd packages/cli && npm pack --dry-run` lists `skills/codex/tocsin/SKILL.md` and `skills/cursor/tocsin.mdc`.
7. `npx playwright test tests/e2e/site-codex.tcs-28.spec.ts` if chromium is available; else record NOT RUN with the reason.

## Design collision check (BH-5791)

Checked 11 listed and 0 derived symbols against main e223873a7d4f..3bf40e187430 and 1 open PRs.
- `targets` (function, listed): main 3bf40e187430, body or signature changed. Resolution: combine.
- `runConnect` (function, listed): main 3bf40e187430, body or signature changed. Resolution: combine.
- `tocsin connect` (function, listed): main 3bf40e187430, (text match). Resolution: combine.
- `docs/API.md` (function, listed): main 3bf40e187430, (text match). Resolution: combine.
- `package.json` (function, listed): main 3bf40e187430, (text match). Resolution: combine.
- `runCheck` (function, listed): PR #31 e5b40d62455c, body or signature changed. Resolution: combine.
- `tocsin connect` (function, listed): PR #31 3dcc73db75bf, (text match). Resolution: combine.
- `tocsin check` (function, listed): PR #31 3dcc73db75bf, (text match). Resolution: combine.
- `docs/API.md` (function, listed): PR #31 3dcc73db75bf, (text match). Resolution: combine.

## Size

FILES: 11
LINES: 330
DIFF_KB: 40

KIND: feature
SIZE: M
