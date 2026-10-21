# CLI `tocsin` and the Claude Code skill

Blocked-by: #6c (hard)

## Scope
- `packages/cli/` published to npm as `tocsin` (name confirmed free on 2026-10-21). Commands: `tocsin check` (finds lockfiles in cwd, detects `node --version`, `php --version`, `python --version`, `go version` when present, POSTs to `/v1/check`, prints a table and exits 1 when anything is affected, `--json` for machine output), `tocsin latest [--ecosystem x] [--since cursor]`, `tocsin watch` (polls every 5 minutes, prints new events). `TOCSIN_BASE_URL` and `TOCSIN_API_KEY` env vars.
- `skills/tocsin/SKILL.md`: a Claude Code skill that tells the agent when to run `npx tocsin check` (session start in any repo with a lockfile, before a deploy, when a security headline appears) and how to read the exit code and JSON.
- `README.md` section "For agents" with the three lines an agent needs.

## Acceptance tests
- `tests/cli/check.test.ts`: in a temp dir with a `package-lock.json` fixture and the API mocked, `tocsin check --json` prints the affected list and exits 1; with a clean lockfile exits 0; with no lockfile and no runtimes prints a usage hint and exits 2.
- `tests/cli/latest.test.ts`: prints one line per event in the mocked response.
- The skill file passes `npx @anthropic-ai/skill-lint` or, if that tool is absent, a test that the frontmatter has `name` and `description`.

## Out of scope
Homebrew formula, a Python CLI.
