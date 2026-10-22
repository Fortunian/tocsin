# Tocsin

Security advisories, built for agents.

One normalized feed of runtime and package security advisories. An agent subscribes in one call, asks "am I affected?" with its lockfile, and gets a one-line action with the fixed version.

The planned interface (not live yet):

```
curl "https://tocsin.sh/v1/events?since=0&ecosystem=node,npm&min_severity=high"
curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"
npx tocsin check
```

Status: scaffold. Only `GET /v1/health` is live in code. See `docs/PLAN_2026-10-21.html` and `docs/tickets/`.

## Run locally

Needs Node 22.

```
npm install
npm run migrate:local
npm run dev
curl localhost:8787/v1/health
npm test
```

`npm run typecheck` runs `tsc --noEmit`. The advisory schema lives in `schema/advisory.v1.json`. After you edit it, run `npm run gen:schema` to rebuild the validator; CI fails if the committed validator is stale (`npm run gen:schema -- --check`).

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

Apache-2.0. The hosted service runs at https://tocsin.sh.
