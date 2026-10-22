# CLI `tocsin`: connect, check, latest, watch; plus the Claude Code skill

Blocked-by: #6c (hard)

## Scope
`packages/cli/` published to npm as `tocsin` (name confirmed free on 2026-10-21). Zero runtime dependencies beyond Node 20 built-ins where possible. `TOCSIN_BASE_URL` (default `https://tocsin.sh`) and `TOCSIN_API_KEY` env vars.

- `npx tocsin connect` is the one command the site leads with. It detects the agent tools present on the machine and wires each one in one run: Claude Code (adds the `tocsin` MCP server to `~/.claude.json` under `mcpServers` and installs `skills/tocsin/SKILL.md` into `~/.claude/skills/tocsin/`), Cursor (`~/.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json` on macOS and Windows paths), Codex (`~/.codex/config.toml`). Flags `--claude-code`, `--cursor`, `--claude-desktop`, `--codex` limit it to one; `--dry-run` prints the edits; `--print` prints the MCP JSON block only. Idempotent: a second run changes nothing and says so. Never overwrites a file it cannot parse; it prints the block and the path instead.
- `npx tocsin check`: finds lockfiles in cwd, detects `node --version`, `php --version`, `python --version`, `go version`, `bun --version`, `deno --version` when present, POSTs to `/v1/check`, prints a table, exits 1 when anything is affected, 0 when clean, 2 on usage error. `--json` for machine output.
- `npx tocsin latest [--ecosystem x] [--since cursor]` and `npx tocsin watch` (polls every 5 minutes, prints new events).
- `skills/tocsin/SKILL.md`: tells the agent to run `npx tocsin check` at session start in any repo with a lockfile, before a deploy, and when a security headline appears, and how to read the exit code and JSON.

## Acceptance tests
- `tests/cli/connect.test.ts`: with `HOME` pointed at a temp dir containing a fake `~/.claude.json` and `~/.cursor/mcp.json`, `tocsin connect` adds the `tocsin` server to both, installs the skill file, and a second run reports "already connected" with zero file writes (assert mtime unchanged); a malformed `~/.claude.json` is left byte-identical and the output contains the JSON block and the path.
- `tests/cli/check.test.ts`: with a `package-lock.json` fixture and the API mocked, `--json` prints the affected list and exits 1; a clean lockfile exits 0; no lockfile and no runtimes exits 2 with a usage hint.
- `tests/cli/latest.test.ts`: prints one line per event in the mocked response.
- The skill file has `name` and `description` frontmatter.

## Out of scope
Homebrew formula, a Python CLI, Windows service install.
