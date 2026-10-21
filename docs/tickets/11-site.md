# tocsin.sh site: landing, docs, status

Blocked-by: #5 (hard)

## Scope
- Static site in `site/` served by the main worker at `tocsin.sh/` (Workers static assets). Single page landing with the curl line above the fold, the live latest 10 events rendered from `/v1/events?limit=10` (server-side in the worker, cached 60 seconds), the three integration blocks (curl, MCP config, `npx tocsin check`), the free and pro tiers, and the open-source link.
- `/docs`: one page generated from `docs/API.md` (endpoints, schema, cursor rule, rate limits, webhook signature).
- `/status`: per-source `last_ok_at` and `last_error` from the `sources` table, plus the newest cursor. This page is also JSON at `/v1/status`.
- `tocsin.so` redirects 301 to `tocsin.sh` with the path preserved.
- Mobile at 375px with no horizontal scroll. No external assets, fonts self-hosted or system.

## Acceptance tests
- `tests/routes/site.test.ts`: `GET /` returns 200 HTML containing `curl https://tocsin.sh/v1/events`; `GET /status` lists every enabled source; `GET /v1/status` is JSON with `sources[]` and `cursor`; a request with host `tocsin.so` returns 301 to `https://tocsin.sh/<path>`.
- Playwright `tests/e2e/site.spec.ts`: landing renders at 1440 and 375 with `document.documentElement.scrollWidth <= window.innerWidth`.

## QA screens
`/`, `/docs`, `/status`.

## Out of scope
Sign-up UI, dashboard, billing pages.
