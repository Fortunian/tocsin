# Watch lists and API keys (free tier limits)

Blocked-by: #5 (hard)

## Scope
- `migrations/0003_watchlists.sql`: `api_keys(id TEXT PK, key_hash TEXT UNIQUE, plan TEXT, email, created_at, last_used_at)`, `plans(id TEXT PK, max_watchlists INT, webhooks INT, max_components INT)` seeded with `free (5, 0, 200)` and `pro (1000, 1, 100000)`, `watchlists(id TEXT PK, key_id, name, filter_json, cursor INTEGER, delivery TEXT, webhook_url, webhook_secret, created_at)`. Indexes `watchlists(key_id)`, `api_keys(key_hash)`. Retention: a key unused for 365 days and its watch lists are deleted by a monthly cron (`docs/RETENTION.md`).
- `POST /v1/keys` with `{email}` issues a key once per email (idempotent: a second call for the same email returns 409 with no new key), returns the plaintext key once. Store sha256 only.
- Auth middleware `src/middleware/auth.ts`: `Authorization: Bearer tcs_...`. Loads key and plan.
- `POST /v1/watchlists` with `{name, ecosystems[], components[], runtimes{}, min_severity, exploited_only}` enforces `plans.max_watchlists` and `max_components` (403 with the limit in the body). `GET /v1/watchlists`, `DELETE /v1/watchlists/:id`.
- `GET /v1/watchlists/:id/events` returns events matching the watch list filter from its stored cursor and advances the cursor on a successful response (so a polling agent needs no state). `?peek=true` does not advance.
- Limits are read from `plans` rows, never from constants.

## Acceptance tests
- `tests/routes/keys.test.ts`: key issued once; second call 409; the stored value is a hash, not the key.
- `tests/routes/watchlists.test.ts`: a free key creates 5 lists and the 6th returns 403 with `max_watchlists: 5`; a list with 201 components returns 403; events for a list filtered to `ecosystem=node` return only node and advance the cursor; `peek=true` leaves it.
- `tests/routes/watchlists-plan.test.ts`: `EXPLAIN QUERY PLAN` for the key lookup uses `api_keys(key_hash)`.

## Out of scope
Webhook delivery, billing, dashboard UI.
