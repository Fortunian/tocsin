# Tocsin

**Security advisories, built for agents.**

Your agent's `fetch()` was exploitable on October 21, 2026, and nothing told it. PHP shipped two remote code execution fixes the same day. Tocsin is the feed that tells your agent, in one shape, with the fixed version and a one-line action.

Hosted, free, no account: https://tocsin.sh

## What you get

- **One feed.** Every advisory from OSV (npm, PyPI, Go, Packagist, crates.io, RubyGems), the Node.js and PHP runtime security releases, NVD severity, the CISA KEV exploited flag and the EPSS score, normalized to one open schema. New advisories land within 10 minutes.
- **One question.** `POST /v1/check` takes your lockfile or your runtime versions and answers "am I affected?" with the first fixed version and what to do.
- **One command.** `npx tocsin connect` wires Claude Code, Cursor, Claude Desktop and Codex to the feed, with a skill that runs the check at session start and before a deploy.
- **A remote MCP server** at https://mcp.tocsin.sh/mcp, so any agent can ask without a CLI.
- **No LLM in the request path.** Every answer is a database read. Cursor and ETag on the feed, so an agent polls for free.

## Quick start

```
npx tocsin connect                                    # wire your agent tools
npx tocsin check                                      # check this project's lockfiles and runtimes
curl "https://tocsin.sh/v1/events?since=0&min_severity=high"
curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"
```

The CLI exits 1 when something is affected, 0 when clean, 2 on a usage error and 3 when the check could not run or a checked ecosystem has partial coverage. `--json` prints one document an agent can read. Flags, exit codes and env vars: `packages/cli/README.md`.

The schema every advisory follows: https://tocsin.sh/schema/advisory.v1.json (source: `schema/advisory.v1.json`). API reference: https://tocsin.sh/docs (source: `docs/API.md`). Source health: https://tocsin.sh/status (JSON at `/v1/status`).

## Codex

```
npx tocsin connect --codex
```

This adds the MCP server to `~/.codex/config.toml` and the Tocsin skill to `~/.codex/skills/tocsin/SKILL.md`. Codex also reads `AGENTS.md` in a repo. `npx tocsin connect --print-agents-md` prints this block for it:

```
## Security advisories (Tocsin)

At session start and before a deploy, run `npx tocsin check --json`.
Exit 1: a dependency has an advisory. Read `affected[]` and upgrade to `fixed_in`.
Exit 3: the check failed. Do not report the project as safe.
Docs: https://tocsin.sh/docs
```

In Claude Code, `npx tocsin connect --claude-code --hook` adds a `SessionStart` hook that runs the check and prints one line when a session starts.

## In CI

The GitHub Action runs the same check on every pull request. It fails the job when a lockfile dependency has a known advisory, writes a job summary, and posts one PR comment (updated on each push) with the fixed version, the action and the upgrade command. Add these 6 lines as `.github/workflows/tocsin.yml`:

```yaml
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  check:
    runs-on: ubuntu-latest
    steps: [{ uses: actions/checkout@v4 }, { uses: Fortunian/tocsin/action@v1 }]
```

Inputs (all optional): `min-severity` (default `low`), `fail-on` (`affected`, `exploited` or `never`; default `affected`), `fail-on-error` (default `false`: a network or API error is a warning, never a pass), `comment` (default `true`), `working-directory` (default `.`), `base-url` (default `https://tocsin.sh`), `max-body-bytes` (default `2097152`, the 2 MB body limit of the hosted API), `api-key` and `github-token`. The output `affected` holds the count. The Action finds the same lockfiles as `tocsin check` and needs no npm install. It needs Node 20 or later on the runner (GitHub-hosted runners have it).

The Action sends at most 2 MB of lockfiles in one check. It skips a file that does not fit, writes a warning that names the file, and lists the file as not checked. The PR comment comes from the token's own account, and the Action updates only its own comment.

Badge for your README (the standard Actions badge):

```markdown
[![tocsin](https://github.com/<owner>/<repo>/actions/workflows/tocsin.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/tocsin.yml)
```

## Built with Cromford

[Cromford](https://cromford.dev) is an open-source software factory: tickets in, reviewed and merged changes out. The engine is public at https://github.com/cromford-ai/cromford.

This repo is a Cromford case study. After the plan commit, every change came in through a pull request that Cromford planned, built, reviewed and merged, one ticket at a time. Each PR title carries its ticket key (`TCS-1`, `TCS-2` and on), and each PR body holds the plan, the assumptions and the verification evidence. The merged PRs are the record: https://github.com/Fortunian/tocsin/pulls?q=is%3Apr+is%3Amerged

Want a source Tocsin does not cover yet? Open an issue.

## Self-host

Tocsin runs on Cloudflare Workers with D1, KV and Queues. Fork the repo, create the resources below, and a push to `main` deploys.

1. Run `wrangler d1 create tocsin` and put the id in `wrangler.toml` (`database_id`).
2. Run `wrangler kv namespace create CURSORS` and put the id in `wrangler.toml` (`[[kv_namespaces]] id`).
3. Run `wrangler queues create deliveries`. The deploy job creates the dead-letter queue `deliveries-dlq` when it is missing.
4. Change `account_id` and the `routes` custom domain in `wrangler.toml` and `workers/mcp/wrangler.toml` to your own account and zone. Cloudflare creates the DNS records on deploy.
5. Add the repo secret `CLOUDFLARE_API_TOKEN` and the repo variables `CLOUDFLARE_ACCOUNT_ID` and `DEPLOY_ENABLED=1`.

The deploy job applies the D1 migrations (`wrangler d1 migrations apply DB --remote`), deploys the main worker, then deploys the MCP worker (`wrangler deploy -c workers/mcp/wrangler.toml`). The optional secret `NVD_API_KEY` raises the NVD rate limit.

API key sign-up mails a link. The one-time mail setup (secret, DNS records, settings rows and a launch check) is in [docs/OPERATING.md](docs/OPERATING.md).

## Run locally

Needs Node 22.

```
npm install
npm run migrate:local
npm run dev
curl localhost:8787/v1/health
npm test
```

`npm run typecheck` runs `tsc --noEmit`. After you edit `schema/advisory.v1.json`, run `npm run gen:schema`; after you edit `docs/API.md`, run `npm run gen:docs`. CI fails when either generated file is stale.

## Layout

- `src/` the main worker: feed, check, status, site routes, cron ingest (`src/ingest/` holds one file per source).
- `workers/mcp/` the remote MCP server. Tools: `tocsin_latest`, `tocsin_check`, `tocsin_get`, `tocsin_watchlist_events`. Run it locally with `npx wrangler dev -c workers/mcp/wrangler.toml`.
- `packages/cli/` the `tocsin` npm package (Node 20+, no runtime dependencies).
- `action/` the GitHub Action (`Fortunian/tocsin/action@v1`). `.github/workflows/release.yml` moves the `v1` tag (manual dispatch).
- `skills/tocsin/SKILL.md` the agent skill that `connect` installs.
- `site/` the landing, docs and status pages. Any request to `tocsin.so` answers 301 to the same path on `tocsin.sh`.
- `tests/e2e/site.spec.ts` the browser test. It is not part of `npm test`: `npx playwright install chromium && npm run test:e2e`.

## Directories

- MCP registry: `sh.tocsin/tocsin`, from `mcp/server.json` (remote `https://mcp.tocsin.sh/mcp`, streamable HTTP, no auth). Publish it by hand: Actions > publish-mcp-registry > Run workflow. The workflow validates the file, logs in with DNS proof of `tocsin.sh` and publishes.
  Operator setup, once:
  1. Make an Ed25519 key: `openssl genpkey -algorithm Ed25519 -out key.pem`.
  2. Get the public key: `openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64`.
  3. Add a TXT record on `tocsin.sh`: `v=MCPv1; k=ed25519; p=<public key>`.
  4. Get the private key in hex: `openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'`.
  5. Set it as the repo secret `MCP_REGISTRY_DNS_KEY`.
- Smithery: not listed yet. `smithery.yaml` holds the server name. List it with `npx @smithery/cli mcp publish https://mcp.tocsin.sh/mcp -n <namespace>/tocsin`.
- Cursor and VS Code: the landing and docs pages have "Add to Cursor" and "Add to VS Code" links. They carry the same config that `npx tocsin connect --print` prints.

## License

Apache-2.0.
