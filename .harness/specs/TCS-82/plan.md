# TCS-82 plan: webhooks follow-ups (delivery lane)

Ticket: Fortunian/tocsin#82. Blocked-by #11 (hard): #11 is CLOSED, so the ticket is buildable.
Base: origin/main f1b4f68 (TCS-11 merge). CodeGraph: NOT AVAILABLE on this box; call paths below come from grep and reads.

This ticket bundles 8 independent items in 4 file areas. It is SIZE XL on purpose, so the pipeline splits it.
Each "Child" section below is one child ticket that ships on its own. The children are ordered only where they edit the same file.

## Already on main? (BH-5802)
- `git log origin/main --since=2026-10-23T19:56:19Z` shows f1b4f68 (TCS-11 merge) and two earlier commits. None does items 1 to 6 or 8.
- Item 7 is done in code by f1b4f68: the `verifyTocsinWebhook` block in `docs/API.md:179` already has `!/^\d+$/.test(ts)`, so a non-numeric timestamp returns false before the tolerance check. `tests/docs/webhook-verify.tcs-11.test.ts` has no case that pins it. Child D adds only that test.

## Spec changes from comments
- 6373816984, liorwn (2026-10-23T20:13Z): adds items 5 to 8 (IPv6 forms in the DNS check, failed rows kept for the life of the list, verify code refuses a non-numeric timestamp, shorter DNS cache at send time). Delivered by Child D (items 5, 7, 8) and Child E (item 6).

## ASSUMPTIONS
- A1 (item 1, "skipped rows count against the limit"): ambiguous between (a) rows that already have a deliveries row (a backfill re-cursor) and (b) aged rows written as `skipped`. I assume (a) is the 480-run cause, because the ticket names "a backfill re-cursor". Fix: the cursor update no longer stops at the scan's LIMIT when the fresh page is short; it passes every matching row that already has a deliveries row, up to a scan cap. Aged rows still get a `skipped` row and still count against the cap (no change to the `skipped` contract, the deliveries list or docs/BACKFILL.md). Other reading: stop writing `skipped` rows and move the age rule into the WHERE. That changes a public status, so I did not pick it.
- A2 (item 1, "skip rows below the list's filter in SQL"): the filter is already in SQL (`watchlistWhere`). I read this as "the rows the loop passes must be passed in SQL", which A1 delivers.
- A3 (item 1, cap over 100): `webhooks.enqueue_per_list` default moves 100 -> 1000. The 100-message sendBatch limit stays a platform limit; messages go in chunks of 100 instead of the clamp at `src/queue/enqueue.ts:105`.
- A4 (item 1, lag measure): lag rows = advisories with `cursor > list.cursor` that match the list filter, counted with a cap of `webhooks.lag_alert_rows + 1` (bounded read). The alert channel is one JSON log line `{lane:"enqueue", alert:"lag", watchlist_id, lag_rows}` plus a `lagging_lists` count in the enqueue result. Other reading: write `sources.last_warning`. A watch list is not a source, so I did not pick it.
- A5 (item 1, new knob): the scan cap needs a knob (D21, BH-7945): `webhooks.enqueue_scan_rows`, default 100000. The ticket does not name it.
- A6 (item 2, KEK unset): when `WEBHOOK_KEK` is unset, create and PATCH keep the plaintext write (today's behavior) and log `kek_missing` once per request; the re-encrypt job logs `kek_missing` and does nothing. Other reading: answer 503 to webhook creates until the secret is set. That breaks a live flow on deploy, so I did not pick it. The operator step goes in the PR body.
- A7 (item 2, format): `webhook_secret_enc` = `v1:<base64 iv>:<base64 ciphertext>`, AES-256-GCM, 12-byte random IV per row, AAD = the watch list id (a ciphertext copied to another row does not decrypt). `WEBHOOK_KEK` = 32 bytes as base64.
- A8 (item 2, the re-encrypt job lane): it runs in the `*/10` cron after the sweep, at most `webhooks.reencrypt_batch` rows per run (default 500). It is idempotent: the UPDATE is guarded by `webhook_secret = ?` (the read value) and `webhook_secret_enc IS NULL`.
- A9 (item 3, consumer values): `max_batch_size = 10`, `max_retries = 3`, `max_concurrency = 5`, `dead_letter_queue = "deliveries-dlq"`. These are deploy config in wrangler.toml, which the Worker cannot read from D1. They are not DB knobs; the wrangler.toml comment says so.
- A10 (item 3, "with the reason"): a DLQ message carries no error text. The DLQ consumer writes `status='failed'`, `last_error='dead_letter'` and logs `msg.attempts`. The consumer's catch also logs the throw (it does today).
- A11 (item 4, "the run refuses to start"): when `timeout_ms >= lease_seconds * 1000`, `runQueue` logs one error, makes 0 claims and 0 HTTP calls, and acks every message. Rows stay `pending`, and the sweep re-sends them after the grace. Other reading: throw. A throw sends every message to the DLQ (Child C), and the DLQ marks them `failed`, so a config typo would lose deliveries. I did not pick it.
- A12 (item 5): block the three ranges outright, without an embedded-IPv4 check: `::/96` (IPv4-compatible, deprecated), `2002::/16` (6to4) and `::ffff:0:0:0/96` (IPv4-translated, `::ffff:0:a.b.c.d`). `::ffff:a.b.c.d` (IPv4-mapped) keeps today's embedded check.
- A13 (item 8): Workers `fetch` cannot pin a resolved IP for an https POST, so I pick "shorter cache". `webhooks.dns_cache_seconds` default 600 -> 60 (the KV minimum), and the value `0` now means "no cache, resolve at every send". The migration changes the row only when it still holds the shipped `600`. The residual gap (the platform resolves again for the POST) stays and docs/API.md says so.
- A14 (item 6): the daily job stops deleting `failed` rows. `failed` rows go with their list (DELETE route and key retention), like `delivered` rows. The audit record drops its `failed` field (its only reader is an operator reading KV `retention:deliveries:last`).

## Changed symbols
- function `buildEnqueueStatements` (src/queue/enqueue.ts): the cursor update passes non-fresh matching rows up to `scanRows` when the fresh page is short. Callers: `enqueueDeliveries` only, and tests/routes/deliveries.tcs-11.test.ts (EXPLAIN).
- function `enqueueDeliveries`: reads `webhooks.enqueue_scan_rows` and `webhooks.lag_alert_rows`, sends in chunks of 100, counts lag, result gets `lagging_lists`. Callers: `runCron` only.
- function `runQueue` (src/queue/run.ts): dispatches by `batch.queue` (`deliveries-dlq` -> the DLQ handler), and refuses when the timeout/lease invariant breaks.
- function `readKnobs` (src/queue/run.ts): returns the invariant verdict; `dnsTtl` accepts 0.
- function `deliverOne` / `LOAD_SQL` (src/queue/run.ts): load `webhook_secret_enc`, decrypt before signing.
- function `checkHost` / `addresses` (src/queue/resolve.ts): ttl 0 skips the KV read and write.
- function `isBlockedAddress` / `blockedV6` (src/watchlists/webhook-url.ts): blocks `::/96`, `2002::/16`, `::ffff:0:0:0/96`. Callers: `checkHost` (send time). callers: left alone: the registration check rejects IP literals before this function.
- function `runDeliveryRetention` (src/cron/deliveries-retention.ts): deletes `skipped` rows only; audit loses `failed`.
- function `runCron` (src/cron/run.ts): calls `reencryptWebhookSecrets` after the sweep.
- route `POST /v1/watchlists`, route `PATCH /v1/watchlists/:id` (src/routes/watchlists.ts): write `webhook_secret_enc` (and `webhook_secret = NULL`) when `WEBHOOK_KEK` is set.
- format `deliveries-dlq` queue messages: same body as `deliveries` (`{watchlist_id, advisory_id}`).
- format `watchlists.webhook_secret_enc`: `v1:<iv b64>:<ct b64>`.
- format KV `retention:deliveries:last`: the `failed` field is removed.

## Design collisions
- Open PRs: #86 (TCS-83, API keys, mail) and #79 (TCS-38, OSV ecosystems). Neither touches src/queue, src/watchlists/webhook-url.ts, src/routes/watchlists.ts or src/cron/deliveries-retention.ts. Main since base: no change to these symbols. No collision.
- Migration number: each child takes the next free number in `migrations/` when it builds (0024 is free today). Two children built at once both want 0024; the second rebases to the next number.
- `POST /v1/watchlists`: combine — main d5b6d96ed9bc (TCS-38, #79) matches by text only: its plan (A9) leaves the route and `src/watchlists/filter.ts` unchanged, and the diff does not touch `src/routes/watchlists.ts`. Child B adds only the `webhook_secret_enc` write to this route, so the two do not overlap; note that d5b6d96 took `migrations/0024`, so Child B and the other children start at 0025.

## Entry points
no user-facing entry point. This is a backend delivery lane (API and docs only; no app screen). The public API surface it touches is `POST/PATCH /v1/watchlists` (same request and response shape) and `docs/API.md`.

---

## Child A: flood catch-up and lag alert (item 1)

Files to touch:
- `src/queue/enqueue.ts`
- `migrations/0024_webhooks_enqueue_catchup.sql` (number per the collision note)
- `docs/API.md` (one sentence on catch-up, regenerate `site/docs.generated.ts` with `npm run gen:docs`)
- `site/docs.generated.ts` (generated)
- `docs/RETENTION.md` (settings row list: 2 new keys)
- `tests/queue/enqueue-catchup.tcs-82.test.ts` (new)

Design:
1. Migration: `UPDATE settings SET value = '1000' WHERE key = 'webhooks.enqueue_per_list' AND value = '100'` (only the unedited value); `INSERT OR IGNORE` `webhooks.enqueue_scan_rows` = `100000` and `webhooks.lag_alert_rows` = `5000`, each with a comment. Fallbacks in code name the rows.
2. Insert statement: unchanged (fresh rows, oldest first, `LIMIT perList`, aged rows `skipped`).
3. Cursor statement. The batch order changes to (1) cursor UPDATE, (2) INSERT, in one `env.DB.batch` transaction. The INSERT binds the old cursor as `since` (a parameter, not a read of `watchlists.cursor`), so the UPDATE first does not change what the INSERT scans, and the UPDATE sees the pre-insert `deliveries`.
   - `stop` = the cursor of the `perList`-th fresh matching row: `(SELECT cursor FROM advisories WHERE <filter> AND NOT EXISTS (<deliveries pk probe>) ORDER BY cursor LIMIT 1 OFFSET ?perList-1)`. It is NULL when fewer than `perList` fresh rows exist.
   - target = `MAX(cursor)` of `(SELECT cursor FROM advisories WHERE <filter> AND (stop IS NULL OR cursor <= stop) ORDER BY cursor LIMIT ?scanRows)`.
   - `UPDATE watchlists SET cursor = MAX(cursor, COALESCE(target, cursor)) WHERE id = ? AND delivery = 'webhook'` (the guard that the cursor never moves back stays).
   - Why it is exact: every matching row at or below the target either had a deliveries row before the batch or is one of the first `perList` fresh rows, which the INSERT takes. A fresh row past `stop` is never passed (D12).
   - When `stop` is NULL, the INSERT can also take a fresh row past the `scanRows` window. The cursor stops before it; the next run finds its row (NOT EXISTS) and does not queue it again. No duplicate.
4. Messages: pending rows from the insert are sent in chunks of `QUEUE_SEND_BATCH_MAX` (100). The clamp at `src/queue/enqueue.ts:105` is removed. A failed chunk counts one `send_errors` and the rows stay pending for the sweep (today's contract).
5. Lag: after the batch, one bounded count per list: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM advisories WHERE <filter above the new cursor> LIMIT ?)` with `lagAlert + 1`. If `n > lagAlert`, log the alert line and add 1 to `lagging_lists`. `lagAlert = 0` turns the check off.
6. Knob range: `scanRows < perList` is out of range: log and use `max(scanRows, perList)`.

Edge cases: a list with 0 matching rows (cursor unchanged); a full fresh page (cursor stops at the page, rest next run, test existing at `enqueue.tcs-11.test.ts:183`); a flood larger than `scanRows` (2 runs, test); a paused list (not read, unchanged); a fresh row interleaved inside the flood (inserted, and cursor passes it).

Task A1: catch-up in SQL.
VALIDATE: npm test -- tests/queue/enqueue-catchup.tcs-82.test.ts tests/queue/enqueue.tcs-11.test.ts tests/routes/deliveries.tcs-11.test.ts
SATISFIES: "Enqueue over a seeded 50,000-row flood reaches a new matching event in 1 run"; "skip rows below the list's filter in SQL (not in the loop)".

Task A2: per-run cap as a settings row `webhooks.enqueue_per_list`, default 1000, with sendBatch chunks of 100.
VALIDATE: npm test -- tests/queue/enqueue-catchup.tcs-82.test.ts -t "1000"
SATISFIES: "raise the per-run cap to a settings row (`webhooks.enqueue_per_list`, default 1000)".

Task A3: lag alert at `webhooks.lag_alert_rows` (default 5000).
VALIDATE: npm test -- tests/queue/enqueue-catchup.tcs-82.test.ts -t "lag"
SATISFIES: "alert ... when any list's lag exceeds `webhooks.lag_alert_rows` (default 5000)"; "the lag alert fires at the threshold".

Task A4: EXPLAIN QUERY PLAN proof for the new cursor statement and the lag count on 50,000 seeded rows (no bare `SCAN advisories`).
VALIDATE: npm test -- tests/queue/enqueue-catchup.tcs-82.test.ts -t "EXPLAIN"
SATISFIES: CLAUDE.md iron rule 2 for the changed queries (the ticket's flood volume).

## Child B: webhook secrets encrypted at rest (item 2)

Blocked-by: Child C (both edit `src/queue/run.ts`).

Files to touch:
- `src/lib/secret-box.ts` (new: `encryptSecret(kek, aad, plain)`, `decryptSecret(kek, aad, enc)`, `importKek(b64)`)
- `src/routes/watchlists.ts` (CREATE and PATCH writes)
- `src/queue/run.ts` (`LOAD_SQL`, decrypt in `deliverOne`)
- `src/cron/reencrypt-secrets.ts` (new: `reencryptWebhookSecrets(env)`)
- `src/cron/run.ts` (call it after the sweep, in its own try/catch)
- `src/env.ts` (`WEBHOOK_KEK?: string`)
- `.env.example` (one line, `wrangler secret put WEBHOOK_KEK`)
- `vitest.config.ts` (a test-only `WEBHOOK_KEK` binding in the `api` project, a fixed non-secret test value)
- `migrations/0025_webhook_secret_enc.sql` (number per the collision note)
- `docs/RETENTION.md` (settings row list, the column, the job)
- `docs/API.md` + `site/docs.generated.ts` (one sentence: the secret is stored encrypted and shown once)
- `tests/queue/secret-at-rest.tcs-82.test.ts` (new)
- `tests/routes/webhooks-plan.tcs-11.test.ts` (see Tests that must change)

Design:
1. Migration: `ALTER TABLE watchlists ADD COLUMN webhook_secret_enc TEXT;` `CREATE INDEX IF NOT EXISTS idx_watchlists_secret_plain ON watchlists (id) WHERE webhook_secret IS NOT NULL;` (serves the re-encrypt read), `INSERT OR IGNORE` `webhooks.reencrypt_batch` = `500`.
2. Write path: with KEK set, CREATE and PATCH bind `webhook_secret = NULL`, `webhook_secret_enc = encrypt(...)`; PATCH to poll clears both. The 201/200 body still returns the plaintext secret once. The list id must exist before encrypt (AAD); CREATE makes the id before the INSERT today, so this holds.
3. Read path: `LOAD_SQL` adds `w.webhook_secret_enc`. Enc present: decrypt (KEK unset or decrypt fails -> `finishFailed` with `last_error = 'secret_unreadable'`, 0 POSTs; this is a config error, a retry does not fix it; the log names it). Enc absent: plaintext as today.
4. Re-encrypt job: `SELECT id, webhook_secret FROM watchlists WHERE webhook_secret IS NOT NULL AND id > ? ORDER BY id LIMIT ?`; per row `UPDATE watchlists SET webhook_secret_enc = ?, webhook_secret = NULL WHERE id = ? AND webhook_secret = ? AND webhook_secret_enc IS NULL`. Rows go in one `env.DB.batch` per run. A second run finds 0 rows.
5. The plaintext column stays (additive only), NULL after the move.

Task B1: AES-GCM secret box with a per-row IV and the list id as AAD.
VALIDATE: npm test -- tests/queue/secret-at-rest.tcs-82.test.ts -t "unreadable"
SATISFIES: "encrypt `webhook_secret` with a Worker secret (`WEBHOOK_KEK`, AES-GCM via WebCrypto, per-row IV)"; "A stored secret is unreadable without the KEK".

Task B2: write the ciphertext on create and PATCH; decrypt only at sign time.
VALIDATE: npm test -- tests/queue/secret-at-rest.tcs-82.test.ts -t "signing" tests/routes/webhooks-plan.tcs-11.test.ts tests/queue/run.tcs-11.test.ts
SATISFIES: "decrypt only at sign time"; "signing still verifies".

Task B3: migration adds `webhook_secret_enc`; the re-encrypt job moves old rows and nulls the plaintext; it is idempotent.
VALIDATE: npm test -- tests/queue/secret-at-rest.tcs-82.test.ts -t "re-encrypt" tests/schema/migrations.tcs-1.test.ts
SATISFIES: "a migration adds `webhook_secret_enc` and a one-time re-encrypt job moves existing rows; the plaintext column is nulled after"; "the re-encrypt job is idempotent".

## Child C: queue consumer settings, DLQ, at-least-once doc, timeout/lease invariant (items 3 and 4)

Files to touch:
- `wrangler.toml` (consumer settings; a second `[[queues.consumers]]` for `deliveries-dlq`)
- `src/queue/run.ts` (dispatch by `batch.queue`; `runDeadLetters`; invariant in `readKnobs`/`runQueue`)
- `docs/API.md` + `site/docs.generated.ts` (at-least-once paragraph)
- `tests/queue/dlq-invariant.tcs-82.test.ts` (new)

Design:
1. wrangler.toml: `[[queues.consumers]] queue = "deliveries"`, `max_batch_size = 10`, `max_retries = 3`, `max_concurrency = 5`, `dead_letter_queue = "deliveries-dlq"`; plus `[[queues.consumers]] queue = "deliveries-dlq"`, `max_batch_size = 10`. A comment names the operator step `wrangler queues create deliveries-dlq`.
2. `runQueue`: if `batch.queue === "deliveries-dlq"`, run `runDeadLetters`: per valid message, `UPDATE deliveries SET status = 'failed', next_at = ?, last_error = 'dead_letter' WHERE watchlist_id = ? AND advisory_id = ? AND status IN ('pending', 'sending')` (primary key); a delivered row is never changed; log `{lane:"dlq", watchlist_id, advisory_id, attempts, changed}`; ack. A malformed body is logged and acked. A throw here retries the DLQ message (the DLQ has no DLQ of its own; the log line is the record).
3. Invariant: `readKnobs` checks `timeoutMs >= leaseSeconds * 1000` after the range fallbacks. On a break, `runQueue` logs `{lane:"queue", err:"invariant: webhooks.timeout_ms >= webhooks.lease_seconds * 1000, refusing the batch"}`, acks every message, makes 0 claims and 0 fetch calls.
4. Docs: "Wire delivery is at-least-once. A send that succeeds and a `delivered` write that fails can repeat once. Drop a repeat by `Tocsin-Event-Id`." Also one line that a message the consumer cannot handle after 3 tries ends as `failed` with `last_error` `dead_letter`.

Task C1: consumer settings and the DLQ in wrangler.toml.
VALIDATE: grep -n 'dead_letter_queue = "deliveries-dlq"' wrangler.toml && npm test -- tests/queue/dlq-invariant.tcs-82.test.ts -t "wrangler"
SATISFIES: "Queue consumer settings in `wrangler.toml`: `max_batch_size`, `max_retries`, `max_concurrency` and a `dead_letter_queue` (`deliveries-dlq`)".

Task C2: the DLQ handler turns a dead-lettered message into a `failed` row with the reason.
VALIDATE: npm test -- tests/queue/dlq-invariant.tcs-82.test.ts -t "dead"
SATISFIES: "a sweep that turns a dead-lettered message into a `failed` row with the reason, so a consumer throw is never silent"; "A consumer throw lands in the DLQ sweep as a `failed` row with the reason (fake queue)".

Task C3: the timeout/lease invariant.
VALIDATE: npm test -- tests/queue/dlq-invariant.tcs-82.test.ts -t "invariant"
SATISFIES: "the run refuses to start when `timeout_ms >= lease_seconds`"; "`timeout_ms = lease_seconds` is refused at startup".

Task C4: the at-least-once doc.
VALIDATE: npm test -- tests/queue/dlq-invariant.tcs-82.test.ts -t "docs" && npm run gen:docs && git diff --exit-code site/docs.generated.ts
SATISFIES: "`docs/API.md` states that wire delivery is at-least-once ... with `Tocsin-Event-Id` for receiver dedup".

## Child D: SSRF ranges, verify code, DNS cache (items 5, 7, 8)

Blocked-by: Child B (both edit `src/queue/run.ts`, `readKnobs`).

Files to touch:
- `src/watchlists/webhook-url.ts` (`blockedV6`)
- `src/queue/resolve.ts` (ttl 0 = no cache; fallback 60; comment on the residual gap)
- `src/queue/run.ts` (`readKnobs`: `dnsTtl >= 0` accepted)
- `migrations/0026_dns_cache_seconds.sql` (number per the collision note): `UPDATE settings SET value = '60' WHERE key = 'webhooks.dns_cache_seconds' AND value = '600'`
- `docs/API.md` + `site/docs.generated.ts` (the 3 ranges; the DNS cache sentence)
- `tests/queue/ssrf-ranges.tcs-82.test.ts` (new)
- `tests/docs/webhook-verify-numeric.tcs-82.test.ts` (new)

Task D1: block `::a.b.c.d`, `2002::/16` and `::ffff:0:a.b.c.d` in DNS answers.
VALIDATE: npm test -- tests/queue/ssrf-ranges.tcs-82.test.ts
SATISFIES: comment 6373816984 item 5.

Task D2: pin that the documented verify code refuses a non-numeric timestamp (code already on main, f1b4f68).
VALIDATE: npm test -- tests/docs/webhook-verify-numeric.tcs-82.test.ts
SATISFIES: comment 6373816984 item 7.

Task D3: shorter DNS cache at send time (60 s default, 0 = resolve every send).
VALIDATE: npm test -- tests/queue/ssrf-ranges.tcs-82.test.ts -t "cache" tests/queue/ssrf.tcs-11.test.ts
SATISFIES: comment 6373816984 item 8 ("re-resolve at send time with a shorter cache").

## Child E: failed rows kept for the life of the list (item 6)

Files to touch:
- `src/cron/deliveries-retention.ts` (delete `skipped` only; dry-run counts `skipped` only; audit drops `failed`)
- `docs/RETENTION.md` (the deliveries paragraph and the KV audit paragraph)
- `tests/cron/failed-kept.tcs-82.test.ts` (new)
- `tests/cron/deliveries-retention.tcs-11.test.ts`, `tests/queue/resend-after-retention.tcs-11.test.ts`, `tests/routes/deliveries.tcs-11.test.ts` (see Tests that must change)

`FAILED_RETENTION_SQL` is removed (no reader left). The `retention.deliveries_days` row stays and now governs `skipped` only; its seed comment is in 0021 (not edited), docs/RETENTION.md says so.

Task E1: the daily job keeps `failed` rows; a re-cursor of a failed advisory past 90 days takes no new row and makes 0 POSTs.
VALIDATE: npm test -- tests/cron/failed-kept.tcs-82.test.ts tests/cron/deliveries-retention.tcs-11.test.ts tests/queue/resend-after-retention.tcs-11.test.ts tests/routes/deliveries.tcs-11.test.ts
SATISFIES: comment 6373816984 item 6 ("keep them for the life of the list like delivered rows").

---

## Tests that must change
- `tests/routes/webhooks-plan.tcs-11.test.ts`: line 30 pins the plaintext secret in `watchlists.webhook_secret`; Child B stores it encrypted (`webhook_secret` NULL, `webhook_secret_enc` set).
- `tests/cron/deliveries-retention.tcs-11.test.ts`: line 42 pins that `failed` rows older than 90 days are deleted and the audit has `failed: 1`; Child E keeps them.
- `tests/queue/resend-after-retention.tcs-11.test.ts`: line 81 pins that `failed` rows past the window are deleted; Child E keeps them.
- `tests/routes/deliveries.tcs-11.test.ts`: line 184 pins an EXPLAIN of `FAILED_RETENTION_SQL`; Child E removes that statement.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section
TEST-CHANGE: <- Tests that must change
wrangler secret put WEBHOOK_KEK <- Child B operator step (A6)
wrangler queues create deliveries-dlq <- Child C operator step (C1)
```

## Verify (run, not edited)
- `npm test`
- `npm run typecheck`
- `npm run migrate:local`
- `npm run gen:docs` then `git diff --exit-code site/docs.generated.ts`
- `tests/schema/migrations.tcs-1.test.ts` (migrations stay additive)

## Iron laws, how they apply
- Additive schema (CLAUDE.md rule 1, D20): only `ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`, `INSERT OR IGNORE` and value `UPDATE`s guarded by the shipped value. No DROP. D1, not Supabase: RLS does not apply.
- Indexes and EXPLAIN (rule 2): Child A proves the cursor statement and the lag count on 50,000 seeded rows use `idx_advisories_cursor` or `idx_advisories_ecosystem_cursor`, and the NOT EXISTS uses the deliveries primary key. Child B proves the re-encrypt read uses `idx_watchlists_secret_plain`. Child C's DLQ write and Child E use primary keys or `idx_deliveries_status_next_at`.
- No per-row correlated subquery over a large table: the NOT EXISTS is a primary-key probe per scanned row, bounded by `scanRows`, same as today's insert.
- Retention: no new growing table. `watchlists.webhook_secret_enc` lives and dies with the row. `failed` rows now live with their list (Child E, documented). The DLQ queue is drained by its consumer.
- Knobs (rule 5, BH-7945): `webhooks.enqueue_per_list` (1000), `webhooks.enqueue_scan_rows` (100000), `webhooks.lag_alert_rows` (5000), `webhooks.reencrypt_batch` (500), `webhooks.dns_cache_seconds` (60). Each has a seed row and a code fallback whose comment names the row. wrangler.toml consumer values are deploy config (A9).
- Secrets (rule 9): `WEBHOOK_KEK` is a wrangler secret; `.env.example` lists it; the vitest binding is a fixed test-only value, not a production key. No secret or KEK in a log line.
- Exactly-once (rule 4): unchanged gate (primary key + claim). The DLQ write never touches a `delivered` row. The at-least-once wire note is the honest doc of the existing gap.
- Dedup before spend (rule 7): no metered call. DoH (Cloudflare, free) calls rise when the cache is shorter; the budget test in `ssrf.tcs-11.test.ts:160` stays 0 real fetch calls.
- Scalable tests (BH-7563): the queue is a binding; tests call `runQueue` with a fake `MessageBatch`. DoH goes through the injected fetch seam. 0 vendor calls. Each test seeds its own list and advisory ids.
- UI laws (sortable headers, list-over-cards, drill-down, 375 px): n/a, no screen. De-AI: n/a, no LLM text.
- Performance (BH-6946): no screen or page loader. The enqueue cron reads: 3 settings reads + KV in parallel (today 4, now 6, one `Promise.all`), then per list 1 batch (2 statements) + 1 lag count + ceil(pending/100) sendBatch calls. Expected: 3 D1 statements per list per run (today 2).

## Build discipline rules that bite
- D1/D2: each child mutation-checks its core behavior and runs one test through the production entry (`runCron` for A and B, `src/index.ts` `queue` handler for C, `runDeliveryRetention` via `worker.scheduled` for E).
- D9: the DLQ write and the invariant refusal are logged as errors, never as a success count.
- D11: `dns_cache_seconds = 0` is a valid explicit value (no cache), not a fall back to the default; a negative or non-integer value still falls back.
- D12: the cursor jump never passes a fresh row (the cursor stops at the `perList`-th fresh row); a flood over `scanRows` is drained over more runs, and the lag alert reports it.
- D20: guarded `UPDATE`s only; no DROP.
- D21: every new loop has a cap knob (`scanRows`, `reencrypt_batch`, DLQ batch size).
- D8: the two operator steps ride in the PR body.

## Failure modes
This plan changes no path under `bin/` or `worker/`. Section not required.

## System invariants
(a) Cross-run state: `deliveries` (primary key `(watchlist_id, advisory_id)`) stays the exactly-once store; `watchlists.cursor` stays the watermark; the KV key `webhooks:enqueue:after` stays a rotation hint. No config-JSON state.
(b) Side effects:
- Queue send (enqueue): the row commits before the send; a lost send leaves `pending`, the sweep re-sends. Unchanged.
- Cursor move (Child A): in the same transaction as the insert; the cursor never passes a row that has no deliveries row after the transaction.
- Webhook POST: `delivered` is written only after a 2xx. Decrypt failure (Child B) = `failed` `secret_unreadable`, 0 POSTs.
- DLQ write (Child C): `failed` only from `pending`/`sending`; never from `delivered`.
- Re-encrypt (Child B): ciphertext write and plaintext NULL in one UPDATE, guarded by the read plaintext; not configured (no KEK) = no write, one log.
- Invariant break (Child C): 0 claims, 0 POSTs, messages acked, rows `pending`.
(c) Adversarial negatives:
- Child A cursor jump must NOT pass: a fresh matching row inside the flood; the `perList+1`-th fresh row; a row of another ecosystem that is fresh for no list (it is not matching, the cursor may pass it; test pins that a later list sees it via its own cursor).
- Child D blocklist must NOT block: `2606:4700:4700::1111`, `2001:4860:4860::8888`, `::ffff:8.8.8.8`, `2003::1` (near-miss of 2002::/16), `::1:0:0:1` (not in `::/96`). Must block: `::7f00:1` / `::127.0.0.1`, `2002:7f00:1::`, `2002:0808:0808::` (whole 6to4 range), `::ffff:0:7f00:1`, `::ffff:0:8.8.8.8`.
- Child C DLQ must NOT change a `delivered` row or a `skipped` row.
(d) Neighbors:
- `*/10` cron: ingest, then enqueue, sweep, then re-encrypt (new). Each phase has its own try/catch; a throw in one never stops the next or fails the cron.
- `41 4 * * *` daily retention (Child E) and the monthly key retention: key retention still deletes `failed` rows with their list, in its transaction (unchanged).
- The poll route `GET /v1/watchlists/:id/events` moves the same `watchlists.cursor`: Child A's `MAX(cursor, ...)` guard stays, so the cursor never moves back.
- Pause (0023): paused lists are still not read by enqueue, claim or sweep; the DLQ write ignores the pause (the message is already dead).
- Children B, C and D edit `src/queue/run.ts`: order C -> B -> D (Blocked-by lines above).

## Requirements coverage
| Requirement | Task | Acceptance test |
|---|---|---|
| Item 1: skip in SQL, not the loop | A1 | enqueue-catchup.tcs-82 "50,000-row flood reaches the new event in 1 run" |
| Item 1: per-run cap row `webhooks.enqueue_per_list` default 1000 | A2 | enqueue-catchup.tcs-82 "reads 1000 from the seeded row; sends 1000 pending in 10 chunks" |
| Item 1: lag alert at `webhooks.lag_alert_rows` default 5000 | A3 | enqueue-catchup.tcs-82 "lag 5000 no alert; 5001 alert" |
| Item 2: AES-GCM, per-row IV, `WEBHOOK_KEK` | B1 | secret-at-rest.tcs-82 "unreadable without the KEK; two rows, same secret, different ciphertext" |
| Item 2: decrypt only at sign time; signing verifies | B2 | secret-at-rest.tcs-82 "signing still verifies" |
| Item 2: migration + re-encrypt job, idempotent, plaintext nulled | B3 | secret-at-rest.tcs-82 "re-encrypt moves the row, nulls plaintext; second run changes 0" |
| Item 3: consumer settings + `deliveries-dlq` | C1 | dlq-invariant.tcs-82 "wrangler.toml has the 4 settings" |
| Item 3: DLQ -> `failed` row with reason; a throw is never silent | C2 | dlq-invariant.tcs-82 "dead-lettered message -> failed, dead_letter" |
| Item 4: at-least-once doc + `Tocsin-Event-Id` | C4 | dlq-invariant.tcs-82 "docs state at-least-once" |
| Item 4: refuse when `timeout_ms >= lease_seconds` | C3 | dlq-invariant.tcs-82 "invariant: equal refused, 0 fetch" |
| Item 5: block `::a.b.c.d`, `2002::/16`, `::ffff:0:0/96` | D1 | ssrf-ranges.tcs-82 table |
| Item 6: failed rows kept for the life of the list (NEGATIVE: stop deleting failed rows) | E1 | failed-kept.tcs-82 "failed row 200 days old survives retention; re-cursor makes 0 rows, 0 POSTs" |
| Item 7: verify refuses a non-numeric timestamp | D2 | webhook-verify-numeric.tcs-82 |
| Item 8: shorter cache at send time | D3 | ssrf-ranges.tcs-82 "cache" cases |
| Out of scope: receiver SDKs | none | none |

## Acceptance tests
All in vitest (`api` project unless named), per-ticket files.
- `tests/queue/enqueue-catchup.tcs-82.test.ts`
  - seeds 1 webhook list (cursor 0), 50,000 matching advisories that already have a `delivered` row, then 1 new matching advisory above them; one `enqueueDeliveries` run: 1 new `pending` row for the new advisory, 1 queue message, list cursor = the new advisory's cursor. Fails today (cursor stops at 100).
  - `enqueue_per_list` reads 1000 from the migration row; 1000 fresh rows -> 1000 pending rows, `sendBatch` called 10 times with 100 each.
  - a flood bigger than `enqueue_scan_rows` (knob set to 1000, 2,500 rows): 3 runs to reach the new event; never passes a fresh row.
  - with `perList` = 2 and 5 fresh rows inside the flood: run 1 inserts 2 and the cursor stops at the 2nd fresh row.
  - lag: `lag_alert_rows` = 10; 10 lagging rows -> no alert line, `lagging_lists` 0; 11 -> 1 alert line with `watchlist_id` and `lag_rows`, `lagging_lists` 1; 0 = off.
  - EXPLAIN QUERY PLAN of the cursor statement and the lag count over the 50,000 seeded rows: no `SCAN advisories` without an index.
- `tests/queue/secret-at-rest.tcs-82.test.ts`
  - POST a webhook list: row has `webhook_secret` NULL, `webhook_secret_enc` starts `v1:` and does not contain the secret; decrypt with another KEK throws; decrypt with another row id as AAD throws; two lists with the same secret text give different ciphertexts.
  - deliver through `runQueue`: the receiver verifies `Tocsin-Signature` with the plaintext secret the POST returned.
  - legacy plaintext row: delivers; `reencryptWebhookSecrets` moves it (enc set, plaintext NULL); a second run changes 0 rows; delivery still verifies.
  - KEK unset (env without the binding): create keeps plaintext and logs `kek_missing`; re-encrypt changes 0 rows.
  - enc row and no KEK at send: `failed`, `last_error` `secret_unreadable`, 0 fetch calls.
  - EXPLAIN of the re-encrypt read uses `idx_watchlists_secret_plain`.
- `tests/queue/dlq-invariant.tcs-82.test.ts`
  - wrangler.toml (read as text and parsed with the `toml` lines): the `deliveries` consumer has `max_batch_size`, `max_retries`, `max_concurrency`, `dead_letter_queue = "deliveries-dlq"`; a `deliveries-dlq` consumer exists.
  - fake `MessageBatch` with `queue: "deliveries-dlq"` for a `sending` row -> row `failed`, `last_error` `dead_letter`, message acked; for a `delivered` row -> unchanged.
  - through `src/index.ts` `queue` handler (production entry) with the DLQ queue name.
  - `timeout_ms` = 60000 and `lease_seconds` = 60 -> 0 fetch calls, row stays `pending`, messages acked, one error log; 59999 -> delivers.
  - docs/API.md contains "at-least-once" and "Tocsin-Event-Id" in the Retries section.
- `tests/queue/ssrf-ranges.tcs-82.test.ts`: `isBlockedAddress` table from System invariants (c), every case asserted; a DoH answer of `2002:7f00:1::` -> `failed` `blocked_host`, 0 POSTs; `dns_cache_seconds` = 0 -> two sends make two DoH queries and no KV key; default row = 60 after migrations -> KV `expirationTtl` 60.
- `tests/docs/webhook-verify-numeric.tcs-82.test.ts` (`docs` project): the documented function returns false for `Tocsin-Timestamp` values `abc`, `NaN`, `1e9`, `-1`, `12.5`, `""` with a signature made by the real signer over that string.
- `tests/cron/failed-kept.tcs-82.test.ts`: a `failed` row 200 days old survives `runDeliveryRetention`; a `skipped` row 200 days old is deleted; audit has no `failed` field; re-cursor the failed advisory and enqueue: 0 new rows, 0 messages; DELETE of the list deletes its failed rows.

Regression risk (existing suites): `tests/queue/enqueue.tcs-11.test.ts`, `tests/queue/run.tcs-11.test.ts`, `tests/queue/ssrf.tcs-11.test.ts`, `tests/queue/health.tcs-11.test.ts`, `tests/queue/resend-after-retention.tcs-11.test.ts`, `tests/routes/deliveries.tcs-11.test.ts`, `tests/routes/webhooks-plan.tcs-11.test.ts`, `tests/routes/watchlists*.test.ts`, `tests/cron/deliveries-retention.tcs-11.test.ts`, `tests/docs/webhook-verify.tcs-11.test.ts`, `tests/schema/migrations.tcs-1.test.ts`, `tests/routes/site*.test.ts` (generated docs).

## QA screens
None. No app screen changes. `https://tocsin.sh/docs` (rendered from `site/docs.generated.ts`) shows the new at-least-once and IPv6 sentences: load it and read the Webhooks section.

## Sibling claims (not touched)
/root/harness/state/claims/tocsin/ is empty: no live sibling build.

## Design collision check (BH-5791)

Checked 13 listed and 0 derived symbols against main f1b4f68a4cf0..d5b6d96ed9bc and 1 open PRs.
- `POST /v1/watchlists` (function, listed): main d5b6d96ed9bc, (text match). Resolution: combine.

## Size
FILES: 13
LINES: 620
DIFF_KB: 95

KIND: feature
SIZE: XL
