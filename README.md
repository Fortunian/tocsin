# Tocsin

Security advisories, built for agents.

One normalized feed of runtime and package security advisories. An agent subscribes in one call, asks "am I affected?" with its versions or lockfile, and gets a one-line action with the fixed version.

The three lines an agent needs:

```
curl "https://tocsin.sh/v1/events?since=0&ecosystem=node,npm&min_severity=high"
curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"
https://mcp.tocsin.sh/mcp
```

The first is the feed: new advisories after a cursor. The second answers "am I affected?" for runtime versions. The third is the remote MCP server.

Connect your agent tools (Claude Code, Cursor, Claude Desktop, Codex) in one run:

```
npx tocsin connect
```

Every advisory has one shape, the open schema at https://tocsin.sh/schema/advisory.v1.json (source: `schema/advisory.v1.json`).
Live status of each source: https://tocsin.sh/status (JSON at `/v1/status`). API reference: `docs/API.md`, served at https://tocsin.sh/docs.

Self-host on your own Cloudflare account: `npm install && npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`. Create the Cloudflare resources first (see "Deploy" below).

Launch check: `bash scripts/launch-check.sh` reads https://tocsin.sh and exits 1 if a real advisory, the check endpoint, a source or `npx tocsin@latest connect` is wrong. The script header lists its checks and env vars.

## Run locally

Needs Node 22.

```
npm install
npm run migrate:local
npm run dev
curl localhost:8787/v1/health
npm test
```

`npm test` includes the `launch` project, which runs `scripts/launch-check.sh` against the worker in Miniflare; it needs `bash`, `curl` and `jq` on PATH. `npm run typecheck` runs `tsc --noEmit`. The advisory schema lives in `schema/advisory.v1.json`. After you edit it, run `npm run gen:schema` to rebuild the validator; CI fails if the committed validator is stale (`npm run gen:schema -- --check`).

## Deploy

CI deploys on a push to `main` only when the repo variable `DEPLOY_ENABLED` is `1`. Before you set it:

1. Run `wrangler d1 create tocsin` and put the id in `wrangler.toml` (`database_id`).
2. Run `wrangler kv namespace create CURSORS` and put the id in `wrangler.toml` (`[[kv_namespaces]] id`).
3. Run `wrangler queues create deliveries`.
4. Add the repo secret `CLOUDFLARE_API_TOKEN` and the repo variable `CLOUDFLARE_ACCOUNT_ID`.
5. Set the repo variable `DEPLOY_ENABLED=1`.

The deploy job applies D1 migrations (`wrangler d1 migrations apply DB --remote`) before `wrangler deploy`.
It then deploys the MCP worker (`wrangler deploy -c workers/mcp/wrangler.toml`).

## MCP server

`workers/mcp/` is a second worker: a remote MCP server (streamable HTTP) at https://mcp.tocsin.sh/mcp.
It reads the public Tocsin API over HTTP and has no D1 binding. `TOCSIN_BASE_URL` (a `[vars]` entry in
`workers/mcp/wrangler.toml`, default `https://tocsin.sh`) points it at any Tocsin host.

Tools: `tocsin_latest`, `tocsin_check`, `tocsin_get`, `tocsin_watchlist_events`. Each result is
`{ "human": <one line>, "data": <the API answer> }`. `tocsin_watchlist_events` sends the
`Authorization: Bearer <key>` header of the MCP session's initialize request to the API.

Run it locally: `npx wrangler dev -c workers/mcp/wrangler.toml`.

Before the first deploy, an operator adds a proxied DNS record for `mcp.tocsin.sh` in the `tocsin.sh`
zone (for example `AAAA mcp 100::`), so the route `mcp.tocsin.sh/*` receives traffic.

## CLI

`packages/cli/` is the `tocsin` npm package (Node 20+, no runtime dependencies).

```
npx tocsin connect   # add the Tocsin MCP server to Claude Code, Cursor, Claude Desktop and Codex
npx tocsin check     # check the lockfiles in this directory and the installed runtimes
npx tocsin latest    # the newest advisories, one per line
npx tocsin watch     # print new advisories every 5 minutes
```

`skills/tocsin/SKILL.md` is the Claude Code skill. `connect` installs it, and the package ships a copy.
See `packages/cli/README.md` for flags, exit codes and env vars.

## Site

`GET /` (landing), `/docs` and `/status` are HTML pages the main worker renders (`src/routes/site.ts`, templates in `site/`).
`/docs` comes from `docs/API.md`: after you edit it, run `npm run gen:docs`; CI fails if `site/docs.generated.ts` is stale
(`npm run gen:docs -- --check`). Any request to `tocsin.so` or `www.tocsin.so` answers 301 to the same path on `tocsin.sh`.

The browser test (`tests/e2e/site.spec.ts`) is not part of `npm test` or CI. Run it locally:

```
npx playwright install chromium
npm run test:e2e
```

## Built with

Built with [Cromford](https://cromford.ai). The Cromford factory planned, built, reviewed and merged this repo, one ticket at a time.

## How it was built

After the plan commits, every change came in through a pull request, and every PR title carries its ticket key (`TCS-1`, `TCS-2` and on). The merged PRs are the record: https://github.com/Fortunian/tocsin/pulls?q=is%3Apr+is%3Amerged.

Apache-2.0. The hosted service runs at https://tocsin.sh.
