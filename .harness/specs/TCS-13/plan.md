# TCS-13 plan: CLI `tocsin` (connect, check, latest, watch) plus the Claude Code skill

Ticket: Fortunian/tocsin#13. `Blocked-by: #9 (hard)`: #9 is CLOSED (merged as 105274e).
Thread: 0 comments. The body is the whole spec.
Already on main? No. `git log origin/main --since=2026-10-22T00:26:59Z -- packages skills tests/cli` is empty, and no `packages/` or `skills/` directory exists. `gh pr list --search TCS-13` finds no PR. No open PR exists.
CodeGraph: NOT AVAILABLE on this box. The file set comes from reading `src/app.ts`, `src/routes/check.ts`, `src/routes/events.ts`, `src/feed/query.ts`, `src/check/parsers/index.ts`, `workers/mcp/src/{index,api,tools}.ts`, `vitest.config.ts`, `tsconfig.json`, `package.json` and `.github/workflows/ci.yml`.
No cross-repo reads.

## Spec changes from comments
none

## Scope

A new, self-contained npm package `packages/cli/` (name `tocsin`, bin `tocsin`, 0 runtime dependencies, Node >= 20). It talks to the public API over HTTP only, the same way `workers/mcp` does. It does not import worker code at runtime. Plus `skills/tocsin/SKILL.md` at the repo root.

API facts the CLI depends on (read from the code on main):
- `POST /v1/check` takes lockfiles ONLY as `multipart/form-data` (field name = file name), and runtimes ONLY as JSON `{ "runtimes": { "node": "22.1.0" } }`. Answer: `{ checked, affected[], skipped[], feed_cursor }`. `no-store`. Rate limit 20/min.
- `GET /v1/events?since=&limit=&ecosystem=&order=asc|desc` answers `{ events[], next_cursor, has_more }`, with `ETag` and 304 on `If-None-Match`. `limit` cap 100.
- MCP server: streamable HTTP at `https://mcp.tocsin.sh/mcp` (`workers/mcp/src/index.ts`, route `mcp.tocsin.sh/*`).

## Files to touch

Product code (all new except the last four):
- `packages/cli/package.json`: `name: tocsin`, `version: 0.1.0`, `type: module`, `bin: { tocsin: bin/tocsin.js }`, `engines.node >=20`, `files: [bin, dist, skills]`, no `dependencies`, scripts `build` (`tsc -p tsconfig.build.json`) and `prepack` (build + copy `../../skills/tocsin/SKILL.md` to `skills/tocsin/SKILL.md`), license Apache-2.0.
- `packages/cli/tsconfig.json`: typecheck config, `types: ["node"]`, `module/moduleResolution: NodeNext`, `noEmit`, include `src` and `../../tests/cli`.
- `packages/cli/tsconfig.build.json`: extends it, `rootDir: src`, `outDir: dist`, emit on, include `src` only.
- `packages/cli/bin/tocsin.js`: `#!/usr/bin/env node`, imports `../dist/cli.js`, calls `main(nodeIo())`, sets `process.exitCode`.
- `packages/cli/src/cli.ts`: `main(io)`: argv parse (`node:util` `parseArgs`), dispatch to verbs, `--help`, unknown verb or flag = usage on stderr + exit 2. `nodeIo()` builds the real io (process.argv/env/cwd/stdout/stderr, global `fetch`, `execFile`, `setTimeout` sleep).
- `packages/cli/src/io.ts`: the `Io` interface (argv, env, cwd, out, err, fetch, exec, sleep). The ONE seam to the network and to child processes. Tests inject it.
- `packages/cli/src/api.ts`: tiny client: `checkLockfiles(files)`, `checkRuntimes(rt)`, `events(params, etag?)`. Base from `TOCSIN_BASE_URL` (default `https://tocsin.sh`, trailing slash trimmed). `Authorization: Bearer <TOCSIN_API_KEY>` only when set. `User-Agent: tocsin-cli/<version>`. Returns `{ ok, status, body, etag, retryAfter }`; status 0 on network error. Never logs the key.
- `packages/cli/src/connect.ts`: the `connect` verb (detail below).
- `packages/cli/src/check.ts`: the `check` verb, lockfile finder, runtime detector, merge, table.
- `packages/cli/src/feed.ts`: `latest` and `watch` verbs, one-line event formatter.
- `packages/cli/README.md`: npm page: the 4 verbs, flags, env vars, exit codes.
- `skills/tocsin/SKILL.md`: the skill (frontmatter `name: tocsin`, `description: ...`).
- `vitest.config.ts`: add a third project `cli` (`environment: "node"`, no Cloudflare plugin, `include: ["tests/cli/**/*.test.ts"]`); add `"tests/cli/**"` to the `api` project's `exclude`.
- `tsconfig.json`: add `"tests/cli"` to `exclude` (those tests use Node types, not workers types).
- `package.json` (root): `typecheck` appends `&& tsc --noEmit -p packages/cli`; devDependency `@types/node` (`^22`). `package-lock.json` updates with it (generated).
- `.env.example`: two commented lines for the CLI's `TOCSIN_API_KEY` and `TOCSIN_MCP_URL` (client-side, not worker secrets).
- `README.md`: a short "CLI" section that points to `npx tocsin connect` and `npx tocsin check`.

Tests (new, per-ticket names):
- `tests/cli/helpers.tcs-13.ts`: `fakeIo()` builder: temp `HOME` and `cwd` from `fs.mkdtemp` per test, captured out/err, a fetch fake that records calls and THROWS on any unrouted URL, an exec fake (map of command to stdout or ENOENT), a no-op sleep.
- `tests/cli/connect.tcs-13.test.ts`
- `tests/cli/check.tcs-13.test.ts`
- `tests/cli/latest.tcs-13.test.ts` (latest and watch)
- `tests/cli/skill.tcs-13.test.ts`
- `tests/fixtures/cli/package-lock.json` (small lockfile v3, 2 packages)

## Tests that must change
None. (`vitest.config.ts` gets a new project and one exclude; no existing test file changes.)

## Verify (run, not edited)
- `npm test` (all three projects: api, mcp, cli)
- `npm run typecheck`
- `npm run gen:schema -- --check`
- `cd packages/cli && npm run build && node bin/tocsin.js --help` (as-shipped run, D7)
- `cd packages/cli && npm pack --dry-run` (lists `bin/tocsin.js`, `dist/*.js`, `skills/tocsin/SKILL.md`)

## Tasks

### T1. Package skeleton, seam and test project
Create `packages/cli/{package.json,tsconfig.json,tsconfig.build.json,bin/tocsin.js,src/io.ts,src/cli.ts,src/api.ts}`. Add the `cli` vitest project, the root tsconfig exclude, the typecheck script and `@types/node`. `main()` answers `--help` (exit 0) and an unknown verb (usage on stderr, exit 2). `nodeIo()` is the only place that touches `process`, global `fetch` and `child_process`.
VALIDATE: `npm run typecheck && npx vitest run --project cli` (exit 0), and `cd packages/cli && npm run build && node bin/tocsin.js --help; echo $?` prints usage and `0`; `node bin/tocsin.js nope; echo $?` prints `2`.
SATISFIES: "`packages/cli/` published to npm as `tocsin` ... Zero runtime dependencies beyond Node 20 built-ins ... `TOCSIN_BASE_URL` (default `https://tocsin.sh`) and `TOCSIN_API_KEY` env vars."

### T2. `tocsin connect`
Targets (each: detect path, config path, entry):
| target | flag | detected when | config file | entry written |
|---|---|---|---|---|
| Claude Code | `--claude-code` | `$HOME/.claude.json` or `$HOME/.claude/` exists | `$HOME/.claude.json`, key `mcpServers.tocsin` | `{ "type": "http", "url": MCP_URL }` |
| Claude Code skill | (with Claude Code) | same | `$HOME/.claude/skills/tocsin/SKILL.md` | the packaged SKILL.md bytes |
| Cursor | `--cursor` | `$HOME/.cursor/` exists | `$HOME/.cursor/mcp.json`, key `mcpServers.tocsin` | `{ "url": MCP_URL }` |
| Claude Desktop | `--claude-desktop` | its config dir exists: macOS `$HOME/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\` | `claude_desktop_config.json` in that dir, key `mcpServers.tocsin` | `{ "command": "npx", "args": ["-y", "mcp-remote", MCP_URL] }` |
| Codex | `--codex` | `$HOME/.codex/` exists | `$HOME/.codex/config.toml` | appended table `[mcp_servers.tocsin]` + `url = "<MCP_URL>"` |

`MCP_URL` = `TOCSIN_MCP_URL` env or `https://mcp.tocsin.sh/mcp`. HOME comes from `io.env.HOME` (`USERPROFILE` on Windows), so the test's temp HOME is the only disk the test touches.

Rules, per target:
1. No flag: wire every DETECTED target. One or more flags: wire only those, and create the config file (and its parent dir) when it is absent.
2. JSON file absent: create `{ "mcpServers": { "tocsin": entry } }`.
3. JSON file present: `JSON.parse`. Parse failure, or a top-level value that is not an object, or `mcpServers` that is not an object: write NOTHING, print the path and the JSON block (`{"mcpServers":{"tocsin":...}}`), mark the target `failed`.
4. `mcpServers.tocsin` deep-equals the entry: no write, report `already connected`.
5. `mcpServers.tocsin` exists with a different value: no write, report `has a different tocsin entry, left as is` plus the block. (Never overwrite a user's own entry.)
6. Else: set the key, write `JSON.stringify(obj, null, 2)` + the original trailing newline, through a temp file in the same dir + `rename` (atomic), keep the original file mode.
7. TOML: a line matching `^\s*\[mcp_servers\.("?)tocsin\1\]` = already connected. Else append `\n[mcp_servers.tocsin]\nurl = "<MCP_URL>"\n` (atomic write of the full new text). An unreadable file = `failed` + print block and path.
8. Skill: target bytes equal the packaged bytes = no write. Else write (mkdir -p). The packaged file is found at `<pkgRoot>/skills/tocsin/SKILL.md` (published) else `<pkgRoot>/../../skills/tocsin/SKILL.md` (repo checkout); neither found = `failed` with the path tried.
9. `--dry-run`: compute every edit, print `would write <path>` and the new entry, write nothing. `--print`: print only the MCP JSON block on stdout, touch nothing, exit 0.
10. Output: one line per target: `<target>: connected (<path>)`, `<target>: already connected (<path>)`, `<target>: could not parse <path>; add this block by hand:` + block. If every target is already connected, the last line says `already connected, nothing changed`. No target detected and no flag: print `no agent tool found` plus the block, exit 0.
11. Exit: 0 when no target failed; 1 when any target failed; 2 on a usage error.
12. The CLI never writes `TOCSIN_API_KEY` into any config file.
VALIDATE: `npx vitest run --project cli tests/cli/connect.tcs-13.test.ts` (exit 0).
SATISFIES: "`npx tocsin connect` ... detects the agent tools present on the machine and wires each one in one run ... Flags ... `--dry-run` prints the edits; `--print` prints the MCP JSON block only. Idempotent: a second run changes nothing and says so. Never overwrites a file it cannot parse; it prints the block and the path instead."

### T3. `tocsin check`
1. Lockfiles: `readdir(cwd)` (top level only), keep names whose lowercase is in `package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, requirements.txt, go.sum, composer.lock, cargo.lock, gemfile.lock` or matches `^requirements[-_.][^/]*\.txt$` (the same rule as `src/check/parsers/index.ts:detectParser`). Read each as UTF-8.
2. Runtimes: run in parallel through `io.exec` with a 5 s timeout each: `node --version`, `php --version`, `python --version` (then `python3 --version` if `python` is absent), `go version`, `bun --version`, `deno --version`. Extract the first `\d+\.\d+(\.\d+)?` from stdout+stderr (`v22.1.0`, `PHP 8.3.1 (cli)`, `Python 3.12.1`, `go version go1.22.3 linux/amd64`, `1.1.38`, `deno 2.0.0 (stable ...)`). ENOENT, non-zero exit, timeout or no match = runtime absent (not an error).
3. Nothing found: usage hint on stderr (`no lockfile in <cwd> and no runtime found; run in a project directory`), exit 2, 0 network calls.
4. Calls, in parallel (`Promise.all`): one multipart POST with ALL lockfiles (field name = file name) when any; one JSON POST `{ runtimes }` when any. Merge like `workers/mcp/src/tools.ts:check`: sum `checked`, concat `affected` and `skipped`, `feed_cursor` = min. Re-sort `affected` by severity rank desc, then exploited, then advisory id (the server's order).
5. Any call not ok (status 0, 4xx, 5xx) or a body without `checked`/`affected` arrays: print `check failed: <status> <error>` on stderr, exit 3. Never exit 0 or 1 on a failed check (D9).
6. Output: `--json` prints the merged object (`{ checked, affected, skipped, feed_cursor }`) as one JSON document on stdout. Else a plain-text table: `SEVERITY  PACKAGE@VERSION  ADVISORY  FIXED IN  ACTION`, then a summary line `N of M dependencies affected` or `No known advisory affects the M checked dependencies`, plus `K skipped` when K > 0.
7. Exit 1 when `affected.length > 0`, 0 when it is 0, 2 on usage error, 3 when the check could not run.
VALIDATE: `npx vitest run --project cli tests/cli/check.tcs-13.test.ts` (exit 0).
SATISFIES: "`npx tocsin check`: finds lockfiles in cwd, detects `node --version`, ... POSTs to `/v1/check`, prints a table, exits 1 when anything is affected, 0 when clean, 2 on usage error. `--json` for machine output."

### T4. `tocsin latest` and `tocsin watch`
1. `latest [--ecosystem x] [--since cursor] [--limit n]`: one GET `/v1/events?order=desc&limit=<n, default 20, max 100>` plus `ecosystem` and `since` when given. Print one line per event: `<published_at date> <severity> <ecosystem>/<component> <id>[ <first CVE>][ exploited]: <summary>` (newlines in the summary become spaces). Print `next_cursor: <n>` on stderr, so stdout carries only event lines. `--json` prints the raw page. Non-numeric `--since`: exit 2. API failure: stderr + exit 3.
2. `watch [--ecosystem x] [--since cursor]`: start cursor = `--since`, else `next_cursor` of `GET /v1/events?order=desc&limit=1` (the newest cursor, so watch prints only events newer than start). Each poll: `GET /v1/events?since=<cursor>&limit=100` (asc) with `If-None-Match`; 304 = nothing new; 200 = print each event line, set cursor = `next_cursor`, store ETag, and fetch the next page at once while `has_more`. Then `io.sleep(300_000)`. 429: sleep `Retry-After` seconds. Network or 5xx error: one stderr line, keep polling (no exit). Ctrl-C ends it (exit 0 via the default SIGINT behavior).
3. The poll interval is a documented client constant (`POLL_MS = 300_000`), not a server setting: the ticket fixes it at 5 minutes and the CLI has no DB.
VALIDATE: `npx vitest run --project cli tests/cli/latest.tcs-13.test.ts` (exit 0).
SATISFIES: "`npx tocsin latest [--ecosystem x] [--since cursor]` and `npx tocsin watch` (polls every 5 minutes, prints new events)."

### T5. The skill
`skills/tocsin/SKILL.md` with YAML frontmatter `name: tocsin` and a one-line `description`. Body (plain, short sentences, no AI-isms):
- Run `npx tocsin check --json` at session start in any repo with a lockfile, before a deploy, and when a security headline appears.
- Exit codes: 0 clean, 1 affected, 2 usage error (wrong directory or nothing to check), 3 the check could not run (network or API error; it is NOT a clean result).
- How to read the JSON: `affected[]` items (`dependency`, `advisory_id`, `severity.label`, `exploited`, `fixed_in`, `action`, `url`), `skipped[]` (not checked, never clean), `feed_cursor` (pass to `npx tocsin latest --since`).
- What to do: upgrade to `fixed_in` when present, follow `action`, cite `url`; tell the user about exploited or critical items first.
VALIDATE: `npx vitest run --project cli tests/cli/skill.tcs-13.test.ts` (exit 0).
SATISFIES: "`skills/tocsin/SKILL.md`: tells the agent to run `npx tocsin check` at session start in any repo with a lockfile, before a deploy, and when a security headline appears, and how to read the exit code and JSON." and "The skill file has `name` and `description` frontmatter."

### T6. Docs and env
`packages/cli/README.md`, root `README.md` CLI section, `.env.example` lines. Every claim in them matches code from T1 to T5 (D5).
VALIDATE: `grep -n "npx tocsin connect" README.md packages/cli/README.md` finds both; `grep -n "TOCSIN_API_KEY" .env.example` finds the line; `cd packages/cli && npm pack --dry-run 2>&1 | grep -c "skills/tocsin/SKILL.md"` prints 1.
SATISFIES: "`packages/cli/` published to npm as `tocsin`" (the package ships the skill and documents the env vars).

## Edge cases
- `~/.claude.json` is large and Claude Code rewrites it. The CLI reads, edits one key, writes through temp + rename. A concurrent Claude Code write can still win the race; the README says to run `connect` with Claude Code closed. Atomic rename means the file is never half-written.
- A file with a UTF-8 BOM: strip the BOM before parse; a BOM file that parses is rewritten without the BOM. (Claude/Cursor read both.)
- `mcpServers` absent but the file is a valid object: add it.
- JSONC (comments) in `~/.cursor/mcp.json`: parse fails, so rule 3 applies (print block, no write).
- Windows: `APPDATA` absent = Claude Desktop not detected.
- Lockfile names are matched case-insensitively (`Cargo.lock`, `Gemfile.lock`).
- Lockfiles over the server cap (2 MiB, `settings.check.max_body_bytes`): the server answers 413; the CLI prints it and exits 3.
- `TOCSIN_BASE_URL` with a trailing slash: trimmed.
- `--json` output must be one valid JSON document even when `skipped` is non-empty.

## Iron laws: how they apply
- Sortable headers, list-over-cards, drill-down, 375 px, native dialogs: n/a. No web UI. The text table is a terminal output.
- DB-driven config / RLS / indexes / EXPLAIN / retention: n/a. No migration, no new table, no new query. The CLI is a client of existing routes.
- No hardcoded `claude-*` model string: the CLI writes the word "claude" only in config paths and target names. No model id.
- No LLM, De-AI: n/a (no LLM call). Human copy in the CLI and SKILL.md uses plain short sentences.
- Dedup before spend: no metered call. The `/v1/check` call is free and rate-limited (20/min); `check` makes at most 2 calls per run. `watch` uses ETag/304 and a 5-minute interval.
- Secrets: the CLI reads `TOCSIN_API_KEY` from env, sends it only as a Bearer header to `TOCSIN_BASE_URL`, never prints it and never writes it to a config file.
- Scalable tests (BH-7563): the "vendor" is our own API. Seam: `packages/cli/src/io.ts` (`fetch`, `exec`). Fake: `tests/cli/helpers.tcs-13.ts` `fakeIo()` returns seeded responses and THROWS on any unrouted URL or unlisted command, so 0 network calls and 0 real child processes. Contract test: none needed (the API is in-repo and covered by its own suites); the budget assertion is the throwing fetch fake plus an explicit `expect(calls)` count in each test. Each test makes its own `mkdtemp` HOME/cwd. No shared state, no order dependence.
- Performance by default: no screen or loader. `check` runs its 2 POSTs and its 6 runtime probes in parallel (`Promise.all`); no sequential await over independent work.

## Changed symbols
- verb `tocsin connect`: new.
- verb `tocsin check`: new.
- verb `tocsin latest`: new.
- verb `tocsin watch`: new.
- function `main` (packages/cli/src/cli.ts): new CLI entry.
- format `mcpServers.tocsin` entry in `~/.claude.json`, `~/.cursor/mcp.json`, `claude_desktop_config.json`; `[mcp_servers.tocsin]` in `~/.codex/config.toml`: new, written by connect.
- format `skills/tocsin/SKILL.md`: new.
- format `vitest.config.ts` project list: adds project `cli`; `api` project excludes `tests/cli/**`.
- format `package.json` script `typecheck`: appends the CLI tsconfig.

## Design collisions
None. No open PR exists in Fortunian/tocsin, and main since be088aa did not change `vitest.config.ts`, `tsconfig.json` or `package.json`.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty. No live sibling build.

## ASSUMPTIONS
- Test file names: the ticket names `tests/cli/connect.test.ts`, `check.test.ts`, `latest.test.ts`. The harness rule requires per-ticket names, so they are `tests/cli/connect.tcs-13.test.ts`, `check.tcs-13.test.ts`, `latest.tcs-13.test.ts`, plus `skill.tcs-13.test.ts`. The assertions are the ticket's. Other reading: use the ticket's exact names.
- MCP entry shapes: Claude Code `{type:"http",url}`, Cursor `{url}`, Claude Desktop through `npx -y mcp-remote <url>` (its JSON config has no remote-URL field), Codex `url = ...` under `[mcp_servers.tocsin]` (streamable HTTP). Other reading: a stdio bridge for every tool. The remote URL is simpler where the tool supports it.
- MCP URL: `https://mcp.tocsin.sh/mcp` (the route in `workers/mcp/src/index.ts`), with an env override `TOCSIN_MCP_URL` for self-hosters. The ticket names only `TOCSIN_BASE_URL` and `TOCSIN_API_KEY`. Other reading: derive the MCP URL from `TOCSIN_BASE_URL`; there is no rule that maps one to the other, so we do not guess.
- Detection = the tool's config file or config dir exists. With an explicit flag, connect creates the config file when absent.
- An existing `tocsin` entry with a different value is left as is and reported. Other reading: overwrite it. Leaving it is the reversible choice and matches "never overwrites".
- Connect does not write `TOCSIN_API_KEY` into configs. The watch-list MCP tool then needs the user to add a header by hand. Other reading: write the key; that copies a secret into several files.
- Exit codes: the ticket defines 0, 1 and 2 for check. A check that could not run (network error, 4xx/5xx) exits 3, so a failure never reads as clean. `connect` exits 1 when any target could not be written.
- `python --version` falls back to `python3 --version` when `python` is absent (common on macOS and Debian). Other reading: only `python`.
- Lockfile discovery is the top level of cwd only (the ticket says "in cwd"). Other reading: recursive; that can send a monorepo's vendored lockfiles.
- `latest` default limit is 20, newest first. The ticket gives no number.
- npm publish is an operator step (needs the npm account). The build ships a publishable package and the PR body names the step: `cd packages/cli && npm publish`.
- The skill is canonical at `skills/tocsin/SKILL.md`; `prepack` copies it into the package, so the published package and the repo cannot drift at publish time.

## System invariants
- (a) Cross-run state: none on a server. `watch` keeps its cursor and ETag in memory for the life of the process only; a restart starts from the newest cursor or `--since`. `connect` is idempotent by reading the target file each run; no ledger.
- (b) External side effects:
  - Config writes: write only after a successful parse; temp file + rename; the report line `connected` prints only after the rename succeeds. A write error marks the target `failed` (exit 1) and prints the block. `--dry-run` and `--print` perform 0 writes by construction (the write function is not called on those paths, asserted by mtime and by a directory listing).
  - HTTP: a failed or malformed answer is exit 3, never 0 or 1. `watch` advances its cursor only after it printed the page.
- (c) Adversarial negatives for the "already connected" matcher (it gates a write to a user's config):
  - `mcpServers.tocsin` with a different URL: NOT "already connected"; left as is, reported.
  - `mcpServers.tocsin-dev` or `mcpServers.Tocsin`: NOT a match; tocsin is added beside it.
  - A `tocsin` key at the top level (outside `mcpServers`): NOT a match.
  - TOML `[mcp_servers.tocsin_old]` or `# [mcp_servers.tocsin]` (a comment): NOT a match; the block is appended.
  - TOML `[mcp_servers."tocsin"]`: IS a match.
  Lockfile matcher negatives: `package.json`, `requirements.in`, `yarn.lock.bak`, a `node_modules/` subdir lockfile: NOT sent.
- (d) Neighbor interactions: `/v1/check` rate limit (20/min per IP, `src/middleware/ratelimit.ts`): `check` uses at most 2 requests per run. `/v1/events` rate limit: `watch` makes 1 request per 5 minutes plus extra pages only while `has_more`. The vitest `api` and `mcp` projects: the new `cli` project is a separate project, and the `api` project excludes `tests/cli/**`, so the Cloudflare pool never loads Node-only tests. CI (`.github/workflows/ci.yml`) runs `npm run typecheck` and `npm test`; both cover the CLI with no workflow edit.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| Package `packages/cli/`, npm name `tocsin`, 0 runtime deps | T1 | `skill.tcs-13.test.ts`: reads `packages/cli/package.json`, asserts `name === "tocsin"`, `bin.tocsin`, no `dependencies` key or empty |
| `TOCSIN_BASE_URL` default `https://tocsin.sh` | T1 | `check.tcs-13.test.ts`: env unset, fetch fake sees `https://tocsin.sh/v1/check`; env set to `https://x.test/`, sees `https://x.test/v1/check` |
| `TOCSIN_API_KEY` | T1 | `latest.tcs-13.test.ts`: key set, request has `Authorization: Bearer <key>`; key unset, no header |
| connect wires Claude Code (`~/.claude.json` mcpServers) + installs skill | T2 | `connect.tcs-13.test.ts` "wires claude code and cursor" |
| connect wires Cursor | T2 | same test |
| connect wires Claude Desktop | T2 | `connect.tcs-13.test.ts` "claude desktop macOS path" (HOME/Library/Application Support/Claude exists) |
| connect wires Codex | T2 | `connect.tcs-13.test.ts` "codex appends table once" |
| Flags limit to one target | T2 | `connect.tcs-13.test.ts` "--cursor touches only cursor" (claude.json mtime and bytes unchanged) |
| `--dry-run` prints edits | T2 | `connect.tcs-13.test.ts` "--dry-run writes nothing" |
| `--print` prints the JSON block only | T2 | `connect.tcs-13.test.ts` "--print" (stdout parses as JSON with `mcpServers.tocsin.url`) |
| Idempotent, second run says so, 0 writes | T2 | `connect.tcs-13.test.ts` "second run: already connected, mtime unchanged" |
| Never overwrites an unparsable file; prints block + path | T2 | `connect.tcs-13.test.ts` "malformed claude.json byte-identical" |
| NEGATIVE: never overwrite a user's different tocsin entry | T2 | `connect.tcs-13.test.ts` "different tocsin entry left as is" |
| check finds lockfiles in cwd | T3 | `check.tcs-13.test.ts` "lockfile sent as multipart field package-lock.json" |
| check detects runtime versions | T3 | `check.tcs-13.test.ts` "runtime versions parsed from 6 outputs" |
| check POSTs `/v1/check` | T3 | same tests (fetch fake asserts method + path) |
| check prints a table | T3 | `check.tcs-13.test.ts` "table output lists the affected row and summary" |
| exit 1 affected, `--json` prints affected | T3 | `check.tcs-13.test.ts` "--json affected exit 1" |
| exit 0 clean | T3 | `check.tcs-13.test.ts` "clean exit 0" |
| exit 2 usage, no lockfile + no runtime | T3 | `check.tcs-13.test.ts` "nothing to check exit 2, 0 fetch calls" |
| NEGATIVE: API failure never reads as clean | T3 | `check.tcs-13.test.ts` "500 and network error exit 3" |
| latest prints one line per event | T4 | `latest.tcs-13.test.ts` "one line per event" |
| latest `--ecosystem`, `--since` | T4 | `latest.tcs-13.test.ts` "query carries ecosystem and since" |
| watch polls every 5 minutes, prints new events | T4 | `latest.tcs-13.test.ts` "watch: 2 polls, sleep(300000), 304 prints nothing, new page printed once" |
| SKILL.md content (session start, deploy, headline; exit codes; JSON) | T5 | `skill.tcs-13.test.ts` asserts the 3 triggers, `exit`, `--json` appear |
| SKILL.md `name` + `description` frontmatter | T5 | `skill.tcs-13.test.ts` |
| Out of scope: Homebrew, Python CLI, Windows service | none | none (nothing built) |

## Acceptance tests
All in the `cli` vitest project (`environment: node`). Every test calls `main(io)` from `packages/cli/src/cli.ts`, the same function `bin/tocsin.js` calls (D2). `fakeIo()` gives each test its own `mkdtemp` HOME and cwd.

`tests/cli/connect.tcs-13.test.ts`
1. "wires claude code and cursor": HOME has `.claude.json` = `{"numStartups":3}` and `.cursor/mcp.json` = `{"mcpServers":{}}`. `main(["connect"])` exit 0. `.claude.json` parses with `numStartups === 3` and `mcpServers.tocsin` = `{type:"http",url:"https://mcp.tocsin.sh/mcp"}`. `.cursor/mcp.json` has `mcpServers.tocsin.url`. `HOME/.claude/skills/tocsin/SKILL.md` equals the repo's `skills/tocsin/SKILL.md` bytes.
2. "second run: already connected, mtime unchanged": after test 1's setup and one run, record `mtimeMs` and bytes of the 3 files, wait 20 ms, run again: output contains `already connected`, all 3 `mtimeMs` and bytes unchanged.
3. "malformed claude.json byte-identical": `.claude.json` = `{"mcpServers": {` (truncated). Run: file bytes identical, mtime unchanged; stdout contains the path to `.claude.json` and a JSON block that parses and has `mcpServers.tocsin.url`; exit 1. Cursor is still wired (one failure does not stop the others).
4. "different tocsin entry left as is": `.claude.json` has `mcpServers.tocsin = {url:"https://other"}`: bytes unchanged, output says `different`.
5. "--cursor touches only cursor": both present; `.claude.json` bytes and mtime unchanged.
6. "--dry-run writes nothing": output contains `would write` and both paths; no file changes; no skill file created.
7. "--print": stdout is one JSON document with `mcpServers.tocsin.url`; HOME tree unchanged.
8. "claude desktop macOS path": `HOME/Library/Application Support/Claude/` exists, no config: config created with `mcpServers.tocsin.args` containing the MCP URL.
9. "codex appends table once": `.codex/config.toml` = `model = "x"\n`: after run it contains `[mcp_servers.tocsin]` once and still starts with `model = "x"`; a second run leaves bytes and mtime unchanged. Negative: a file with `# [mcp_servers.tocsin]` gets the block appended.
10. "no agent tool found": empty HOME, no flags: exit 0, output contains `no agent tool found` and the block, HOME tree still empty.

`tests/cli/check.tcs-13.test.ts`
1. "--json affected exit 1": cwd has `tests/fixtures/cli/package-lock.json` copied in; exec fake: only `node --version` -> `v22.1.0`. Fetch fake answers the multipart POST with `{checked:2, affected:[one item], skipped:[], feed_cursor:7}` and the JSON POST with `{checked:1, affected:[], skipped:[], feed_cursor:5}`. Exit 1. stdout parses as JSON: `affected.length === 1`, `checked === 3`, `feed_cursor === 5`. The fetch fake saw a POST to `/v1/check` with a FormData field named `package-lock.json` whose text equals the fixture, and a POST with body `{"runtimes":{"node":"22.1.0"}}`.
2. "clean exit 0": same, both answers `affected: []`: exit 0; table output contains `No known advisory`.
3. "nothing to check exit 2, 0 fetch calls": empty cwd, every exec ENOENT: exit 2, stderr contains `no lockfile`, fetch call count 0.
4. "table output lists the affected row and summary": no `--json`: stdout contains the package name, version, advisory id and `1 of 3`.
5. "runtime versions parsed from 6 outputs": table over the 6 sample outputs in T3.2 (plus `python` ENOENT then `python3` -> `Python 3.12.1`); JSON body `runtimes` equals the expected map. Negative: `node` exits non-zero -> no `node` key.
6. "500 and network error exit 3": 500 answer -> exit 3, stderr has `check failed`; fetch fake throws -> exit 3. Neither exits 0 or 1.
7. "lockfile matcher": cwd with `package.json`, `requirements.in`, `yarn.lock.bak`, `Cargo.lock`, `requirements-dev.txt`: the multipart has exactly `Cargo.lock` and `requirements-dev.txt`. A drift table asserts the CLI matcher and `src/check/parsers/index.ts:detectParser` agree on 12 names.
8. "base url": env `TOCSIN_BASE_URL` unset -> URL starts `https://tocsin.sh/v1/check`; set to `https://x.test/` -> `https://x.test/v1/check`.

`tests/cli/latest.tcs-13.test.ts`
1. "one line per event": fetch fake answers 3 events (built from `tests/fixtures/advisory/valid.json` with distinct ids). stdout has exactly 3 non-empty lines, each contains its event id; stderr has `next_cursor`.
2. "query carries ecosystem and since": `latest --ecosystem npm --since 40` -> request query has `ecosystem=npm`, `since=40`, `order=desc`.
3. "bad since exit 2": `--since abc` -> exit 2, 0 fetch calls.
4. "api key header": `TOCSIN_API_KEY=tcs_test` -> `Authorization: Bearer tcs_test`; unset -> no Authorization header; the key never appears in stdout/stderr.
5. "watch": `io` has `maxPolls: 3` (test-only stop) and a recording sleep. Answers: start probe `next_cursor:10`; poll 1 200 with 2 events, `next_cursor:12`, ETag `"a"`; poll 2 304; poll 3 200 with 1 event. stdout has 3 lines; poll 2 sent `If-None-Match: "a"`; poll 3 sent `since=12`; every sleep call was `300000`.

`tests/cli/skill.tcs-13.test.ts`
1. `skills/tocsin/SKILL.md` starts with `---`, the frontmatter has non-empty `name` and `description`.
2. The body contains `npx tocsin check`, `session start`, `deploy`, `headline`, `--json`, and the exit codes `0`, `1`, `2`, `3`.
3. `packages/cli/package.json`: `name === "tocsin"`, `bin.tocsin === "bin/tocsin.js"`, no runtime `dependencies`.

Mutation checks the builder runs once (D1): make `connect` always write -> test 2 goes red; make `check` return 0 on a 500 -> test 6 red; drop the `--json` branch -> check test 1 red; remove the sleep -> watch test red.

Suites at regression risk: `tests/mcp/*.test.ts` and every `api` project suite (the `vitest.config.ts` edit). Proof: `npm test` runs all three projects green, with the same `api` and `mcp` test counts as main.

## QA screens
No web screen. Terminal QA (as shipped, D7):
1. `cd packages/cli && npm run build && node bin/tocsin.js --help`: usage, exit 0.
2. `HOME=$(mktemp -d) node bin/tocsin.js connect --print`: one JSON block.
3. `HOME=$(mktemp -d) node bin/tocsin.js connect --claude-code` twice: first `connected`, second `already connected`.
4. `[NOTE] not verified here`: `check`, `latest`, `watch` against prod `https://tocsin.sh` (prod may not serve the API yet; the tests use the fetch fake).

## Failure modes
This plan changes no path under `bin/` or `worker/` of board-harness (`packages/cli/bin/tocsin.js` is a package bin, not a harness path). Section kept short:
- Decision rule: the "already connected" and lockfile matchers. Tables in System invariants (c). Test: connect tests 2, 4, 9; check test 7.
- Exit paths: check 0/1/2/3, connect 0/1/2. Test: check tests 1-3, 6; connect tests 3, 10.
- Writer/reader round-trip: connect writes JSON and TOML that connect itself reads on the next run. Test: connect tests 2 and 9.
- Alert or freeze blast radius: n/a. No alert or freeze.
- Defaults in prod: `TOCSIN_BASE_URL` default `https://tocsin.sh`, `TOCSIN_MCP_URL` default `https://mcp.tocsin.sh/mcp`, poll 300 s. Test: check test 8, watch test.
- Status evidence: `connected` prints only after the rename returns. Test: connect test 1 reads the file back.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section
npm publish <- operator step: cd packages/cli && npm publish (needs the npm account)
```

## Design collision check (BH-5791)

Checked 9 listed and 0 derived symbols against main be088aa76a8f..be088aa76a8f and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 14
LINES: 780
DIFF_KB: 70

KIND: feature
SIZE: L
