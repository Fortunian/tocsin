# tocsin

Security advisories, built for agents. This CLI wires the Tocsin MCP server into your agent tools
and checks a project for known advisories. Node 20 or later. No runtime dependencies.

## Commands

### `npx tocsin connect`

Finds the agent tools on this machine and adds the `tocsin` MCP server
(`https://mcp.tocsin.sh/mcp`) to each one:

| Tool | Found when | File it edits |
|---|---|---|
| Claude Code | `~/.claude.json` or `~/.claude/` exists | `~/.claude.json` (`mcpServers.tocsin`), plus the skill at `~/.claude/skills/tocsin/SKILL.md` |
| Cursor | `~/.cursor/` exists | `~/.cursor/mcp.json` (`mcpServers.tocsin`) |
| Claude Desktop | `~/Library/Application Support/Claude/` (macOS) or `%APPDATA%\Claude\` (Windows) exists | `claude_desktop_config.json` in that folder (through `npx -y mcp-remote`) |
| Codex | `~/.codex/` exists | `~/.codex/config.toml` (`[mcp_servers.tocsin]`), plus the skill at `~/.codex/skills/tocsin/SKILL.md` |

Cursor also gets the skill as a rule at `~/.cursor/rules/tocsin.mdc` (`description` and
`alwaysApply: false` frontmatter). The Codex skill and the Cursor rule are generated from
`skills/tocsin/SKILL.md` (`npm run gen:skills`). Connect never replaces a Codex skill or a Cursor
rule that differs from ours: it prints the path and leaves the file as is.

Flags:

- `--claude-code`, `--cursor`, `--claude-desktop`, `--codex`: wire only these tools. With a flag,
  connect creates the config file when it does not exist.
- `--dry-run`: print the edits. Write nothing.
- `--print`: print the MCP JSON block only. Touch nothing.
- `--hook`: with Claude Code, also add a `SessionStart` hook to `~/.claude/settings.json`. The
  hook runs `npx -y tocsin check --summary` when a session starts. Without `--hook`, connect does
  not read or write `settings.json`. A `settings.json` that connect cannot parse is left as is, and
  connect prints the hook block for you to add by hand.
- `--print-agents-md`: print a 6-line block for a repo's `AGENTS.md` (Codex reads it). Write nothing.

A second run changes nothing and says `already connected`. Connect never writes a file it cannot
parse, and never replaces a `tocsin` entry that is already there with a different value: it prints
the path and the block for you to add by hand. Connect does not write `TOCSIN_API_KEY` into any
file. Close Claude Code before you run connect: Claude Code also writes `~/.claude.json` and
`~/.claude/settings.json`.

### `npx tocsin check`

Reads the lockfiles at the top of the current directory (`package-lock.json`,
`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`, `requirements-*.txt`,
`go.sum`, `composer.lock`, `Cargo.lock`, `Gemfile.lock`) and the installed versions of `node`, `php`,
`python` (or `python3`), `go`, `bun` and `deno`. It sends them to `POST /v1/check` and prints a
table. `--json` prints the result as one JSON document: `{ checked, affected, skipped, feed_cursor }`.

`--summary` prints one line, for example `tocsin: 2 affected of 10 checked, 1 exploited (exit 1)`,
and always exits 0. The line names the real exit code. When the API call fails it prints
`tocsin: check failed (network)`. The `--hook` SessionStart hook uses it, so a check never blocks a
session.

### `npx tocsin latest [--ecosystem x] [--since cursor] [--limit n]`

Prints the newest advisories, one per line, newest first (default 20, max 100). The next cursor
goes to stderr. `--json` prints the raw API page.

### `npx tocsin watch [--ecosystem x] [--since cursor]`

Polls the feed every 5 minutes and prints each new advisory. Without `--since` it starts at the
newest advisory. Press Ctrl-C to stop it.

## Exit codes

| Code | `check` | `connect` | `latest` / `watch` |
|---|---|---|---|
| 0 | clean | every tool connected or already connected | ok |
| 1 | one or more dependencies affected | a file could not be read, parsed or written | |
| 2 | usage error, or no lockfile and no runtime | usage error | usage error |
| 3 | the API call failed, or nothing is affected but a checked ecosystem has partial coverage (neither is a clean result) | | the API call failed (`latest`) |

`watch` keeps polling after an API error. It prints one line on stderr per error.

## Environment

- `TOCSIN_BASE_URL`: the API host. Default `https://tocsin.sh`.
- `TOCSIN_API_KEY`: optional. Sent as `Authorization: Bearer <key>`. Never printed.
- `TOCSIN_MCP_URL`: the MCP server URL that connect writes. Default `https://mcp.tocsin.sh/mcp`.

Apache-2.0. Source: https://github.com/Fortunian/tocsin
