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

The CLI exits 1 when something is affected, 0 when clean, 2 on a usage error and 3 when the check could not run. `--json` prints one document an agent can read. Flags, exit codes and env vars: `packages/cli/README.md`.

The schema every advisory follows: https://tocsin.sh/schema/advisory.v1.json (source: `schema/advisory.v1.json`). API reference: https://tocsin.sh/docs (source: `docs/API.md`). Source health: https://tocsin.sh/status (JSON at `/v1/status`).

## Built with Cromford

[Cromford](https://cromford.dev) is an open-source software factory: tickets in, reviewed and merged changes out. The engine is public at https://github.com/cromford-ai/cromford.

This repo is a Cromford case study. After the plan commit, every change came in through a pull request that Cromford planned, built, reviewed and merged, one ticket at a time. Each PR title carries its ticket key (`TCS-1`, `TCS-2` and on), and each PR body holds the plan, the assumptions and the verification evidence. The merged PRs are the record: https://github.com/Fortunian/tocsin/pulls?q=is%3Apr+is%3Amerged

Want a source Tocsin does not cover yet? Open an issue.

## Self-host

Tocsin runs on Cloudflare Workers with D1, KV and Queues. Fork the repo, create the resources below, and a push to `main` deploys.

1. Run `wrangler d1 create tocsin` and put the id in `wrangler.toml` (`database_id`).
2. Run `wrangler kv namespace create CURSORS` and put the id in `wrangler.toml` (`[[kv_namespaces]] id`).
3. Run `wrangler queues create deliveries`.
4. Change the two `routes` custom domains in `wrangler.toml` and `workers/mcp/wrangler.toml` to your own zone. Cloudflare creates the DNS records on deploy.
5. Add the repo secret `CLOUDFLARE_API_TOKEN` and the repo variables `CLOUDFLARE_ACCOUNT_ID` and `DEPLOY_ENABLED=1`.

The deploy job applies the D1 migrations (`wrangler d1 migrations apply DB --remote`), deploys the main worker, then deploys the MCP worker (`wrangler deploy -c workers/mcp/wrangler.toml`). The optional secret `NVD_API_KEY` raises the NVD rate limit.

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
- `skills/tocsin/SKILL.md` the agent skill that `connect` installs.
- `site/` the landing, docs and status pages. Any request to `tocsin.so` answers 301 to the same path on `tocsin.sh`.
- `tests/e2e/site.spec.ts` the browser test. It is not part of `npm test`: `npx playwright install chromium && npm run test:e2e`.

## License

Apache-2.0.
