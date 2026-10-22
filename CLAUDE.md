# Tocsin

Security advisories, built for agents. One normalized feed of runtime and package
advisories that an agent can subscribe to in one call and act on without a human.

Domains: tocsin.sh (hosted service and site), tocsin.so (alias, redirects to tocsin.sh).
Cloudflare account: liorwn@gmail.com (account id 11b818a4b2a98b4b5012359edb39cae8).
Repo: Fortunian/tocsin. License: Apache-2.0. The engine, the schema, the ingesters,
the MCP server, the CLI and the skill are open source. The hosted service is the business.

## Stack

- Cloudflare Workers + Hono (TypeScript). One worker, routes under `src/routes/`.
- D1 for advisories, sources, watch lists, API keys, deliveries. Migrations in `migrations/`.
- KV for ingest cursors and feed ETags. Queues for webhook delivery. Cron Triggers for ingestion.
- Vitest with `@cloudflare/vitest-pool-workers`. Fixtures in `tests/fixtures/<source>/`.
- No LLM in the request path. Summaries and actions are deterministic from the advisory data.

## Iron rules

1. Additive-only schema. Never drop or rename a column in a migration.
2. Every table ships with its indexes and a retention rule. Every query on a new table has an `EXPLAIN QUERY PLAN` proof in its ticket's tests.
3. Ingestion is idempotent on `(source, source_id)`. Re-running a cron never creates a duplicate.
4. Delivery is exactly-once on `(watchlist_id, advisory_id)`. A retry never re-sends a delivered event.
5. Sources, limits and plans are DB rows. A constant in code is a documented fallback only.
6. Deterministic before LLM. If a field can be computed from the data, compute it.
7. Dedup before spend. Any metered call (NVD, LLM, email) checks the persisted record first.
8. Feed reads are cheap: cursor pagination, page cap 100, ETag with 304, no unbounded scans.
9. No secrets in the repo. `.env.example` lists every variable. Real values live in wrangler secrets.
10. Advisory text that we publish is a fact from a source with a link, never a guess.

## Verification contract

```
npm test            # vitest, all suites
npm run typecheck   # tsc --noEmit
npm run migrate:local
npm run dev         # wrangler dev
```

A ticket is done when its acceptance tests fail before the change and pass after it.

## Naming

- An **advisory** is one normalized record (one CVE or one vendor advisory). Table `advisories`.
- A **source** is one ingester (osv, nvd, kev, epss, node-runtime, php-runtime). Table `sources`.
- A **watch list** is one subscription: ecosystems, packages, runtimes, min severity, delivery mode.
- An **event** is one advisory as seen through the feed with a cursor. The feed emits events.
- An **ecosystem** is an OSV ecosystem name (`npm`, `PyPI`, `Go`, `Packagist`, `crates.io`) or a runtime name (`node`, `php`, `python`, `go`, `deno`, `bun`).
