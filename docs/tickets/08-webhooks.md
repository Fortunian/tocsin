# Webhook delivery with exactly-once and retries

Blocked-by: #7 (hard)

## Scope
- `migrations/0004_deliveries.sql`: `deliveries(watchlist_id, advisory_id, cursor, attempt INT, status TEXT, last_code INT, next_at, delivered_at, PK(watchlist_id, advisory_id))`, index `deliveries(status, next_at)`. Retention: delivered rows older than 90 days are deleted by the daily cron.
- After each ingest run, `src/queue/enqueue.ts` finds watch lists with `delivery='webhook'` whose filter matches advisories above the list cursor, inserts a `deliveries` row with `INSERT OR IGNORE` (the idempotency gate), and enqueues the pair.
- `src/queue/run.ts` consumer: POST the advisory JSON to `webhook_url` with headers `Tocsin-Event-Id`, `Tocsin-Signature: sha256=<hmac of body with webhook_secret>`, `Tocsin-Timestamp`. 2xx marks delivered. Otherwise schedule retry with backoff 1m, 5m, 30m, 2h, 12h; after 5 attempts mark `failed`. A delivered row is never re-sent.
- Plan gate: `plans.webhooks=1` required to set `delivery='webhook'` (403 otherwise).
- `GET /v1/watchlists/:id/deliveries` lists the last 100 deliveries with status.

## Acceptance tests
- `tests/queue/enqueue.test.ts`: running enqueue twice for the same advisory creates one `deliveries` row and one queue message.
- `tests/queue/run.test.ts`: a 200 marks delivered and the signature verifies against the body; a 500 schedules `next_at` 60 seconds later with `attempt=1`; the 6th failure marks `failed`; a delivered row re-queued by hand makes zero HTTP calls.
- `tests/routes/webhooks-plan.test.ts`: a free key setting `delivery='webhook'` gets 403.

## Out of scope
Email or Slack delivery, the Stripe upgrade flow.
