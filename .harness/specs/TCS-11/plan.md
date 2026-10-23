# TCS-11 plan: Webhook delivery with exactly-once and retries

Ticket: Fortunian/tocsin#11 (label ai-build, open). `Blocked-by: #8 (hard)`: #8 is CLOSED. TCS-8 merged as b1beed8 on main.
Spec: the issue body (revised 2026-10-22) plus the REVISION comment. The body is the spec.

## Already on main? (BH-5802)
No. `git log origin/main --since=2026-10-22T00:26:56Z -- src/queue migrations src/routes/watchlists.ts` shows only b1beed8 (TCS-8). That commit added `watchlists.delivery/webhook_url/webhook_secret` and `plans.webhooks`, but no route sets `delivery`. `src/queue/run.ts` is still the stub ("The webhooks ticket replaces this body"). No `deliveries` table exists. No branch or PR for tcs-11 exists on origin.

## Spec changes from comments
(newest first)
- 6329993853 (liorwn, 2026-10-22T00:53Z): launch is free, no paid tier. Webhooks are free. `plans.webhooks` stays as a DB knob, seeded `free` row has it at 1. Test: a free key can set `delivery='webhook'`; after `UPDATE plans SET webhooks=0 WHERE id='free'` the same call gets 403. Delivered by T5 (plan gate on POST and PATCH) and its test in `tests/routes/webhooks-plan.tcs-11.test.ts`. No migration change: 0016 already seeds `free` with `webhooks=1`.

## Scope
1. Migration `migrations/0017_deliveries.sql`: `deliveries` table, its indexes, an index for webhook lists, and the settings rows for every new knob.
2. Set a watch list to webhook delivery: `POST /v1/watchlists` accepts `delivery` and `webhook_url`; new `PATCH /v1/watchlists/:id` changes them. Both are gated by `plans.webhooks = 1` (403 otherwise). The server makes the webhook secret and returns it once.
3. `src/queue/enqueue.ts`: after each ingest run, find webhook lists, insert `deliveries` rows with `INSERT OR IGNORE`, send one queue message per inserted row, move the list cursor. A sweep re-sends due rows whose message was lost.
4. `src/queue/run.ts`: the queue consumer. Claim the row, sign, POST, mark delivered or schedule the retry (1m, 5m, 30m, 2h, 12h), mark `failed` on the 6th failure. A row not in `pending` makes zero HTTP calls.
5. `GET /v1/watchlists/:id/deliveries`: the last 100 deliveries with status, scoped to the caller's key.
6. Daily cron: delete `delivered` rows older than 90 days (and `failed` rows older than 90 days, see ASSUMPTIONS).
7. Docs: `docs/API.md` webhook section becomes true (it says "Not live yet"), `docs/RETENTION.md` gets a `deliveries` section and the new settings rows.

Out of scope (ticket): email or Slack delivery, any paid plan.

## Files to touch
- `migrations/0017_deliveries.sql` (new)
- `src/queue/enqueue.ts` (new)
- `src/queue/sign.ts` (new: HMAC-SHA256 helper and event-id format, shared by consumer and tests)
- `src/queue/run.ts` (replace stub)
- `src/cron/deliveries-retention.ts` (new)
- `src/cron/run.ts` (call enqueue + sweep after ingest; daily retention branch)
- `src/routes/watchlists.ts` (POST accepts delivery; PATCH /:id; GET /:id/deliveries; DELETE also deletes the list's deliveries)
- `src/watchlists/filter.ts` (parse `delivery` and `webhook_url`)
- `src/watchlists/query.ts` (export the WHERE builder so enqueue reuses the same filter; `buildWatchlistEventsQuery` output unchanged)
- `src/lib/settings.ts` (add `getSettingIntList` for the backoff row)
- `wrangler.toml` (add the daily cron trigger)
- `docs/API.md`, `docs/RETENTION.md`
- `tests/queue/enqueue.tcs-11.test.ts` (new)
- `tests/queue/run.tcs-11.test.ts` (new)
- `tests/queue/helpers.tcs-11.ts` (new: seed helpers, recording fake queue, fake fetch)
- `tests/routes/webhooks-plan.tcs-11.test.ts` (new)
- `tests/routes/deliveries.tcs-11.test.ts` (new: list route, tenant test, EXPLAIN proofs)
- `tests/cron/deliveries-retention.tcs-11.test.ts` (new)

## Verify (run, not edited)
- `npm test` (all projects; `api` project carries every new suite)
- `npm run typecheck`
- `npm run migrate:local`
- Existing suites at regression risk: `tests/routes/watchlists.tcs-8.test.ts` (create stays `poll` by default, list never shows `webhook_secret`), `tests/routes/watchlists-plan.tcs-8.test.ts` (EXPLAIN on watchlist events query: T2 refactor must keep the same SQL), `tests/routes/watchlists-tenant.tcs-8.test.ts`, `tests/cron/run.tcs-2.test.ts` and `tests/cron/runtime-ingest.tcs-6.test.ts` (runCron ingest branch now also runs enqueue+sweep), `tests/cron/retention.tcs-8.test.ts` (monthly branch unchanged), `tests/worker/migrations.tcs-1.test.ts` (new migration file applies cleanly), `tests/launch/*` (local worker has the DELIVERIES queue binding already).

## Tests that must change
None. No existing test pins a premise this ticket changes: a list created without `delivery` is still `poll`, the list route still omits `webhook_secret`, the monthly cron string is unchanged.

## Changed symbols
- format `migrations/0017_deliveries.sql`: new table `deliveries`, indexes `idx_deliveries_status_next_at`, `idx_deliveries_watchlist_cursor`, `idx_deliveries_status_delivered_at`, `idx_watchlists_delivery`, new `settings` rows.
- function `runQueue` (src/queue/run.ts): stub replaced by the webhook consumer; gains an optional deps arg `{ fetch, now }`. callers: `src/index.ts` queue handler, unchanged call shape.
- function `enqueueDeliveries` (src/queue/enqueue.ts): new.
- function `sweepDeliveries` (src/queue/enqueue.ts): new.
- function `runCron` (src/cron/run.ts): ingest branch also runs enqueue then sweep; new daily branch `DELIVERY_RETENTION_CRON` runs deliveries retention. callers: `src/index.ts`, tests.
- function `runDeliveryRetention` (src/cron/deliveries-retention.ts): new.
- function `buildWatchlistEventsQuery` (src/watchlists/query.ts): body split into exported `watchlistWhere(f, since)`; returned SQL and params are byte-identical. callers: left alone: `src/routes/watchlists.ts` GET /:id/events keeps calling it unchanged.
- function `parseWatchlistBody` (src/watchlists/filter.ts): result gains `delivery` and `webhook_url`; absent fields mean `poll` and null, so current callers see the same filter.
- function `getSettingIntList` (src/lib/settings.ts): new.
- route `POST /v1/watchlists`: accepts optional `delivery` (`poll`|`webhook`) and `webhook_url`; 403 when `delivery='webhook'` and `plans.webhooks != 1`; 201 body adds `webhook_secret` once when webhook.
- route `PATCH /v1/watchlists/:id`: new.
- route `GET /v1/watchlists/:id/deliveries`: new.
- route `DELETE /v1/watchlists/:id`: also deletes that list's `deliveries` rows in the same batch.
- format webhook request: POST body = advisory `doc_json` bytes; headers `Tocsin-Event-Id`, `Tocsin-Timestamp`, `Tocsin-Signature: sha256=<hex>`.
- format queue message `{ watchlist_id, advisory_id }` on queue `deliveries`.

## Tasks

### T1. Migration 0017_deliveries.sql
```sql
CREATE TABLE IF NOT EXISTS deliveries (
  watchlist_id TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | delivered | failed
  last_code INTEGER,
  next_at TEXT NOT NULL,                     -- ISO; pending: due time; sending: lease end; failed: time of last attempt
  delivered_at TEXT,
  PRIMARY KEY (watchlist_id, advisory_id)
);
-- Sweep: WHERE status = ? AND next_at <= ? ORDER BY next_at LIMIT ?. Failed retention: WHERE status='failed' AND next_at < ?.
CREATE INDEX IF NOT EXISTS idx_deliveries_status_next_at ON deliveries (status, next_at);
-- Delivered retention: WHERE status='delivered' AND delivered_at < ? LIMIT ?.
CREATE INDEX IF NOT EXISTS idx_deliveries_status_delivered_at ON deliveries (status, delivered_at);
-- GET /v1/watchlists/:id/deliveries: WHERE watchlist_id = ? ORDER BY cursor DESC LIMIT ?.
CREATE INDEX IF NOT EXISTS idx_deliveries_watchlist_cursor ON deliveries (watchlist_id, cursor);
-- Enqueue: WHERE delivery = 'webhook' AND id > ? ORDER BY id LIMIT ?.
CREATE INDEX IF NOT EXISTS idx_watchlists_delivery ON watchlists (delivery, id);
```
Settings rows (`INSERT OR IGNORE`, each with a comment): `webhooks.backoff_seconds` = `60,300,1800,7200,43200`; `webhooks.timeout_ms` = `10000`; `webhooks.lease_seconds` = `60`; `webhooks.sweep_grace_seconds` = `600`; `webhooks.sweep_batch` = `500`; `webhooks.enqueue_max_lists` = `1000`; `webhooks.enqueue_per_list` = `100`; `webhooks.max_url_length` = `2048`; `webhooks.deliveries_list_limit` = `100`; `retention.deliveries_days` = `90`; `retention.deliveries_batch` = `5000`; `retention.deliveries_dry_run` = `0`.
D1 has no RLS (not Supabase); additive only, no DROP/RENAME (rule 1, D20).
VALIDATE: `npm run migrate:local` exits 0, and `npm test -- tests/routes/deliveries.tcs-11.test.ts` passes its EXPLAIN cases (each hot query uses its named index, no `SCAN deliveries`).
SATISFIES: "`migrations/0004_deliveries.sql`: `deliveries(watchlist_id, advisory_id, cursor, attempt INT, status TEXT, last_code INT, next_at, delivered_at, PK(watchlist_id, advisory_id))`, index `deliveries(status, next_at)`."

### T2. Shared filter WHERE
In `src/watchlists/query.ts` export `watchlistWhere(f, since): { where: string[]; params: unknown[] }`. `buildWatchlistEventsQuery` calls it and returns the same SQL string and params as today.
VALIDATE: `npm test -- tests/routes/watchlists-plan.tcs-8.test.ts tests/routes/watchlists.tcs-8.test.ts` passes unchanged.
SATISFIES: "finds watch lists with `delivery='webhook'` whose filter matches advisories above the list cursor" (enqueue uses the exact filter the poll feed uses).

### T3. Enqueue after each ingest run
`src/queue/enqueue.ts` `enqueueDeliveries(env, now)`:
1. Read knobs `webhooks.enqueue_max_lists`, `webhooks.enqueue_per_list` in parallel (Promise.all).
2. Read webhook lists: `SELECT id, filter_json, cursor FROM watchlists WHERE delivery = 'webhook' AND id > ? ORDER BY id LIMIT ?` (idx_watchlists_delivery). The `id > ?` start comes from KV key `webhooks:enqueue:after`; when a page is short the KV key resets to `''` (rotation, so no list starves past the cap; D21).
3. Per list (sequential, bounded by the cap): one `env.DB.batch([...])` transaction:
   - `INSERT OR IGNORE INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at) SELECT ?, id, cursor, 0, 'pending', ? FROM advisories WHERE <watchlistWhere> ORDER BY cursor LIMIT ? RETURNING advisory_id`
   - `UPDATE watchlists SET cursor = MAX(cursor, COALESCE((SELECT MAX(cursor) FROM deliveries WHERE watchlist_id = ?), cursor)) WHERE id = ? AND delivery = 'webhook'` (idx_deliveries_watchlist_cursor; every scanned advisory now has a row, inserted or pre-existing, so MAX(deliveries.cursor) is the scanned high-water mark).
4. `env.DELIVERIES.sendBatch(rows.map(r => ({ body: { watchlist_id, advisory_id } })))` for the RETURNING rows only (≤ per-list cap, under the 100-message sendBatch limit; the knob row comment says so and the code clamps a value over 100 to 100 with a logged warning). A send error is logged and the run continues; the sweep re-sends.
5. Return `{ lists, inserted, sent, send_errors }` and log one JSON line `lane: "enqueue"`.
`sweepDeliveries(env, now)`: `SELECT watchlist_id, advisory_id FROM deliveries WHERE status = ? AND next_at <= ? ORDER BY next_at LIMIT ?` run for `pending` (cutoff `now - sweep_grace_seconds`) and for `sending` (cutoff `now`, an expired lease), in parallel; sendBatch in chunks of 100. Rows are not changed by the sweep; the consumer claim is the gate.
`runCron` ingest branch: `await runIngesters(...)`, then `await enqueueDeliveries(env, now)`, then `await sweepDeliveries(env, now)`; each wrapped so a throw is logged and never fails the cron (the ingest outcome is already recorded).
VALIDATE: `npm test -- tests/queue/enqueue.tcs-11.test.ts`
SATISFIES: "After each ingest run, `src/queue/enqueue.ts` finds watch lists with `delivery='webhook'` whose filter matches advisories above the list cursor, inserts a `deliveries` row with `INSERT OR IGNORE` (the idempotency gate), and enqueues the pair."

### T4. Queue consumer
`src/queue/run.ts` `runQueue(batch, env, ctx, deps = { fetch: (i, init) => fetch(i, init), now: () => new Date() })`. Knobs read once per batch in parallel: `webhooks.backoff_seconds` (via `getSettingIntList`, fallback `[60,300,1800,7200,43200]`), `webhooks.timeout_ms` (10000), `webhooks.lease_seconds` (60). Per message (messages in a batch run in parallel with `Promise.all`; each message is a different PK so no shared row):
1. Validate body shape `{watchlist_id: string, advisory_id: string}`; a bad body is logged and acked.
2. Claim: `UPDATE deliveries SET status = 'sending', next_at = ?lease_end WHERE watchlist_id = ? AND advisory_id = ? AND status IN ('pending', 'sending') AND next_at <= ?now RETURNING attempt` (a `sending` row is claimable only after its lease ended). No row: ack, zero HTTP calls (delivered, failed, early duplicate, or another consumer holds it).
3. Load in one statement: `SELECT w.webhook_url, w.webhook_secret, w.delivery, a.doc_json FROM deliveries d JOIN watchlists w ON w.id = d.watchlist_id JOIN advisories a ON a.id = d.advisory_id WHERE d.watchlist_id = ? AND d.advisory_id = ?`. Missing list, list no longer `webhook`, or missing URL/secret: set `status='failed', next_at=now, last_code=NULL`; ack; zero HTTP calls.
4. Body = `doc_json` string as stored (the advisory JSON). Timestamp = unix seconds string. Signature = `sha256=` + hex HMAC-SHA256(secret, body) via `src/queue/sign.ts`. Event id = `${watchlist_id}:${advisory_id}` (stable across retries so a receiver can dedup).
5. `deps.fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "tocsin-webhooks", "Tocsin-Event-Id", "Tocsin-Timestamp", "Tocsin-Signature" }, body, redirect: "manual", signal: AbortSignal.timeout(timeout_ms) })`.
6. 2xx: `UPDATE deliveries SET status='delivered', delivered_at=?, last_code=?, attempt=attempt+1 WHERE ... AND status='sending'`.
   Otherwise (non-2xx, 3xx, network error or timeout, last_code NULL for no response): `n = attempt + 1`. If `n > backoff.length`: `status='failed', next_at=now`. Else `status='pending', next_at = now + backoff[n-1]`, then `env.DELIVERIES.send({...}, { delaySeconds: backoff[n-1] })`. A send error is logged; the sweep re-sends after `sweep_grace_seconds`.
7. Every message is acked (`msg.ack()`); retries are our own delayed messages, never `msg.retry()`, so the queue's own max_retries never drops a row. Any unexpected throw in one message is logged with the pair and that message gets `msg.retry()` (the row is still `pending`/`sending` and the claim keeps it exactly-once).
VALIDATE: `npm test -- tests/queue/run.tcs-11.test.ts`
SATISFIES: "`src/queue/run.ts` consumer: POST the advisory JSON to `webhook_url` with headers `Tocsin-Event-Id`, `Tocsin-Signature: sha256=<hmac of body with webhook_secret>`, `Tocsin-Timestamp`. 2xx marks delivered. Otherwise schedule retry with backoff 1m, 5m, 30m, 2h, 12h; after 5 attempts mark `failed`. A delivered row is never re-sent."

### T5. Set delivery mode, plan gate
`src/watchlists/filter.ts`: `parseWatchlistBody` and a new `parseDeliveryPatch(body)` read `delivery` (`"poll"` or `"webhook"`, anything else 400) and `webhook_url`. `webhook_url` is required for `webhook`, must parse as a URL with protocol `https:`, no username/password, length ≤ `webhooks.max_url_length` (2048). `poll` clears URL and secret.
`src/routes/watchlists.ts`:
- `POST /`: if `delivery === 'webhook'` and `c.var.apiKey.limits.webhooks !== 1` → 403 `{ error: "webhooks not enabled for this plan" }`. Else insert with delivery, URL and a new secret `whsec_` + 32 random bytes hex. The 201 body includes `webhook_url` and `webhook_secret` once.
- `PATCH /:id` body `{ delivery, webhook_url? }`: same gate (403) before any write. `UPDATE watchlists SET delivery=?, webhook_url=?, webhook_secret=? WHERE id=? AND key_id=?` (404 when 0 changes). A switch to `webhook` makes a new secret and returns it once. Switching to `poll` sets URL and secret to NULL.
- Same body cap middleware as POST (`watchlists.max_body_bytes`).
- `GET /` and `GET /:id/events` keep never selecting `webhook_secret`; `GET /` adds `webhook_url`.
VALIDATE: `npm test -- tests/routes/webhooks-plan.tcs-11.test.ts tests/routes/watchlists.tcs-8.test.ts`
SATISFIES: "Webhooks are free. `plans.webhooks` must be 1 to set `delivery='webhook'` (403 otherwise); the seeded `free` row has it at 1" and comment 6329993853.

### T6. Deliveries list route
`GET /v1/watchlists/:id/deliveries`: one statement scoped to the key: `SELECT d.advisory_id, d.cursor, d.status, d.attempt, d.last_code, d.next_at, d.delivered_at FROM deliveries d JOIN watchlists w ON w.id = d.watchlist_id WHERE d.watchlist_id = ? AND w.key_id = ? ORDER BY d.cursor DESC LIMIT ?` with the limit from `webhooks.deliveries_list_limit` (fallback 100, clamped to 1..100 per rule 8). A list that is not the caller's answers 404 (first read `SELECT 1 FROM watchlists WHERE id=? AND key_id=?` and the knob in parallel; 2 reads + 1 list read = 3 statements, plus auth's 2). `Cache-Control: no-store`. `next_at` is shown only for `pending`.
`DELETE /:id`: one `env.DB.batch` (one transaction). Statement 1 deletes the deliveries, guarded by the key: `DELETE FROM deliveries WHERE watchlist_id IN (SELECT id FROM watchlists WHERE id = ? AND key_id = ?)`. Statement 2 is the existing `DELETE FROM watchlists WHERE id = ? AND key_id = ?`. 404 when statement 2 changed 0 rows.
VALIDATE: `npm test -- tests/routes/deliveries.tcs-11.test.ts`
SATISFIES: "`GET /v1/watchlists/:id/deliveries` lists the last 100 deliveries with status."

### T7. Daily retention
`wrangler.toml` crons add `"41 4 * * *"`; `src/cron/run.ts` exports `DELIVERY_RETENTION_CRON = "41 4 * * *"` and routes it to `runDeliveryRetention(env, now)`. Same shape as `runKeyRetention`: knobs `retention.deliveries_days` (90), `retention.deliveries_batch` (5000), `retention.deliveries_dry_run` (0) read in parallel; out-of-range throws; dry run counts only; live run is one batch of two deletes:
- `DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries WHERE status = 'delivered' AND delivered_at < ? LIMIT ?)` (idx_deliveries_status_delivered_at)
- `DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries WHERE status = 'failed' AND next_at < ? LIMIT ?)` (idx_deliveries_status_next_at)
Audit record to KV `retention:deliveries:last` after commit and one log line. Rows are delivery receipts, not money, so they are deleted, not archived.
VALIDATE: `npm test -- tests/cron/deliveries-retention.tcs-11.test.ts`
SATISFIES: "Retention: delivered rows older than 90 days are deleted by the daily cron."

### T8. Docs
`docs/API.md` "Webhook signature" section: remove "Not live yet"; document POST/PATCH `delivery` + `webhook_url`, the one-time `webhook_secret`, the 403, the headers (Tocsin-Timestamp is unix seconds; event id format), the retry schedule (6 attempts total), `GET /v1/watchlists/{id}/deliveries`. `docs/RETENTION.md`: a `deliveries` section, a `KV retention:deliveries:last` and `KV webhooks:enqueue:after` entry, and the settings row count and names.
VALIDATE: `grep -c "Not live yet" docs/API.md` prints 0 and `grep -n "deliveries" docs/RETENTION.md` shows the new section.
SATISFIES: D5 honest claims for the ticket's shipped behavior ("lists the last 100 deliveries", "Retention: delivered rows older than 90 days") — the published docs must not say webhooks are not live once they are.

## Edge cases
- Enqueue run twice: second run inserts 0 rows (cursor moved; even if not, `INSERT OR IGNORE` returns no RETURNING row) and sends 0 messages.
- Crash after insert, before send: row `pending` with `next_at = insert time`; sweep sends it once `sweep_grace_seconds` passed.
- Duplicate queue message (sweep + delayed retry both): the claim `status='pending' AND next_at <= now` lets only one through; the other acks with zero HTTP.
- Consumer dies after claim: row `sending` with `next_at` = lease end; the sweep re-sends after the lease, and the T4 claim accepts a `sending` row whose lease ended.
- HTTP 2xx but the `delivered` write fails: row stays `sending`, lease expires, the event is sent again with the same `Tocsin-Event-Id`. Exactly-once is on the row; the wire is at-least-once with a dedup id (docs say so).
- 3xx answers are failures (`redirect: "manual"`), so a redirect never sends a signed body to another host.
- Delivered row re-queued by hand: claim matches 0 rows, zero `fetch` calls.
- List switched back to `poll`, or deleted, with pending rows: consumer marks them `failed` and sends nothing; DELETE also removes them.
- `webhooks.backoff_seconds` row malformed (non-int, empty, negative): `getSettingIntList` returns the fallback and logs it.
- A delay over 43200 s (queue max) in the knob: clamp to 43200 with a log line; the row's `next_at` uses the real value, and the early message is a no-op claim; the sweep sends it when due.
- Advisory deleted (not done today) : the JOIN finds no row → failed.
- A GET /:id/events on a webhook list also moves the shared cursor (existing behavior); see ASSUMPTIONS.

## Iron laws applied
- Additive schema only (rule 1, D20): new table and indexes, `CREATE ... IF NOT EXISTS`, no DROP. D1, so no RLS statement (RLS is a Supabase rule).
- Indexes for every query on the new table in the same migration, with EXPLAIN proofs on seeded data (rule 2): sweep, both retention deletes, the list route, the cursor MAX, the webhook-list read.
- Retention (rule 2): daily cron, window, batch and dry-run in settings rows, audit record per run.
- Idempotency (rules 3, 4): `INSERT OR IGNORE` on the PK; conditional claim UPDATE before any HTTP call; a `delivered` or `failed` row never reaches `fetch`.
- Knobs (rule 5, BH-7945): every new number above is a settings row with a code fallback whose comment names the row.
- Deterministic (rule 6): no LLM. De-AI voice: no AI text surface. No `claude-*` strings.
- Dedup before spend (rule 7): webhooks are not metered; the claim is still the "already sent?" check before the call.
- Reads bounded (rule 8): list route capped at 100; enqueue and sweep capped by knobs.
- Secrets (rule 9): `webhook_secret` is per list in D1, returned once, never listed, never logged. No new env var, so `.env.example` does not change.
- No per-row correlated subquery over a large table: the cursor update's `MAX(cursor)` runs once per list on `idx_deliveries_watchlist_cursor` (one index seek).
- UI laws (sortable tables, cards, drill-down): no UI in this ticket; the deliveries list is a JSON API.

## Performance
Not a screen. Per request statement counts:
- `GET /:id/deliveries`: auth 2 (parallel, existing) + list check and limit knob (parallel) + 1 list read = 5. Indexes: idx_api_keys_key_hash, PK of watchlists, idx_deliveries_watchlist_cursor.
- `PATCH /:id`: auth 2 + body cap knob 1 + 1 UPDATE = 4.
- Consumer per message: 1 claim + 1 load + 1 result write (+1 queue send on retry). Knobs 3 per batch, parallel.
- Enqueue: knobs 2 (parallel) + 1 list read + 1 batch per list (2 statements) + 1 sendBatch per list with new rows.

## Vendor seams (BH-7563)
- Webhook receiver (a customer endpoint, external): seam is `deps.fetch` in `runQueue`. Production passes global `fetch`. Tests pass a recording fake that returns the scripted status and records URL, headers, body; 0 network calls. No contract suite: there is no vendor, the receiver is the user's own URL.
- Cloudflare Queue `DELIVERIES`: tests pass an env whose `DELIVERIES` is a recording fake `{ send, sendBatch }` (local, counts messages). The real binding is local Miniflare in `tests/launch`.
- No auth provider, mail, payments or LLM in this change. Each test seeds its own key, lists and advisories with unique ids (`crypto.randomUUID()`), no order dependence.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty: no live sibling build. Open PR #62 (TCS-32) also edits `docs/API.md` and `docs/RETENTION.md` and adds migrations 0014 and 0015. This plan uses 0017 to avoid the number. The doc edits are in different sections; a text conflict, if any, is a rebase.

## ASSUMPTIONS
- How a list is set to webhook: the API has no field for it today. Assumed: `POST /v1/watchlists` accepts `delivery` + `webhook_url`, and a new `PATCH /v1/watchlists/:id` changes them; both gated (D15). Other reading: only one of the two. A PATCH-only or POST-only API would drop one route.
- Webhook secret: assumed server-generated (`whsec_<64 hex>`), returned once in the response that sets `webhook`, never listed. Other reading: the client supplies it.
- Retry count: the body says "backoff 1m, 5m, 30m, 2h, 12h; after 5 attempts mark failed", the acceptance test says "the 6th failure marks failed". Assumed the test: 5 retries after the first attempt, 6 attempts total, `attempt` counts attempts made (a first 500 gives `attempt=1`, `next_at` +60 s). Other reading: 5 attempts total, 4 backoffs used.
- `failed` rows: the ticket only names delivered-row retention. Assumed failed rows also expire after `retention.deliveries_days`, so the table has no unbounded class. Other reading: failed rows kept forever.
- No daily cron exists (only `*/10` and monthly). Assumed a new trigger `41 4 * * *`.
- Test file names: the ticket names `tests/queue/enqueue.test.ts`, `tests/queue/run.test.ts`, `tests/routes/webhooks-plan.test.ts`. The harness rule names per-ticket files, so they are `*.tcs-11.test.ts` with the same assertions.
- Migration number: the body names `0004_deliveries.sql`; 0004 exists on main and PR #62 takes 0014/0015, so it is `0017_deliveries.sql`.
- Shared cursor: for a webhook list, enqueue moves `watchlists.cursor`. A `GET /:id/events` without `peek` on the same list still moves it too (TCS-8 behavior, unchanged), so events read by poll are not also sent. Other reading: separate cursors per mode (a schema change the ticket does not ask for).
- `Tocsin-Timestamp` is unix seconds; `Tocsin-Event-Id` is `<watchlist_id>:<advisory_id>`. The ticket names the headers but not the formats.
- Webhook URL must be `https:`. Other reading: allow `http:`.
- The plan gate is checked when delivery is set, not again at send time. Other reading: the consumer also checks `plans.webhooks` before each send.
- Key retention (`src/cron/retention.ts`) is left alone: deliveries of a list it deletes are marked `failed` by the consumer (list missing) or never sent, and expire by deliveries retention. Other reading: add the delete to the key retention batch.

## System invariants
(a) Cross-run state: `deliveries` table, natural key PK `(watchlist_id, advisory_id)` is the exactly-once gate. `watchlists.cursor` is the enqueue watermark (moves only forward, `MAX`). KV `webhooks:enqueue:after` is only a rotation hint: losing it restarts the rotation at the first list and changes no correctness. Nothing dedups against a capped query: the sweep reads rows, it never prunes them.
(b) Side effects:
- Queue send at enqueue: success = message sent; failure = logged, row stays `pending`, sweep re-sends after grace. Order: row insert commits BEFORE send, so a send never exists without a row.
- Webhook POST: the row moves to `sending` (claim) BEFORE the POST; `delivered` is written ONLY after a 2xx response is in hand. "Delivered without a 2xx" cannot happen: the only `status='delivered'` write is in the 2xx branch. A failure writes `pending`+`next_at` or `failed`. Not configured (no URL/secret, list not webhook) = `failed`, no POST.
- Retry message send: after the row write; a lost send is covered by the sweep.
(c) Negative list (must NOT POST): a `delivered` row re-queued by hand; a `failed` row; a `pending` row whose `next_at` is in the future (early duplicate); a `sending` row whose lease is live; a list switched to `poll`; a deleted list; a malformed message body. Must NOT count as success: 301/302/307 answers, a network error, a timeout, a 4xx or 5xx. (204 is 2xx and IS success; a test pins it.) Must NOT pass the gate: `plans.webhooks = 0` on POST and on PATCH; `delivery: "Webhook"` (case) is a 400, not a webhook.
(d) Neighbors: the `*/10` cron lane now runs ingest then enqueue then sweep in one invocation; enqueue/sweep are capped by knobs and a throw in them never marks an ingest source failed. The monthly key retention is unchanged. The new daily cron is a new branch in `runCron` that runs only retention. The queue `deliveries` has one consumer (this worker). The TCS-8 `/events` route shares `watchlists.cursor` (ASSUMPTIONS). No locks.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| deliveries table with the named columns and PK | T1 | deliveries.tcs-11: PRAGMA table_info columns + duplicate PK insert ignored |
| index deliveries(status, next_at) | T1 | deliveries.tcs-11: EXPLAIN of sweep query names idx_deliveries_status_next_at |
| delivered rows > 90 days deleted by daily cron | T7 | deliveries-retention.tcs-11: 91-day delivered row gone, 89-day stays, pending row stays; runCron with DELIVERY_RETENTION_CRON runs it |
| enqueue after each ingest run | T3 | enqueue.tcs-11: runCron "*/10" with empty registry creates the delivery row |
| only `delivery='webhook'` lists, filter match, above the cursor | T3 | enqueue.tcs-11: poll list gets 0 rows; non-matching ecosystem 0 rows; advisory at/below cursor 0 rows |
| INSERT OR IGNORE idempotency, enqueue the pair | T3 | enqueue.tcs-11: twice → 1 row, 1 message |
| POST advisory JSON with 3 headers, HMAC signature | T4 | run.tcs-11: 200 → body equals doc_json, signature verifies with the secret |
| 2xx marks delivered | T4 | run.tcs-11: status delivered, delivered_at set, last_code 200 |
| retry backoff 1m,5m,30m,2h,12h | T4 | run.tcs-11: 500 → attempt=1, next_at = now+60 s; full ladder 60/300/1800/7200/43200 |
| failed after the retries | T4 | run.tcs-11: 6th failure → failed, no further send |
| delivered row never re-sent (negative) | T4 | run.tcs-11: re-queued delivered row → 0 fetch calls |
| webhooks free, gate is DB knob | T5 | webhooks-plan.tcs-11: free key 201/200; after UPDATE plans webhooks=0 → 403 on POST and PATCH, row unchanged |
| GET deliveries last 100 with status | T6 | deliveries.tcs-11: 120 rows → 100 newest by cursor with status; other key → 404 (0 rows) |
| no email/Slack, no paid plan (negative) | none | no code path; plans table rows unchanged (watchlists-plan.tcs-8 still pins one `free` row) |

## Design collisions
- `POST /v1/watchlists`: combine — (main 0fe8f3473377) TCS-32 only touched this route's text in `site/docs.generated.ts` (the docs table and the "create a list" line), not its code. T5 edits `docs/API.md` on top of main's current version, then regenerates `site/docs.generated.ts` from it, so main's coverage text stays.
- `doc_json`: combine — (main 0fe8f3473377) TCS-32 reads `doc_json` only in `/v1/check` and the import route, and the webhook body stays the stored `doc_json` bytes. But `docs/BACKFILL.md` ("Feed consumers") says every backfilled record gets a new feed cursor and "a later delivery feature must not treat backfill events as new advisories". So in T3, an advisory whose `published_at` is older than the list's `created_at` minus the settings row `webhooks.max_event_age_days` (new knob in this plan's migration, fallback 30, documented) still gets its `deliveries` row (so the cursor high-water mark holds), but with `status='skipped'` and no queue message. T4 never claims a `skipped` row, and `tests/queue/enqueue.tcs-11.test.ts` adds a case: one backfilled old advisory makes 0 sends.
- `buildWatchlistEventsQuery`: combine — (PR #65 2188c88e9603) PR #65 does not change `src/watchlists/query.ts` compared with main (empty diff), so the T2 split into `watchlistWhere` still applies. Its round 2 makes `tests/routes/watchlists-plan.tcs-8.test.ts` assert the exact index for each filter shape, so T2's byte-identical SQL must also keep each of those index choices, and T2's VALIDATE runs that test from whichever of main or PR #65 is the base.
- `parseWatchlistBody`: combine — (PR #65 4f04b473a714) PR #65 adds caps (name 100, strings 200, ecosystems from `KNOWN_ECOSYSTEMS`, runtimes 10, filter 64 KB) and splits out `parseRuntimes` and `checkEcosystems`. T5 adds `delivery` and `webhook_url` after those checks. `webhook_url` uses its own `webhooks.max_url_length` knob (2048), not `MAX_STRING_CHARS`, and stays outside the `filter` object, so it is not counted in `MAX_FILTER_BYTES`. If PR #65 merges first, rebase onto it and keep its caps unchanged.
- `POST /v1/watchlists`: combine — (PR #65 4f04b473a714) PR #65 puts `requireApiKey, keyRateLimit` on every `/v1/watchlists` route, so the new `PATCH /:id` and `GET /:id/deliveries` get the per-key rate limit with no extra code. The webhook 403 gate runs inside the handler, after the rate limit. PR #65 also adds `migrations/0017_watchlist_limits.sql`. If it merges before this build, rename this plan's `migrations/0017_deliveries.sql` to `0018_deliveries.sql`. Either way, `tests/worker/migrations.tcs-1.test.ts` (the pinned migration list) gains the new file as a `TEST-CHANGE:` line, the same way PR #65 did.
- `doc_json`: combine — (PR #65 2188c88e9603) PR #65 has no code that reads or writes `advisories.doc_json` (text match only, in docs). T4's consumer `SELECT ... a.doc_json` and its body format do not change.

## Acceptance tests
- `tests/queue/enqueue.tcs-11.test.ts`
  - Enqueue twice for the same advisory: 1 `deliveries` row, 1 message on the fake queue (asserts count and body `{watchlist_id, advisory_id}`).
  - A `poll` list matching the same advisory gets 0 rows.
  - An advisory with cursor ≤ list cursor gets 0 rows; a non-matching ecosystem gets 0 rows.
  - The list cursor moves to the highest enqueued advisory cursor.
  - runCron(`*/10 * * * *`, empty registry) through `src/cron/run.ts` creates the row (D2 production entry).
  - Sweep: a `pending` row with `next_at` older than grace is sent once; a fresh `pending` row is not; a `delivered` row is not.
  - Mutation check (D1): removing `OR IGNORE`, or sending for all selected rows instead of RETURNING rows, makes the twice test red.
- `tests/queue/run.tcs-11.test.ts` (fake fetch, fake queue, fixed `now`)
  - 200: row `delivered`, `delivered_at` = now, `last_code` 200; the request has `Tocsin-Event-Id`, `Tocsin-Timestamp`, and `Tocsin-Signature` equal to `sha256=` + HMAC computed in the test with `crypto.subtle` over the received body with the list's secret.
  - 500: `attempt = 1`, `status = 'pending'`, `next_at` = now + 60 s, one delayed message with `delaySeconds: 60`.
  - Six 500s in a row (now advanced past each `next_at`): attempts 1..5 give 60/300/1800/7200/43200; the 6th gives `failed`, no message.
  - A delivered row re-queued by hand: 0 fetch calls, row unchanged.
  - Negatives: future `next_at` → 0 calls; list switched to `poll` → 0 calls and `failed`; 302 → counted as failure; fetch throw → failure with `last_code` NULL.
  - Through `worker.queue` (src/index.ts default export) with a hand-built batch, once (D2).
- `tests/routes/webhooks-plan.tcs-11.test.ts`
  - A free key: POST with `delivery:'webhook', webhook_url:'https://hooks.example.test/x'` → 201 with `webhook_secret`; PATCH on a poll list → 200.
  - After `UPDATE plans SET webhooks=0 WHERE id='free'`: the same POST and PATCH → 403; the row is unchanged. Restores `webhooks=1` in `finally` (isolated D1 per file anyway).
  - `http://` URL → 400; `delivery:'email'` → 400; `GET /v1/watchlists` never contains `webhook_secret`.
- `tests/routes/deliveries.tcs-11.test.ts`
  - 120 seeded rows → 100 newest by cursor, each with `status`.
  - Another key's list → 404 and 0 rows (wrong-tenant test).
  - DELETE /:id removes the list's deliveries.
  - EXPLAIN QUERY PLAN on 5,000 seeded rows: sweep, list route, cursor MAX, both retention deletes, webhook-list read each use their named index; no `SCAN deliveries`.
- `tests/cron/deliveries-retention.tcs-11.test.ts`
  - Delivered 91 days ago deleted; 89 days kept; failed 91 days ago deleted; pending kept; dry run deletes nothing and records counts; audit record written; knobs read from settings rows; `DELIVERY_RETENTION_CRON` equals the wrangler.toml trigger (read the file is not possible in workers; assert the constant and that runCron routes it).

## QA screens
None in a browser: this ticket is API and queue only. API checks for a QA pass (`npm run dev`):
- `POST /v1/watchlists` with `delivery: "webhook"` → 201 with a `webhook_secret`.
- `PATCH /v1/watchlists/{id}` → 200.
- `GET /v1/watchlists/{id}/deliveries` → JSON list, `Cache-Control: no-store`.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section (copied verbatim)
```

## Design collision check (BH-5791)

Checked 15 listed and 0 derived symbols against main b1beed845aed..0fe8f3473377 and 1 open PRs.
- `POST /v1/watchlists` (function, listed): main 0fe8f3473377, (text match). Resolution: combine.
- `doc_json` (function, listed): main 0fe8f3473377, (text match). Resolution: combine.
- `buildWatchlistEventsQuery` (function, listed): PR #65 2188c88e9603, body or signature changed. Resolution: combine.
- `parseWatchlistBody` (function, listed): PR #65 4f04b473a714, body or signature changed. Resolution: combine.
- `POST /v1/watchlists` (function, listed): PR #65 4f04b473a714, (text match). Resolution: combine.
- `doc_json` (function, listed): PR #65 2188c88e9603, (text match). Resolution: combine.

## Size
FILES: 12
LINES: 520
DIFF_KB: 70

KIND: feature
SIZE: L
