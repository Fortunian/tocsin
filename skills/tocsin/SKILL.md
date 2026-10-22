---
name: tocsin
description: Check a project's dependencies and runtimes for known security advisories with the Tocsin CLI, and read the result.
---

# Tocsin

Tocsin is one feed of security advisories for packages and runtimes. The `tocsin` CLI checks the
current project against it.

## When to run it

Run `npx tocsin check --json` in the project directory:

- at session start, in any repo that has a lockfile (`package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `requirements.txt`, `go.sum`, `composer.lock`, `Cargo.lock`, `Gemfile.lock`);
- before a deploy;
- when a security headline appears (a new CVE, a runtime release with security fixes).

The command reads the lockfiles at the top of the current directory and the installed versions
of `node`, `php`, `python`, `go`, `bun` and `deno`. It sends them to the Tocsin API.

## Exit codes

- `0`: clean. No known advisory affects the checked dependencies.
- `1`: affected. One or more dependencies have an advisory. Read `affected`.
- `2`: usage error. Wrong directory, or nothing to check (no lockfile and no runtime).
- `3`: the check could not run (network error or an API error). This is NOT a clean result.
  Tell the user the check failed. Do not report the project as safe.

## How to read the JSON

`npx tocsin check --json` prints one JSON document:

- `checked`: how many dependencies the API checked.
- `affected[]`: one item per dependency and advisory, worst first. Each item has
  `dependency` (`ecosystem`, `name`, `version`), `advisory_id`, `cve_ids`, `severity.label`
  (`critical`, `high`, `medium`, `low`, `unknown`), `exploited` (known to be used in attacks),
  `fixed_in` (the first fixed version, or null), `action` (one line: what to do) and `url`
  (the source advisory).
- `skipped[]`: dependencies the API could not check, with a `reason`. A skipped dependency is
  never clean. Tell the user which ones were skipped.
- `feed_cursor`: the feed position at check time. To see advisories published after the check,
  run `npx tocsin latest --since <feed_cursor>`.

## What to do with the result

1. Tell the user about `exploited` items and `critical` items first.
2. For each affected item, upgrade to `fixed_in` when it is present. Else follow `action`.
3. Cite the `url` of each advisory you act on. Do not guess facts the advisory does not state.
4. After an upgrade, run `npx tocsin check --json` again and confirm the item is gone.

## Other commands

- `npx tocsin latest [--ecosystem npm] [--since <cursor>]`: the newest advisories, one per line.
- `npx tocsin watch`: print new advisories as they arrive (polls every 5 minutes).
- `npx tocsin connect`: add the Tocsin MCP server to Claude Code, Cursor, Claude Desktop and Codex.

`TOCSIN_API_KEY` (optional) is sent as a Bearer token. `TOCSIN_BASE_URL` points the CLI at
another Tocsin host (default `https://tocsin.sh`).
