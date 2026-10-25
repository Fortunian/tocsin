# Plan: TCS-100 Distribution: Claude Code plugin + in-repo marketplace (directory-ready)

## Ticket state
- Issue #100, label `ai-build`, open, created 2026-10-25T16:07:02Z. Comment thread: 0 comments. The body is the whole spec.
- Already on main? No. `git log origin/main --since=2026-10-25T16:07:02Z` is empty. `plugins/` and `.claude-plugin/` do not exist on main. No PR or remote branch for TCS-100.
- CodeGraph: not available on this box. File set comes from grep and reads (evidence cited per file below).

## Spec changes from comments
none

## Scope
1. New plugin directory `plugins/tocsin/`: manifest, skill copy, MCP config, SessionStart hook.
2. New marketplace manifest `.claude-plugin/marketplace.json` at the repo root.
3. `scripts/gen-skills.mjs` also writes `plugins/tocsin/skills/tocsin/SKILL.md` (byte copy of `skills/tocsin/SKILL.md`), and `--check` covers it.
4. New `scripts/validate-plugin.sh`: runs `claude plugin validate --strict` on the plugin and on the marketplace when the `claude` CLI exists; prints a skip reason when it does not. CI runs it as one step.
5. `tocsin connect` prints the plugin install hint after it wires Claude Code MCP.
6. README, docs/API.md (+ regenerated `site/docs.generated.ts`), docs/OPERATING.md: plugin paragraph and directory submission steps.

Out of scope: the directory submission itself (human step, ticket item 5 says so).

## Trial evidence (planning, temp dir, nothing committed)
`claude` 2.1.302 is on this box. A temp layout identical to tasks T1/T2 gave:
- `claude plugin validate --strict ./plugins/tocsin` → "Validation passed", rc 0 (`displayName` is accepted).
- `claude plugin validate --strict .` → rc 1, one warning: "No marketplace description provided". T2 adds the description, so strict passes.
- `claude plugin install --help` lists `--marketplace <source>`. The ticket's command `claude plugin install tocsin --marketplace Fortunian/tocsin` is real syntax.

## Tasks

### T1. Plugin directory
Create:
- `plugins/tocsin/.claude-plugin/plugin.json`: `name: "tocsin"`, `displayName: "Tocsin"`, `version: "0.1.0"` (equal to `packages/cli/package.json`), `description` (the CLI package description), `author: {name: "Fortunian", url: "https://tocsin.sh"}`, `homepage: "https://tocsin.sh"`, `repository: "https://github.com/Fortunian/tocsin"`, `license: "Apache-2.0"`. No explicit `hooks`/`skills`/`mcpServers` path keys: Claude Code finds `hooks/hooks.json`, `skills/` and `.mcp.json` at their default places, and a manifest `hooks` key that points at the default `hooks/hooks.json` loads the file twice (duplicate-hooks error).
- `plugins/tocsin/.mcp.json`: `{"mcpServers":{"tocsin":{"type":"http","url":"https://mcp.tocsin.sh/mcp"}}}` (equal to `mcpServerConfig()` in `packages/cli/src/mcp-config.ts`; no auth).
- `plugins/tocsin/hooks/hooks.json`: `{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"npx -y tocsin check --summary"}]}]}}`. This is the same entry as `HOOK_ENTRY` in `packages/cli/src/connect.ts:53`.
- `plugins/tocsin/skills/tocsin/SKILL.md`: written by T3, not by hand.
VALIDATE: `npm test -- tests/plugin/plugin-manifest.tcs-100.test.ts` passes, and `claude plugin validate --strict ./plugins/tocsin` exits 0.
SATISFIES: Scope 1, "Add a plugin directory `plugins/tocsin/` with `.claude-plugin/plugin.json` ..., the skill ..., an `.mcp.json` ..., and the SessionStart hook".

### T2. Marketplace manifest
Create `.claude-plugin/marketplace.json`: `name: "tocsin"`, `owner: {name: "Fortunian"}`, `metadata: {description: "..."}` (or the top-level `description` key; use the key that `claude plugin validate --strict .` accepts with 0 warnings), `plugins: [{name: "tocsin", source: "./plugins/tocsin", description: "..."}]`. Do not repeat `version` in the marketplace entry: plugin.json is the one place for it.
VALIDATE: `claude plugin validate --strict .` exits 0, and `npm test -- tests/plugin/plugin-manifest.tcs-100.test.ts` passes.
SATISFIES: Scope 2, "Add `.claude-plugin/marketplace.json` at the repo root (name `tocsin`, owner Fortunian, one plugin, `source: "./plugins/tocsin"`)".

### T3. gen-skills writes the plugin skill
In `scripts/gen-skills.mjs`: add `plugin: "plugins/tocsin/skills/tocsin/SKILL.md"` to `OUTS`, `"plugin"` to `KEYS`, and `plugin: skill` to the `render()` result (byte copy, same as `codex`). Update the header comment. Run `npm run gen:skills` to write the file.
Evidence: `tests/cli/gen-skills.tcs-28.test.ts` reads only `out.codex`/`out.cursor` and copies only `skills/` into its temp root. Its temp-root cases still hold: a gen run creates the plugin file with `mkdirSync`, and the stale cases expect rc 1 anyway. No edit to that test.
VALIDATE: `npm run gen:skills -- --check` exits 0 and `npm test -- tests/plugin/skill-parity.tcs-100.test.ts tests/cli/gen-skills.tcs-28.test.ts` passes.
SATISFIES: Scope 1, "the skill (generated from `skills/tocsin/SKILL.md`, same generator as the Codex skill: `npm run gen:skills`)".

### T4. Validate script and CI step
Create `scripts/validate-plugin.sh` (bash, `set -euo pipefail`):
- If `command -v claude` fails: print `validate-plugin: skip: the claude CLI is not on this runner (marketplace and plugin JSON checks run in npm test)` and exit 0.
- Else run `claude plugin validate --strict ./plugins/tocsin` and `claude plugin validate --strict .` from the repo root, print each command and its full output to stdout, so the CI log records it, and exit non-zero when either fails. A failure is never turned into a skip.
- `--root <dir>` argument for tests (same idiom as gen-skills).
In `.github/workflows/ci.yml`, job `test`: add `- run: bash scripts/validate-plugin.sh` after the `gen:skills -- --check` step.
VALIDATE: `bash scripts/validate-plugin.sh; echo rc=$?` prints both "Validation passed" blocks and `rc=0` on this box; a run with PATH set to a temp dir that holds only symlinks to `bash`, `node` and coreutils (no `claude`; `/bin` is not usable because it links to `/usr/bin`, which holds `claude` on this box) prints the skip line and exits 0; `npm test -- tests/plugin/validate-script.tcs-100.test.ts` passes.
SATISFIES: Scope 3, "CI step: `claude plugin validate --strict ./plugins/tocsin` and `claude plugin validate .` (skip with a clear reason when the `claude` CLI is not on the runner; the marketplace JSON schema check runs always)" and AT "Verify script runs `claude plugin validate --strict ./plugins/tocsin` when the CLI exists and records its output".

### T5. Connect prints the plugin install hint
In `packages/cli/src/connect.ts`:
- Export `PLUGIN_INSTALL_COMMAND = "claude plugin install tocsin --marketplace Fortunian/tocsin"`.
- In `runConnect`, set a flag when the target `{flag: "claude-code", kind: "json"}` ends `connected` (a real write, not dry-run) or `already`. After the loop and BEFORE the final `already connected, nothing changed` line, print one line: `Claude Code plugin (skill, MCP server and hook in one): ${PLUGIN_INSTALL_COMMAND}`.
- The hint goes before the summary line because 3 tests pin the last line: `tests/cli/connect.tcs-13.test.ts:62`, `tests/cli/connect-codex.tcs-28.test.ts:55`, `tests/cli/connect-hook.tcs-28.test.ts:89`. The hint text must not match `/: connected \(/` (`connect.tcs-13.test.ts:63`).
- No hint on `--print`, `--print-agents-md`, dry-run, a failed Claude Code write, or a run that does not choose Claude Code.
VALIDATE: `npm test -- tests/cli/connect-plugin-hint.tcs-100.test.ts tests/cli/connect.tcs-13.test.ts tests/cli/connect-codex.tcs-28.test.ts tests/cli/connect-hook.tcs-28.test.ts tests/cli/connect-print.tcs-36.test.ts` passes, and `npm run typecheck` exits 0.
SATISFIES: Scope 4, "`tocsin connect --claude-code` prints the one-line plugin install command after it wires the MCP server".

### T6. Docs
- `README.md`: one "Claude Code plugin" paragraph next to the `--hook` line (README.md:47) with `claude plugin install tocsin --marketplace Fortunian/tocsin` and what it bundles (skill, MCP server, SessionStart hook).
- `docs/API.md`: a `### Claude Code plugin` subsection under `## Connect command` (after the `claude mcp add` block, API.md:253) with the same command. Then `npm run gen:docs` rewrites `site/docs.generated.ts` (CI runs `gen:docs -- --check`).
- `docs/OPERATING.md`: a `## Claude Code plugin directory` section with numbered operator steps: open claude.ai/directory/manage, a paid plan is needed, run `bash scripts/validate-plugin.sh` first, the pre-submission checklist link (the docs link on that page; the build writes the link only if it can name the exact URL from the Claude Code plugin docs, else the steps say "the checklist linked on the submission page"), submit the repo `Fortunian/tocsin` with plugin path `plugins/tocsin`. States that the submission is a human step.
VALIDATE: `grep -c "claude plugin install tocsin --marketplace Fortunian/tocsin" README.md docs/API.md` gives 1+ each; `grep -n "claude.ai/directory/manage" docs/OPERATING.md` matches; `npm run gen:docs -- --check` exits 0; `npm test -- tests/plugin/docs.tcs-100.test.ts` passes.
SATISFIES: Scope 4, "README + docs/API.md gain a "Claude Code plugin" paragraph with that command" and Scope 5, "`docs/OPERATING.md` gets the directory submission steps (claude.ai/directory/manage, paid plan, pre-submission checklist link)".

### T7. vitest project for the new tests
`vitest.config.ts`: add `tests/plugin/**` to the `api` project's `exclude` list, and add a `plugin` node project (`environment: "node"`, `include: ["tests/plugin/**/*.test.ts"]`). `package.json` `test` script: add `--project plugin`. Reason: the new tests read files and spawn node/bash; they need plain Node, not the Workers pool that the `api` project's catch-all `tests/**/*.test.ts` would give them.
VALIDATE: `npm test` runs the `plugin` project (its 4 files show in the agent reporter count) and exits 0.
SATISFIES: AT "`tests/plugin/plugin-manifest.test.ts` ..." and "`tests/plugin/skill-parity.test.ts` ..." (the paths the ticket names must run in `npm test`).

## Files to touch
- `plugins/tocsin/.claude-plugin/plugin.json` (new)
- `plugins/tocsin/.mcp.json` (new)
- `plugins/tocsin/hooks/hooks.json` (new)
- `plugins/tocsin/skills/tocsin/SKILL.md` (new, generated)
- `.claude-plugin/marketplace.json` (new)
- `scripts/gen-skills.mjs`
- `scripts/validate-plugin.sh` (new)
- `.github/workflows/ci.yml`
- `packages/cli/src/connect.ts`
- `vitest.config.ts`
- `package.json`
- `README.md`
- `docs/API.md`
- `site/docs.generated.ts` (generated by `npm run gen:docs`)
- `docs/OPERATING.md`
- `tests/plugin/plugin-manifest.tcs-100.test.ts` (new)
- `tests/plugin/skill-parity.tcs-100.test.ts` (new)
- `tests/plugin/validate-script.tcs-100.test.ts` (new)
- `tests/plugin/docs.tcs-100.test.ts` (new)
- `tests/cli/connect-plugin-hint.tcs-100.test.ts` (new)

## Verify (run, not edited)
- `npm run typecheck`
- `npm test`
- `npm run gen:skills -- --check`
- `npm run gen:docs -- --check`
- `npm run gen:schema -- --check`
- `bash scripts/validate-plugin.sh`
- Regression risk suites: `tests/cli/gen-skills.tcs-28.test.ts`, `tests/cli/connect.tcs-13.test.ts`, `tests/cli/connect-codex.tcs-28.test.ts`, `tests/cli/connect-hook.tcs-28.test.ts`, `tests/cli/connect-cursor-rule.tcs-28.test.ts`, `tests/cli/connect-print.tcs-36.test.ts`, `tests/cli/skill.tcs-13.test.ts`, `tests/routes/site*.test.ts` and `tests/routes/docs-codex.tcs-28.test.ts` (they read `site/docs.generated.ts`).

## Tests that must change
None

## Changed symbols
- function `render` (scripts/gen-skills.mjs): the result gains a `plugin` key (byte copy of the skill). callers: left alone: `tests/cli/gen-skills.tcs-28.test.ts` reads only `codex`/`cursor`.
- verb `gen:skills` (`npm run gen:skills [-- --check]`): also writes and checks `plugins/tocsin/skills/tocsin/SKILL.md`.
- verb `tocsin connect`: prints one plugin install hint line after a Claude Code MCP wire, before the final summary line.
- function `runConnect` (packages/cli/src/connect.ts): the hint line above.
- format `.claude-plugin/marketplace.json`: new file.
- format `plugins/tocsin/.claude-plugin/plugin.json`, `plugins/tocsin/.mcp.json`, `plugins/tocsin/hooks/hooks.json`: new files.
- verb `scripts/validate-plugin.sh`: new script.

## Edge cases
- No `claude` CLI on the runner (GitHub ubuntu-latest has none): script prints the skip reason, exit 0. The JSON shape checks in `plugin-manifest.tcs-100.test.ts` still run in `npm test`.
- `claude` present but validation fails: script exits non-zero. Never a skip.
- CLI version bump without a plugin.json bump: the manifest test fails on the PR. That is on purpose.
- MCP URL or hook command drift: the manifest test compares `.mcp.json` with `mcpServerConfig()` and `hooks.json` with `HOOK_COMMAND`, so a change in one place fails the test.
- Skill edit without `gen:skills`: `gen:skills -- --check` fails in CI (existing step).
- `TOCSIN_MCP_URL` override: the plugin `.mcp.json` is static (prod URL). The hint does not change with the override.
- Windows paths: no effect; the plugin files are static JSON.

## Iron laws
- Sortable headers, list-over-cards, drill-down, mobile: no UI screen changes. Docs page `/docs` gets one subsection of text only.
- DB-driven config / hardcoded-knob: no new limit, rate, threshold, price, timeout or cap. The MCP URL and install command are fixed public identifiers, not knobs.
- Schema, RLS, indexes, retention: no new table, no migration, no query.
- De-AI: no LLM call. Docs text is plain STE.
- Dedup-before-spend: no metered call. `claude plugin validate` is a local file check with no API call.
- model-id: no `claude-*` model string. (`claude` here is the CLI binary name.)
- Secrets: none. No new env var. The MCP server takes no auth.
- Scalable tests: no vendor call in tests. The validate-script test runs the script with a PATH that has no `claude` (skip path) and with a stub `claude` script on PATH that records its args and exits 0 or 1. The real `claude` binary is never called from `npm test`. Each test uses its own `mkdtemp` dir.
- Performance: no screen or loader change. No reads.

## Build discipline rules that bite this ticket
- Per-ticket test files: all new tests are `*.tcs-100.test.ts`; no edit to another ticket's test.
- Generated files: `plugins/tocsin/skills/tocsin/SKILL.md` and `site/docs.generated.ts` are written by their generators, never by hand.
- Surgical change: `connect.ts` gains one constant and one hint line; no refactor of the target loop.
- Honest claims: the PR body states `claude plugin validate` output from the build box, and states that CI skips it (no `claude` on the runner).

## Entry points
- CLI `tocsin connect` (existing entry point): touched, prints the install hint (T5).
- Docs `/docs` (`docs/API.md` → `site/docs.generated.ts`) and README: touched, plugin paragraph (T6).
- Claude Code `claude plugin install` / marketplace: new, reached through the hint and the docs.
- Site landing install links (`site/install.ts`): no change, because the ticket lists no site change and the landing page links to `/docs`, which gains the section.
- MCP server, API routes, Action: no change, because the plugin points at the existing `https://mcp.tocsin.sh/mcp` and runs the existing `check --summary`.

## ASSUMPTIONS
- Hook "runs the check when a lockfile is present (same command `tocsin connect --hook` writes today)": I assume the exact `HOOK_ENTRY` (`npx -y tocsin check --summary`, matcher `startup`). `check --summary` already prints one line and exits 0 when there is no lockfile. Other reading: wrap it in a shell lockfile test; not done, because the ticket says "same command".
- Plugin version "from `packages/cli/package.json`": I assume a static `0.1.0` in plugin.json, pinned equal by a test. Other reading: gen-skills writes the version; not done, because no release flow bumps the CLI version in CI today, and the test catches drift.
- CI validation: GitHub runners have no `claude` CLI, so the CI step skips with the reason, per the ticket. Other reading: `npx @anthropic-ai/claude-code plugin validate` in CI; not done, because the ticket says skip, and it is an unpinned large download on every PR.
- Hint condition: the hint prints when the Claude Code MCP target is connected or already connected (with `--claude-code` or by detection). Other reading: only with the explicit `--claude-code` flag; the wider one is harmless and shows the plugin to more Claude Code users.
- Test paths: the ticket names `tests/plugin/plugin-manifest.test.ts`, `tests/plugin/skill-parity.test.ts`, `tests/cli/connect-plugin-hint.test.ts`. The per-ticket rule makes them `*.tcs-100.test.ts`.
- Marketplace description key: the trial showed strict validation wants a marketplace description. I add it in the key the validator accepts (T2).
- `packages/cli/src/cli.ts` USAGE: no change. The hint is output, not a new flag.

## Failure modes
This plan changes no path under `bin/` or `worker/` (`workers/mcp` is not touched either). Section kept short.
- Decision rule: n/a, no classifier. The script's one decision (CLI present or not) is tested both ways. Test: `validate-script.tcs-100.test.ts`.
- Exit paths: skip → rc 0 with reason line; validate fail → rc non-zero. Test: `validate-script.tcs-100.test.ts`.
- Writer/reader round-trip: gen-skills writes the plugin skill, `--check` reads it. Test: `skill-parity.tcs-100.test.ts`.
- Alert or freeze blast radius: n/a, no alert.
- Defaults in prod: n/a, no knob.
- Status evidence: n/a, no status line.

## System invariants
None beyond the iron laws. This is static files, a generator extension, one CLI output line and docs; there is no cross-run state, no external side effect, no classifier and no cron, lock or cap.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| `plugins/tocsin/.claude-plugin/plugin.json` with name, displayName, description, author, homepage, repository, version from CLI | T1 | plugin-manifest.tcs-100: fields present; version === CLI package version |
| Skill generated from `skills/tocsin/SKILL.md` via `npm run gen:skills` | T3 | skill-parity.tcs-100 |
| `.mcp.json` → `https://mcp.tocsin.sh/mcp`, streamable HTTP, no auth | T1 | plugin-manifest.tcs-100: equals `mcpServerConfig()`, `type: "http"`, no `headers` key |
| SessionStart hook, same command `connect --hook` writes | T1 | plugin-manifest.tcs-100: hooks.json command === `HOOK_COMMAND`, matcher `startup` |
| `.claude-plugin/marketplace.json`: name tocsin, owner Fortunian, one plugin, source `./plugins/tocsin` | T2 | plugin-manifest.tcs-100 |
| Names match; every component path starts with `./` | T1, T2 | plugin-manifest.tcs-100 |
| CI: `claude plugin validate --strict ./plugins/tocsin` and `claude plugin validate .`, skip with reason when no CLI | T4 | validate-script.tcs-100; ci.yml step |
| Marketplace JSON schema check runs always | T7 + T2 | plugin-manifest.tcs-100 (ajv schema, in `npm test`) |
| `connect --claude-code` prints `claude plugin install tocsin --marketplace Fortunian/tocsin` | T5 | connect-plugin-hint.tcs-100 |
| README + docs/API.md "Claude Code plugin" paragraph with the command | T6 | docs.tcs-100 |
| OPERATING.md submission steps (directory/manage, paid plan, checklist link) | T6 | docs.tcs-100 |
| NEGATIVE: the submission itself is not in scope | none (no code submits) | n/a: no network call exists to pin |
| NEGATIVE (implied): existing connect output contract (last line) unchanged | T5 | existing connect.tcs-13:62, connect-codex.tcs-28:55, connect-hook.tcs-28:89 stay green |

## Acceptance tests
- `tests/plugin/plugin-manifest.tcs-100.test.ts` (node project):
  - plugin.json and marketplace.json parse as JSON.
  - `plugin.json.name === "tocsin"`, `=== marketplace.plugins[0].name`, `marketplace.name === "tocsin"`, `marketplace.owner.name === "Fortunian"`, `marketplace.plugins.length === 1`.
  - `plugin.json.version === packages/cli/package.json version`.
  - `displayName === "Tocsin"`, `homepage === "https://tocsin.sh"`, repository names `Fortunian/tocsin`, `author.name` set, `description` non-empty.
  - Every `source` in marketplace and every path-valued component key in plugin.json (if any) starts with `./`.
  - `.mcp.json.mcpServers.tocsin` deep-equals `mcpServerConfig()` and its url is `https://mcp.tocsin.sh/mcp`; no `headers`.
  - `hooks.json.hooks.SessionStart[0]` equals `{matcher:"startup", hooks:[{type:"command", command: HOOK_COMMAND}]}`.
  - ajv validates marketplace.json against an inline schema (required `name`, `owner.name`, `plugins[]` with `name` and string `source`).
  - Fails today: the files do not exist.
- `tests/plugin/skill-parity.tcs-100.test.ts`: `plugins/tocsin/skills/tocsin/SKILL.md` bytes equal `skills/tocsin/SKILL.md`; `node scripts/gen-skills.mjs --check` exits 0; in a temp copy of `skills/` + `plugins/`, an appended line in the plugin copy makes `--check` exit 1 with `plugins/tocsin/skills/tocsin/SKILL.md is stale`, and a gen run fixes it.
- `tests/plugin/validate-script.tcs-100.test.ts`: (a) PATH set to a temp bin dir of symlinks to `bash`, `node` and the coreutils the script uses, with no `claude` → stdout has `skip: the claude CLI is not on this runner`, rc 0; (b) stub `claude` on PATH that logs args and exits 0 → log holds `plugin validate --strict ./plugins/tocsin` and `plugin validate --strict .`, stdout records the stub output, rc 0; (c) stub exits 1 → rc non-zero and no skip line.
- `tests/plugin/docs.tcs-100.test.ts`: README.md and docs/API.md contain `claude plugin install tocsin --marketplace Fortunian/tocsin`; docs/API.md has heading `### Claude Code plugin`; docs/OPERATING.md contains `claude.ai/directory/manage` and the words `paid plan`.
- `tests/cli/connect-plugin-hint.tcs-100.test.ts` (cli project, uses `fakeIo` from `tests/cli/helpers.tcs-13.ts`): `connect --claude-code` stdout contains `claude plugin install tocsin --marketplace Fortunian/tocsin`; second run also has it and the last line is still `already connected, nothing changed`; `connect --cursor` (no Claude Code) has no hint; `connect --claude-code --dry-run` has no hint; `connect --print` has no hint.

## QA screens
- `https://tocsin.sh/docs` (after deploy): the "Claude Code plugin" subsection renders under "Connect command" with the install command in a code block. Check at 375px: the code block scrolls inside itself, no body horizontal scroll.
- Local CLI flow: `node packages/cli/bin/tocsin.js connect --claude-code` in a temp HOME prints the hint line.
- Not verified here: a real `claude plugin install tocsin --marketplace Fortunian/tocsin` works only after merge to main (the marketplace is read from the GitHub repo). Note it in the PR body.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section
claude plugin validate --strict ./plugins/tocsin <- T4 VALIDATE (output from the build box)
```

## Design collision check (BH-5791)

Checked 7 listed and 0 derived symbols against main 6967ddbb8d9e..6967ddbb8d9e and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 9
LINES: 120
DIFF_KB: 30

KIND: feature
SIZE: M
