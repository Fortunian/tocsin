# Feed API: events with cursor, filters, ETag, discovery files

Blocked-by: #1 (hard)

## Scope
- `GET /v1/events?since=<cursor>&ecosystem=<csv>&component=<csv>&min_severity=<label>&exploited=true&limit=<1..100>`. Returns `{ events: Advisory[], next_cursor, has_more }` ordered by cursor ascending. Default limit 50, cap 100. Strong `ETag` derived from `(max cursor in page, filters)`; `If-None-Match` match returns 304. `Cache-Control: public, max-age=60`.
- `GET /v1/events/:id` returns one advisory, 404 as JSON `{error}`.
- `GET /v1/events/cve/:cve` resolves a CVE to its advisory.
- `GET /.well-known/tocsin.json`: `{ schema: "https://tocsin.sh/schema/advisory.v1.json", endpoints: {...}, mcp: "https://mcp.tocsin.sh", docs: "https://tocsin.sh/docs" }`.
- `GET /llms.txt`: a short plain-text guide for agents (what the feed is, the curl line, the cursor rule, the check endpoint once it exists).
- `GET /schema/advisory.v1.json` serves the schema file.
- All responses `application/json; charset=utf-8`, CORS `*` on GET.
- Rate limit anonymous reads at 60 requests per minute per IP with a KV counter; 429 with `Retry-After`.

## Acceptance tests
- `tests/routes/events.test.ts`: seed 150 advisories; `limit=100` returns 100 with `has_more=true`; `since=next_cursor` returns the remaining 50 and `has_more=false`; `ecosystem=node` returns only node; `min_severity=high` excludes medium and low; `exploited=true` returns only exploited; `limit=500` is clamped to 100; the second identical request with `If-None-Match` returns 304.
- `tests/routes/events-plan.test.ts`: `EXPLAIN QUERY PLAN` for the filtered query with `ecosystem` and `cursor` uses `advisories(ecosystem, cursor)`.
- `tests/routes/discovery.test.ts`: well-known JSON validates against `schema/well-known.v1.json`; `llms.txt` is served as `text/plain` and contains the string `since=`.
- `tests/routes/ratelimit.test.ts`: the 61st request in a minute from one IP returns 429.

## Out of scope
Authentication, watch lists, webhooks, the check endpoint.
